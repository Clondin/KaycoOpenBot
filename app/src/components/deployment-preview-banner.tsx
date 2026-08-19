import { deploymentPreviewEnabled } from "@/lib/deployment-preview";

export function DeploymentPreviewBanner() {
  if (!deploymentPreviewEnabled) return null;

  return (
    <div className="flex min-h-9 items-center justify-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2 text-center text-xs text-amber-950 dark:text-amber-100">
      <span className="rounded-full bg-amber-500/20 px-2 py-0.5 font-semibold uppercase tracking-wide">
        UI preview
      </span>
      <span>
        Sample data is shown. Chat, automation, and administration will connect
        when the Hetzner backend is ready.
      </span>
    </div>
  );
}
