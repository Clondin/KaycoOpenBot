import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useComputerActivity } from "@/lib/copilot/computer-activity";
import { LiveScreen } from "./live-screen";
import { ComputerPlaceholder } from "./placeholder";
import {
  type ControlState,
  readControl,
  releaseControl,
  supplySecret,
  takeControl,
  uploadHumanFile,
} from "./take-the-wheel";

type Props = {
  computerId: string;
  active?: boolean;
  aspectRatio?: number;
  minWidth?: number;
  minHeight?: number;
};

export function ComputerView({
  computerId,
  active = true,
  aspectRatio = 1280 / 800,
  minWidth = 320,
  minHeight = 200,
}: Props) {
  const [hasFrame, setHasFrame] = useState(false);
  const [page, setPage] = useState<{ url: string; title?: string } | null>(
    null,
  );
  const [problem, setProblem] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [control, setControl] = useState<ControlState | null>(null);
  const [secret, setSecret] = useState("");
  const [secretProblem, setSecretProblem] = useState<string | null>(null);
  const [sendingSecret, setSendingSecret] = useState(false);
  const [takingControl, setTakingControl] = useState(false);
  const [releasingControl, setReleasingControl] = useState(false);
  const [controlProblem, setControlProblem] = useState<string | null>(null);
  const [uploadingFile, setUploadingFile] = useState(false);
  const [fileProblem, setFileProblem] = useState<string | null>(null);
  const activity = useComputerActivity(computerId);
  const driving = control?.holder === "human";
  const blankBrowser = page?.url === "about:blank" || page?.url === "";
  const showScreen = hasFrame && !blankBrowser;

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/computers/${encodeURIComponent(computerId)}/warm`, {
      method: "POST",
      credentials: "include",
      signal: controller.signal,
    }).catch(() => undefined);
    void readControl(computerId).then((state) => {
      if (state) setControl(state);
    });
    return () => controller.abort();
  }, [computerId]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [expanded]);

  const handBack = async () => {
    if (releasingControl) return false;
    setReleasingControl(true);
    setControlProblem(null);
    try {
      const state = await releaseControl(computerId);
      if (!state) {
        setControlProblem("The browser could not be handed back. Try again.");
        return false;
      }
      setControl(state);
      return true;
    } catch {
      setControlProblem("The browser could not be handed back. Try again.");
      return false;
    } finally {
      setReleasingControl(false);
    }
  };

  const startDriving = async () => {
    if (takingControl) return;
    setTakingControl(true);
    setControlProblem(null);
    try {
      const state = await takeControl(computerId);
      if (!state) {
        setControlProblem("Control could not be transferred. Try again.");
        return;
      }
      setControl(state);
      setExpanded(true);
    } catch {
      setControlProblem("Control could not be transferred. Try again.");
    } finally {
      setTakingControl(false);
    }
  };

  const sendFile = async (file: File) => {
    setUploadingFile(true);
    const result = await uploadHumanFile(computerId, file);
    setUploadingFile(false);
    setFileProblem(result.ok ? null : (result.error ?? null));
  };

  const screen = (
    <LiveScreen
      computerId={computerId}
      driving={driving}
      onControl={setControl}
      onFrame={() => setHasFrame(true)}
      onPage={setPage}
      onProblem={setProblem}
    />
  );

  return (
    <>
      <figure className="overflow-hidden rounded-2xl border">
        {activity ? (
          <figcaption
            className="flex items-center gap-2 border-b bg-muted/30 px-3 py-2 text-xs"
            aria-live="polite"
          >
            <span
              className={`size-2 shrink-0 rounded-full ${
                activity.stage === "error"
                  ? "bg-destructive"
                  : activity.stage === "complete"
                    ? "bg-emerald-500"
                    : "animate-pulse bg-sky-500"
              }`}
            />
            <span className="min-w-0 flex-1 truncate">{activity.label}</span>
            {activity.elapsedMs !== undefined ? (
              <span className="shrink-0 text-muted-foreground">
                {(activity.elapsedMs / 1000).toFixed(1)}s
              </span>
            ) : null}
          </figcaption>
        ) : null}

        <div
          className="relative w-full bg-muted"
          style={{ aspectRatio, minWidth, minHeight }}
        >
          {!expanded ? screen : null}
          {blankBrowser ? (
            <ComputerPlaceholder className="absolute inset-0 h-full w-full" />
          ) : null}
          {!showScreen ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 p-4 text-center text-sm text-muted-foreground">
              <span className="font-medium">
                {problem
                  ? "The screen is reconnecting"
                  : "Starting the screen…"}
              </span>
              {problem ? <span>{problem}</span> : null}
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="absolute inset-0 cursor-zoom-in"
              aria-label="Open the assistant's screen full size"
            />
          )}
        </div>

        {page && !blankBrowser ? (
          <div className="truncate border-t bg-muted/30 px-3 py-1.5 text-xs text-muted-foreground">
            <span className="font-medium text-foreground">
              {page.title || "Current page"}
            </span>{" "}
            <span title={page.url}>{page.url}</span>
          </div>
        ) : null}

        {control?.secretWanted ? (
          <form
            className="border-t bg-muted/40 px-3 py-2 text-sm"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!secret || sendingSecret) return;
              setSendingSecret(true);
              const result = await supplySecret(computerId, secret);
              setSendingSecret(false);
              setSecret("");
              setSecretProblem(result.ok ? null : (result.error ?? null));
              const state = await readControl(computerId);
              if (state) setControl(state);
            }}
          >
            <label className="block" htmlFor={`openbot-secret-${computerId}`}>
              <span className="font-medium">The assistant needs </span>
              <span>{control.secretWanted}</span>
            </label>
            <div className="mt-1.5 flex gap-2">
              <input
                id={`openbot-secret-${computerId}`}
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
                placeholder="Typed here, never shown to the assistant"
                className="min-w-0 flex-1 rounded-md border bg-background px-2 py-1 text-sm"
              />
              <button
                type="submit"
                disabled={!secret || sendingSecret}
                className="shrink-0 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground disabled:opacity-50"
              >
                {sendingSecret ? "Sending…" : "Send to the page"}
              </button>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              This goes straight to the page, not into the conversation.
            </p>
            {secretProblem ? (
              <p className="mt-1 text-xs text-destructive">{secretProblem}</p>
            ) : null}
          </form>
        ) : null}

        <div className="flex items-center justify-between gap-3 border-t bg-muted/30 px-3 py-2 text-sm">
          <span className="text-muted-foreground">
            {driving
              ? "You’re driving. The Bot is paused."
              : control?.requested
                ? control.reason || "The assistant needs your help."
                : "Watch live or pause the Bot and drive."}
          </span>
          {driving ? (
            <span className="flex shrink-0 items-center gap-2">
              <label className="cursor-pointer rounded-md border px-3 py-1 text-xs font-medium">
                {uploadingFile ? "Uploading…" : "Upload file"}
                <input
                  type="file"
                  className="sr-only"
                  disabled={uploadingFile}
                  onChange={async (event) => {
                    const file = event.target.files?.[0];
                    event.target.value = "";
                    if (!file) return;
                    await sendFile(file);
                  }}
                />
              </label>
              <button
                type="button"
                disabled={releasingControl}
                onClick={() => void handBack()}
                className="rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground"
              >
                {releasingControl ? "Handing back…" : "Resume Bot"}
              </button>
            </span>
          ) : (
            <button
              type="button"
              disabled={takingControl}
              onClick={() => void startDriving()}
              className="shrink-0 rounded-md border px-3 py-1 text-xs font-medium disabled:opacity-50"
            >
              {takingControl ? "Taking control…" : "Take control"}
            </button>
          )}
        </div>
        {controlProblem ? (
          <p
            className="border-t px-3 py-2 text-xs text-destructive"
            role="alert"
          >
            {controlProblem}
          </p>
        ) : null}
        {fileProblem ? (
          <p
            className="border-t px-3 py-2 text-xs text-destructive"
            role="alert"
          >
            {fileProblem}
          </p>
        ) : null}
      </figure>

      {expanded && typeof document !== "undefined"
        ? createPortal(
            <div
              role="dialog"
              aria-modal="true"
              aria-label="The assistant's screen"
              className="fixed inset-0 z-50 flex flex-col p-4 sm:p-8"
            >
              <button
                type="button"
                onClick={() => !driving && setExpanded(false)}
                aria-label="Close the assistant's screen"
                aria-hidden={driving}
                tabIndex={driving ? -1 : 0}
                className={`absolute inset-0 bg-black/80 ${driving ? "cursor-default" : "cursor-zoom-out"}`}
              />
              <div className="relative mb-3 flex items-center justify-between gap-4 text-sm text-white">
                <span className="min-w-0 truncate">
                  {driving
                    ? "You’re driving. Focus the screen, then type or paste. The Bot is paused."
                    : `${page?.title || "The assistant's screen"}${active ? ", live" : ""}`}
                </span>
                <span className="flex shrink-0 items-center gap-3">
                  {driving ? (
                    <>
                      <label className="cursor-pointer rounded-md border border-white/50 px-3 py-1 text-xs font-medium">
                        {uploadingFile ? "Uploading…" : "Upload file"}
                        <input
                          type="file"
                          className="sr-only"
                          disabled={uploadingFile}
                          onChange={async (event) => {
                            const file = event.target.files?.[0];
                            event.target.value = "";
                            if (file) await sendFile(file);
                          }}
                        />
                      </label>
                      <button
                        type="button"
                        disabled={releasingControl}
                        onClick={() =>
                          void handBack().then(
                            (released) => released && setExpanded(false),
                          )
                        }
                        className="rounded-md bg-white px-3 py-1 text-xs font-medium text-black"
                      >
                        {releasingControl ? "Handing back…" : "Resume Bot"}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      disabled={takingControl}
                      onClick={() => void startDriving()}
                      className="rounded-md bg-white px-3 py-1 text-xs font-medium text-black"
                    >
                      {takingControl ? "Taking control…" : "Take control"}
                    </button>
                  )}
                  <span className="text-white/70">Press Escape to close</span>
                </span>
              </div>
              <div className="relative min-h-0 flex-1 overflow-auto rounded-lg bg-black">
                {screen}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
