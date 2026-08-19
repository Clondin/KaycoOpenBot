import type { ComputerState } from "./docker";

/**
 * Whether another computer may be started on this host.
 *
 * Re-ensuring a computer that is already running is always allowed. Stopped containers keep their
 * profiles but consume no running slot, so a single-user test host can retain several Bots while
 * allowing only one browser computer to run at a time.
 */
export function hasComputerCapacity(
  botId: string,
  computers: readonly Pick<ComputerState, "botId" | "status">[],
  maxRunning: number,
): boolean {
  if (
    computers.some(
      (computer) => computer.botId === botId && computer.status === "running",
    )
  ) {
    return true;
  }

  return (
    computers.filter((computer) => computer.status === "running").length <
    maxRunning
  );
}
