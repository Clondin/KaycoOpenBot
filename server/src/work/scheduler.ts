import type { RoutineStore } from "./routines";

/**
 * Small durable scheduler loop.
 *
 * Durability is in the database: due rows are locked and advanced before dispatch, and each
 * occurrence has a unique reservation. Restarting this timer cannot duplicate a scheduled run.
 */
export function startRoutineScheduler(
  routines: Pick<RoutineStore, "dispatchDue">,
  intervalMs = 30_000,
) {
  let stopped = false;
  let running = false;

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      const dispatched = await routines.dispatchDue();
      if (dispatched > 0) {
        console.info(JSON.stringify({ type: "routine-dispatch", dispatched }));
      }
    } catch (error) {
      console.error(
        JSON.stringify({
          type: "routine-scheduler-error",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => void tick(), Math.max(intervalMs, 5_000));
  timer.unref?.();
  void tick();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
