import {
  IconBolt,
  IconBox,
  IconBriefcase,
  IconCommand,
  IconMessagePlus,
  IconSettings,
  IconShieldLock,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type ComponentType, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { currentUserQueryOptions } from "@/lib/auth/queries";

type PaletteCommand = {
  id: string;
  label: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
  run: () => void;
};

export function CommandPalette() {
  const navigate = useNavigate();
  const { data: currentUser } = useQuery(currentUserQueryOptions());
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const commands = useMemo<PaletteCommand[]>(() => {
    const closeAndGo =
      (
        to:
          | "/channel/new"
          | "/agents"
          | "/work"
          | "/skills"
          | "/settings"
          | "/admin",
      ) =>
      () => {
        setOpen(false);
        setQuery("");
        void navigate({ to });
      };
    return [
      {
        id: "new-channel",
        label: "New channel",
        description: "Start a conversation with a coworker",
        icon: IconMessagePlus,
        run: closeAndGo("/channel/new"),
      },
      {
        id: "agents",
        label: "Coworkers",
        description: "Create, import, or manage agents",
        icon: IconBolt,
        run: closeAndGo("/agents"),
      },
      {
        id: "work",
        label: "Work",
        description: "Open runs, routines, projects, and handoffs",
        icon: IconBriefcase,
        run: closeAndGo("/work"),
      },
      {
        id: "skills",
        label: "Skills",
        description: "Manage reusable instructions",
        icon: IconBox,
        run: closeAndGo("/skills"),
      },
      {
        id: "settings",
        label: "Settings",
        description: "Preferences, model, reasoning, and usage",
        icon: IconSettings,
        run: closeAndGo("/settings"),
      },
      ...(currentUser?.role === "admin"
        ? [
            {
              id: "admin",
              label: "Administration",
              description: "Policy, credentials, computers, and audit",
              icon: IconShieldLock,
              run: closeAndGo("/admin"),
            },
          ]
        : []),
    ];
  }, [currentUser?.role, navigate]);

  const visible = commands.filter((command) => {
    const needle = query.trim().toLocaleLowerCase();
    return (
      !needle ||
      `${command.label} ${command.description}`
        .toLocaleLowerCase()
        .includes(needle)
    );
  });
  const activeIndex =
    visible.length === 0 ? 0 : Math.min(selected, visible.length - 1);

  return (
    <>
      <Button
        aria-label="Open command palette"
        onClick={() => setOpen(true)}
        size="icon"
        title="Commands (Ctrl/⌘ K)"
        variant="ghost"
      >
        <IconCommand />
      </Button>
      <Dialog
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) {
            setQuery("");
            setSelected(0);
          }
        }}
        open={open}
      >
        <DialogContent className="gap-3 p-3" showCloseButton={false}>
          <DialogHeader className="sr-only">
            <DialogTitle>Commands</DialogTitle>
            <DialogDescription>
              Search and open a Kayco screen.
            </DialogDescription>
          </DialogHeader>
          <Input
            aria-label="Search commands"
            autoFocus
            className="h-11 border-0 bg-muted/50 px-3 shadow-none focus-visible:ring-0"
            onChange={(event) => {
              setQuery(event.target.value);
              setSelected(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && visible.length) {
                event.preventDefault();
                setSelected((current) => (current + 1) % visible.length);
              } else if (event.key === "ArrowUp" && visible.length) {
                event.preventDefault();
                setSelected(
                  (current) => (current - 1 + visible.length) % visible.length,
                );
              } else if (event.key === "Enter") {
                event.preventDefault();
                visible[activeIndex]?.run();
              }
            }}
            placeholder="Search commands…"
            value={query}
          />
          <DialogBody className="max-h-80 gap-1 overflow-y-auto">
            {visible.length ? (
              visible.map((command, index) => {
                const Icon = command.icon;
                return (
                  <button
                    aria-current={index === activeIndex ? "true" : undefined}
                    className="flex items-center gap-3 rounded-lg px-3 py-2 text-left hover:bg-muted aria-current:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    key={command.id}
                    onClick={command.run}
                    onMouseEnter={() => setSelected(index)}
                    type="button"
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium">
                        {command.label}
                      </span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {command.description}
                      </span>
                    </span>
                  </button>
                );
              })
            ) : (
              <p className="p-4 text-center text-sm text-muted-foreground">
                No commands match “{query.trim()}”.
              </p>
            )}
          </DialogBody>
          <p className="px-2 text-xs text-muted-foreground">
            Use ↑ and ↓ to move, Enter to open, Escape to close.
          </p>
        </DialogContent>
      </Dialog>
    </>
  );
}
