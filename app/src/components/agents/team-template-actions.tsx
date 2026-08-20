import { IconDownload, IconUpload } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { agentKeys, type AgentProfile } from "@/lib/agents/queries";

const MAX_TEMPLATE_BYTES = 256 * 1024;

async function responseError(response: Response, fallback: string) {
  return response
    .json()
    .then((body: { error?: string }) => body.error ?? fallback)
    .catch(() => fallback);
}

export function TeamTemplateActions({
  agents,
}: {
  agents: readonly AgentProfile[];
}) {
  const queryClient = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [teamName, setTeamName] = useState("My Kayco team");
  const [pending, setPending] = useState<"export" | "import" | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  const exportTeam = async () => {
    if (!teamName.trim() || pending) return;
    setPending("export");
    setProblem(null);
    try {
      const response = await fetch("/api/agents/team-template/export", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: teamName.trim(),
          agentIds: agents.map((agent) => agent.id),
        }),
      });
      if (!response.ok)
        throw new Error(
          await responseError(response, "The team could not be exported."),
        );
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const filename =
        /filename="([^"]+)"/.exec(disposition)?.[1] ?? "kayco-team.json";
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
      setExportOpen(false);
      setStatus(
        `Exported ${agents.length} coworker${agents.length === 1 ? "" : "s"}.`,
      );
    } catch (error) {
      setProblem(
        error instanceof Error
          ? error.message
          : "The team could not be exported.",
      );
    } finally {
      setPending(null);
    }
  };

  const importTeam = async (file: File) => {
    setPending("import");
    setProblem(null);
    setStatus(null);
    try {
      if (file.size > MAX_TEMPLATE_BYTES) {
        throw new Error("Team templates must be smaller than 256 KB.");
      }
      const template = JSON.parse(await file.text()) as unknown;
      const response = await fetch("/api/agents/team-template/import", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(template),
      });
      if (!response.ok)
        throw new Error(
          await responseError(response, "The team could not be imported."),
        );
      const body = (await response.json()) as { agents: AgentProfile[] };
      await queryClient.invalidateQueries({ queryKey: agentKeys.all });
      setStatus(
        `Imported ${body.agents.length} private coworker${body.agents.length === 1 ? "" : "s"}. Credentials and permissions were not imported.`,
      );
    } catch (error) {
      setProblem(
        error instanceof SyntaxError
          ? "That file is not valid JSON."
          : error instanceof Error
            ? error.message
            : "The team could not be imported.",
      );
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      <input
        accept="application/json,.json"
        className="sr-only"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void importTeam(file);
        }}
        ref={fileRef}
        type="file"
      />
      <Button
        disabled={pending !== null}
        onClick={() => fileRef.current?.click()}
        size="sm"
        variant="ghost"
      >
        <IconUpload />
        {pending === "import" ? "Importing…" : "Import team"}
      </Button>
      <Button
        disabled={agents.length === 0 || pending !== null}
        onClick={() => setExportOpen(true)}
        size="sm"
        variant="ghost"
      >
        <IconDownload />
        Export team
      </Button>
      {status ? (
        <span
          className="basis-full text-right text-xs text-muted-foreground"
          role="status"
        >
          {status}
        </span>
      ) : null}
      {problem ? (
        <span
          className="basis-full text-right text-xs text-destructive"
          role="alert"
        >
          {problem}
        </span>
      ) : null}

      <Dialog onOpenChange={setExportOpen} open={exportOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Export your team</DialogTitle>
            <DialogDescription>
              The file includes names, titles, and role descriptions only. It
              never includes credentials, endpoints, grants, messages, or ids.
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Team name"
            maxLength={120}
            onChange={(event) => setTeamName(event.target.value)}
            value={teamName}
          />
          <DialogFooter>
            <Button onClick={() => setExportOpen(false)} variant="outline">
              Cancel
            </Button>
            <Button
              disabled={!teamName.trim() || pending !== null}
              onClick={() => void exportTeam()}
            >
              {pending === "export" ? "Exporting…" : "Download template"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
