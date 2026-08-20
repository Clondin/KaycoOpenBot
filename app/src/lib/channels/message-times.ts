import { useEffect, useRef, useState } from "react";

/**
 * When each message was first seen by this browser, because the wire does not say.
 *
 * AG-UI messages carry no timestamp: `BaseMessageSchema` is id, role, content, name. The durable
 * thread store is upstream of this deployment, so there is nothing to fetch a time from either.
 * What CAN be known honestly is when a message first appeared in front of this person, and that is
 * what this records — stamped on arrival, kept in localStorage per thread so a reload keeps them.
 *
 * The limits of that honesty are part of the contract. History restored on another machine, or
 * after the store was cleared, has no times, and the transcript must render nothing rather than
 * invent one: a wrong "14:02" under a week-old message is worse than silence. Day separators and
 * footer times therefore only appear where a stamp exists.
 */

const PREFIX = "kayco-openbot:message-times:v1:";
/** Per thread. At ~45 bytes an entry this caps a thread's stamps around 27 KB. */
const MAX_ENTRIES = 600;

type StoredTimes = Record<string, number>;

function readTimes(threadId: string): StoredTimes {
  if (typeof window === "undefined") return {};
  try {
    const stored = window.localStorage.getItem(`${PREFIX}${threadId}`);
    const parsed: unknown = stored ? JSON.parse(stored) : null;
    if (typeof parsed !== "object" || parsed === null) return {};
    const times: StoredTimes = {};
    for (const [id, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value)) {
        times[id] = value;
      }
    }
    return times;
  } catch {
    return {};
  }
}

function writeTimes(threadId: string, times: StoredTimes) {
  if (typeof window === "undefined") return;
  try {
    let entries = Object.entries(times);
    if (entries.length > MAX_ENTRIES) {
      // The oldest stamps go first; they belong to messages scrolled furthest away.
      entries = entries
        .sort((a, b) => a[1] - b[1])
        .slice(entries.length - MAX_ENTRIES);
    }
    window.localStorage.setItem(
      `${PREFIX}${threadId}`,
      JSON.stringify(Object.fromEntries(entries)),
    );
  } catch {
    // A full or blocked store loses timestamps, not messages.
  }
}

/**
 * Track first-seen times for a thread's message ids.
 *
 * `live` guards the one way this could lie: history restore. Ids that appear while `live` is false
 * are remembered as never-stampable, so a week of restored messages arriving in one setMessages
 * does not get today's date written under it. Only messages that appear after the caller says the
 * conversation is live are stamped — and a stamp from a previous session, read back from storage,
 * always wins over re-stamping.
 *
 * The returned object is replaced only when a new id is stamped, so a streaming answer — same ids,
 * growing text — does not re-render every row for a map that has not changed.
 */
export function useMessageTimes(
  threadId: string,
  messageIds: readonly string[],
  live: boolean,
): Readonly<Record<string, number>> {
  const [times, setTimes] = useState<StoredTimes>(() => readTimes(threadId));
  const timesRef = useRef(times);
  timesRef.current = times;
  const unstampable = useRef(new Set<string>());

  /*
   * Depends on a joined string rather than the array: the messages array is rebuilt per stream
   * chunk, and this effect only has work to do when an id it has not seen appears.
   */
  const idsKey = messageIds.join("\n");
  useEffect(() => {
    const ids = idsKey ? idsKey.split("\n") : [];
    if (!live) {
      for (const id of ids) {
        if (!(id in timesRef.current)) unstampable.current.add(id);
      }
      return;
    }
    const now = Date.now();
    let added = false;
    const next: StoredTimes = { ...timesRef.current };
    for (const id of ids) {
      if (!(id in next) && !unstampable.current.has(id)) {
        next[id] = now;
        added = true;
      }
    }
    if (!added) return;
    writeTimes(threadId, next);
    setTimes(next);
  }, [idsKey, live, threadId]);

  return times;
}
