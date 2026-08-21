import type { Message } from "@ag-ui/core";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { ChannelAvatar } from "@/components/channels/avatar";
import {
  addRecipient,
  canSend,
  MAX_RECIPIENTS,
  removeRecipient,
  type Recipient,
} from "@/components/channels/compose-state";
import { ConversationView } from "@/components/channels/conversation-view";
import { firstMessageContent } from "@/components/channels/transcript-messages";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import {
  type AgentProfile,
  agentListQueryOptions,
  agentQueryOptions,
} from "@/lib/agents/queries";
import { useStartChannel } from "@/lib/channels/start";
import { useSkillCommands } from "@/lib/plugins/skill-commands";

/**
 * Creates the channel on first send. The selected coworker stays in the URL so profile links and
 * reloads preserve the pending recipient without creating an empty channel.
 */
export const Route = createFileRoute("/_authed/_app/channel/new")({
  validateSearch: (
    search: Record<string, unknown>,
  ): { agent?: string; agents?: string } => ({
    ...(typeof search.agent === "string" ? { agent: search.agent } : {}),
    ...(typeof search.agents === "string" ? { agents: search.agents } : {}),
  }),
  component: RouteComponent,
});

function RouteComponent() {
  const { agent, agents } = Route.useSearch();
  const navigate = Route.useNavigate();
  const { start, pending } = useStartChannel();
  const { data: profiles } = useQuery(agentListQueryOptions());

  const [error, setError] = useState<string | null>(null);
  // Optimistic seed shown before the first channel record exists.
  const [sent, setSent] = useState<Message | null>(null);

  // Stale or private `?agent=` values are ignored because the roster is permission-filtered.
  const listed = profiles?.find((profile) => profile.id === agent);
  /**
   * Hidden coworkers are omitted from the roster but may still be valid recipients from a profile
   * link, so fetch the URL-selected coworker when it is absent from the visible list.
   */
  const { data: fetched } = useQuery({
    ...agentQueryOptions(agent ?? ""),
    enabled: Boolean(agent) && !listed,
    retry: false,
  });
  const chosen = listed ?? (fetched?.id === agent ? fetched : undefined);
  const selectedIds = [
    ...(agent ? [agent] : []),
    ...(agents?.split(",").filter(Boolean) ?? []),
  ].filter((id, index, all) => all.indexOf(id) === index);
  const recipients: Recipient[] = selectedIds
    .map((id) => {
      const profile = profiles?.find((candidate) => candidate.id === id);
      return profile ? { id: profile.id, name: profile.name } : null;
    })
    .filter((recipient): recipient is Recipient => Boolean(recipient));
  if (chosen && !recipients.some((recipient) => recipient.id === chosen.id)) {
    recipients.unshift({ id: chosen.id, name: chosen.name });
  }
  const skillCommands = useSkillCommands(recipients[0]?.id ?? "");
  const setRecipients = (next: Recipient[]) =>
    navigate({
      replace: true,
      search: next.length
        ? { agents: next.map((item) => item.id).join(",") }
        : {},
    });

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-12 border-b border-border sticky top-0 flex flex-row px-2 items-center">
        <span className="shrink-0 text-sm text-muted-foreground">To:</span>
        <div className="flex min-w-0 flex-wrap gap-1.5 px-2">
          {recipients.map((recipient, index) => (
            <button
              aria-label={`Remove ${recipient.name}`}
              className="rounded-full bg-muted px-2 py-1 text-xs"
              key={recipient.id}
              onClick={() =>
                void setRecipients(removeRecipient(recipients, recipient.id))
              }
              type="button"
            >
              {index === 0 ? "Active: " : ""}
              {recipient.name} ×
            </button>
          ))}
        </div>
        <Combobox
          // Do not auto-open when the recipient came from the URL; the field is already answered.
          defaultOpen={!agent}
          autoHighlight
          items={profiles ?? []}
          isItemEqualToValue={(item: AgentProfile, value: AgentProfile) =>
            item.id === value.id
          }
          itemToStringLabel={(item: AgentProfile) => item.name}
          itemToStringValue={(item: AgentProfile) => item.id}
          onValueChange={(next) => {
            if (!next) return;
            void setRecipients(
              addRecipient(recipients, { id: next.id, name: next.name }),
            );
          }}
          value={null}
        >
          <ComboboxInput
            placeholder={
              recipients.length >= MAX_RECIPIENTS
                ? "Workroom is full"
                : recipients.length
                  ? "Add a coworker…"
                  : "Choose a coworker…"
            }
            // InputGroup owns focus rings via `has-[…:focus-visible]`; disable that wrapper ring here.
            className="border-none w-full bg-transparent! text-sm has-[[data-slot=input-group-control]:focus-visible]:ring-0"
          />
          {/* Allow max-w to constrain the popup even though its anchor is full-width. */}
          <ComboboxContent className="min-w-0 max-w-lg" sideOffset={12}>
            <ComboboxEmpty>No agents found.</ComboboxEmpty>
            <ComboboxList>
              {(item: AgentProfile) => (
                <ComboboxItem key={item.id} value={item} className="h-10">
                  <ChannelAvatar participantIds={[item.id]} size={24} />
                  {item.name}
                  <span className="truncate text-muted-foreground ml-1">
                    {item.title}
                  </span>
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      </div>
      <ConversationView
        // Commands must be loaded before the first channel message is sent.
        commands={skillCommands}
        disabled={recipients.length === 0}
        messages={sent ? [sent] : []}
        notice={
          error ? (
            <p className="pb-2 text-sm text-destructive" role="alert">
              {error}
            </p>
          ) : null
        }
        onSubmit={async (draft) => {
          const attachments = draft.attachments ?? [];
          // A message that is only a file is still a first message.
          if (
            recipients.length === 0 ||
            (!canSend(recipients, draft.text) && attachments.length === 0)
          ) {
            return;
          }

          setError(null);
          setSent({
            content: firstMessageContent({ text: draft.text, attachments }),
            id: crypto.randomUUID(),
            role: "user",
          });

          try {
            await start(
              recipients.map((recipient) => recipient.id),
              draft.text,
              attachments,
            );
          } catch (caught) {
            // Preserve the unsent draft when channel creation fails.
            setSent(null);
            setError(
              caught instanceof Error
                ? caught.message
                : "Could not start the conversation.",
            );
            throw caught;
          }
        }}
        pending={pending}
      />
    </div>
  );
}
