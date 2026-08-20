import { IconBrandGoogleDrive, IconCloud } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StaggerItem } from "@/components/layout/stagger";
import { Button } from "@/components/ui/button";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import {
  connectorKeys,
  connectorListQueryOptions,
} from "@/lib/connectors/queries";

export const Route = createFileRoute("/_authed/admin/connectors")({
  component: ConnectorsPage,
});

function ConnectorsPage() {
  const queryClient = useQueryClient();
  const connectors = useQuery(connectorListQueryOptions());
  const sync = useMutation({
    mutationFn: async (type: "google_drive" | "onedrive") => {
      const response = await fetch(`/api/admin/connectors/${type}/sync`, {
        method: "POST",
        credentials: "include",
      });
      if (!response.ok) throw new Error("Could not queue connector sync");
    },
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: connectorKeys.all }),
  });
  return (
    <PageShell
      description="Available integrations are defined by this deployment’s knowledge sources."
      title="Connectors"
    >
      <PageSection title="Available">
        {connectors.isPending ? (
          <PageEmpty>Loading connectors…</PageEmpty>
        ) : connectors.error ? (
          <p className="mt-4 text-destructive text-sm" role="alert">
            Could not load connectors.
          </p>
        ) : connectors.data?.length === 0 ? (
          <PageEmpty>
            No connectors. They come from this deployment's knowledge sources.
          </PageEmpty>
        ) : (
          <PageRows>
            {connectors.data?.map((connector, index) => (
              <StaggerItem index={index} key={connector.id}>
                <Item size="sm">
                  <ItemMedia variant="icon">
                    {connector.type === "google_drive" ? (
                      <IconBrandGoogleDrive />
                    ) : (
                      <IconCloud />
                    )}
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>{connector.name}</ItemTitle>
                    <ItemDescription>
                      Roots: {connector.roots.join(", ")} ·{" "}
                      {connector.configured
                        ? syncSummary(connector)
                        : "Not configured"}
                    </ItemDescription>
                    {connector.lastError ? (
                      <p className="mt-1 line-clamp-2 text-destructive text-xs">
                        {connector.lastError}
                      </p>
                    ) : null}
                  </ItemContent>
                  <ItemActions>
                    {connector.configured ? (
                      <Button
                        disabled={
                          sync.isPending || connector.status === "running"
                        }
                        onClick={() => sync.mutate(connector.type)}
                        size="sm"
                        variant="ghost"
                      >
                        {connector.status === "running"
                          ? "Syncing…"
                          : "Sync now"}
                      </Button>
                    ) : null}
                    {connector.type === "google_drive" ? (
                      <Button
                        render={<Link to="/admin/connectors/google-drive" />}
                        size="sm"
                        variant="outline"
                      >
                        Set up
                      </Button>
                    ) : (
                      // Said rather than left blank, which would read as a control yet to arrive.
                      <span className="text-muted-foreground text-sm">
                        No setup screen yet
                      </span>
                    )}
                  </ItemActions>
                </Item>
                {index !== (connectors.data?.length ?? 0) - 1 && <Separator />}
              </StaggerItem>
            ))}
          </PageRows>
        )}
      </PageSection>
    </PageShell>
  );
}

function syncSummary(connector: {
  status?: "pending" | "running" | "succeeded" | "failed";
  lastSyncAt?: string | null;
  nextSyncAt?: string | null;
}) {
  if (connector.status === "running") return "Syncing now";
  if (connector.status === "pending") return "Waiting for first sync";
  const last = connector.lastSyncAt
    ? new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(connector.lastSyncAt))
    : null;
  if (connector.status === "failed") {
    return last ? `Last attempt failed ${last}` : "Last sync failed";
  }
  return last ? `Last synced ${last}` : "Configured";
}
