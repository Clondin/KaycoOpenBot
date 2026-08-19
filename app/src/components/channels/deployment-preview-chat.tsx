import type { AgentChannel } from "@/lib/channels/queries";

type PreviewMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
};

const previewTranscripts: Record<string, PreviewMessage[]> = {
  "preview-policy-review": [
    {
      id: "policy-question",
      role: "user",
      text: "What is the approval path for a new external software vendor?",
    },
    {
      id: "policy-answer",
      role: "assistant",
      text: "I found the relevant policy. Start with the business owner and Security review, then route contracts through Legal and Procurement. Finance approval is also required when the annual commitment exceeds the team threshold.",
    },
  ],
  "preview-weekly-brief": [
    {
      id: "brief-question",
      role: "user",
      text: "Turn this week's project notes into a concise leadership update.",
    },
    {
      id: "brief-answer",
      role: "assistant",
      text: "Your draft is ready for review. It leads with decisions made, separates current risks from open questions, and closes with the three actions needed next week.",
    },
  ],
};

/** A read-only conversation that shows the channel design without starting a CopilotKit runtime. */
export function DeploymentPreviewChat({ channel }: { channel: AgentChannel }) {
  const messages = previewTranscripts[channel.id] ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        aria-label={`${channel.name} preview conversation`}
        className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-end gap-5 overflow-y-auto px-4 py-8"
        role="log"
      >
        {messages.map((message) => (
          <div
            className={
              message.role === "user"
                ? "ml-auto max-w-[80%] rounded-2xl bg-muted px-4 py-3 text-sm"
                : "mr-auto max-w-[80%] px-1 py-1 text-sm leading-6"
            }
            key={message.id}
          >
            {message.text}
          </div>
        ))}
      </div>
      <div className="mx-auto w-full max-w-2xl shrink-0 px-4 pb-4">
        <p className="pb-2 text-sm text-muted-foreground" role="status">
          This sample conversation is read-only until the backend is connected.
        </p>
        <div className="flex min-h-24 items-end rounded-2xl border border-input bg-background p-3 text-sm text-muted-foreground shadow-xs">
          <span className="flex-1 self-start">Ask anything</span>
          <span
            aria-hidden="true"
            className="flex size-8 items-center justify-center rounded-full bg-muted text-foreground/50"
          >
            ↑
          </span>
        </div>
      </div>
    </div>
  );
}
