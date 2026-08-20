import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
} from "react";

/**
 * Durable work context for frontend tools.
 *
 * Tools are registered once at the app root, while a run lives inside a channel. Handlers read this
 * holder at call time so every governed request can be tied to the run that caused it.
 */
export type ActiveRun = { runId?: string; channelId?: string };
type ActiveRunHolder = { current: ActiveRun };

const ActiveRunContext = createContext<ActiveRunHolder | null>(null);
const EMPTY_ACTIVE_RUN_HOLDER: ActiveRunHolder = { current: {} };

export function ActiveRunProvider({ children }: { children: ReactNode }) {
  const holder = useRef<ActiveRunHolder>({ current: {} });
  return (
    <ActiveRunContext.Provider value={holder.current}>
      {children}
    </ActiveRunContext.Provider>
  );
}

export function useActiveRun(run: ActiveRun): void {
  const holder = useContext(ActiveRunContext);
  useEffect(() => {
    if (!holder) return;
    const previous = holder.current;
    holder.current = {
      ...(run.runId ? { runId: run.runId } : {}),
      ...(run.channelId ? { channelId: run.channelId } : {}),
    };
    return () => {
      holder.current = previous;
    };
  }, [holder, run.runId, run.channelId]);
}

export function useActiveRunHolder(): ActiveRunHolder {
  return useContext(ActiveRunContext) ?? EMPTY_ACTIVE_RUN_HOLDER;
}
