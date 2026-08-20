import { CopilotKitProvider } from "@copilotkit/react-core/v2";
import type { ReactNode } from "react";
import { apiUrl } from "../api-origin";
import { deploymentPreviewEnabled } from "../deployment-preview";
import { ActiveBotProvider } from "./active-bot";
import { ActiveRunProvider } from "./active-run";
import { ComputerTools } from "./computer-tools";
import { GalleryTools } from "./gallery-tools";
import { SandboxedTools } from "./sandboxed-tools";
import { WorkTools } from "./work-tools";

/**
 * The CopilotKit client, wrapped once for the whole authenticated app.
 *
 * `credentials: "include"` is the load-bearing part. OpenBot authenticates with a Better Auth
 * session cookie, and the runtime endpoint sits behind the same guard as every other API route, so
 * without it every run is rejected as anonymous while the rest of the app looks signed in.
 *
 * The URL is relative, like every other call in the app, so the Vite dev proxy and a single-origin
 * deployment both work without a build-time base URL to get wrong.
 *
 * There is no `publicApiKey`. The Intelligence key and licence token are deployment secrets held by
 * the server; a browser never sees them (see server/src/app.ts, where /api/capabilities projects the
 * runtime rather than returning it).
 */
export function CopilotProvider({ children }: { children: ReactNode }) {
  // The hosted design preview is deliberately disconnected from the runtime. Keeping the real
  // provider out of that build also keeps it from probing an API that does not exist yet.
  if (deploymentPreviewEnabled) return children;

  return (
    <CopilotKitProvider
      runtimeUrl={apiUrl("/api/copilotkit")}
      credentials="include"
    >
      {/* Computer tools target the Bot declared by the mounted surface. */}
      <ActiveBotProvider>
        <ActiveRunProvider>
          <ComputerTools />
          {/* Gallery tools are registered once; their handlers re-read the active Bot to avoid shadowing renderers. */}
          <GalleryTools />
          {/* Browser-authored components use the same component grants as the compiled gallery. */}
          <SandboxedTools />
          {/* Durable handoffs, project artifacts, and inspectable memory. */}
          <WorkTools />
          {children}
        </ActiveRunProvider>
      </ActiveBotProvider>
    </CopilotKitProvider>
  );
}
