import { text, type Segment } from "prompt-area/helpers";

const PREFIX = "kayco-openbot:composer-draft:v1:";

export function readStoredDraft(key: string | undefined): Segment[] {
  if (!key || typeof window === "undefined") return [];
  try {
    const stored = window.localStorage.getItem(`${PREFIX}${key}`);
    return stored ? [text(stored)] : [];
  } catch {
    return [];
  }
}

export function writeStoredDraft(key: string | undefined, value: string) {
  if (!key || typeof window === "undefined") return;
  try {
    const storageKey = `${PREFIX}${key}`;
    if (value.trim()) window.localStorage.setItem(storageKey, value);
    else window.localStorage.removeItem(storageKey);
  } catch {
    // A blocked or full browser store must not break typing or sending.
  }
}

export function clearStoredDraft(key: string | undefined) {
  writeStoredDraft(key, "");
}
