import { serve } from "bun";
import { Hono } from "hono";
import { hasComputerCapacity } from "./capacity";
import {
  DockerUnavailableError,
  ensure,
  listOwned,
  reachable,
  reset,
  stop,
} from "./docker";
import { registerEntry } from "./identity";
import { namesFor } from "./names";
import { optionalPositiveInteger } from "./resources";

/**
 * The container supervisor: the only thing here that holds the Docker socket.
 *
 * Giving a Bot its own container requires something to create containers. Access to the Docker
 * socket is root-equivalent on the host because a container can be started with the host filesystem
 * bound into it. Putting that in the API server would mean every bug in a request handler, every
 * injection through a Bot's own output and every dependency in a large tree sits one mistake away
 * from owning the machine.
 *
 * So the socket lives behind four verbs, expressed in Bots rather than in Docker: ensure a computer
 * for this Bot, stop it, reset it, list them. There is no passthrough and no way to name a container
 * directly, names are derived from the Bot id, which is validated first. A compromised API server
 * can ask for a Bot's computer to be restarted. It cannot ask for anything else, because nothing
 * else is expressible.
 *
 * The shared secret is not the boundary; the vocabulary is. `SUPERVISOR_TOKEN` keeps other
 * processes on the same network from driving it, but even with the token the worst available action
 * is cycling a computer that already belongs to a Bot.
 *
 * Refusing to start without it matches the computer. This process holds the Docker socket, which is
 * root on the host, so missing authentication is a deployment failure.
 */

const port = Number.parseInt(process.env.PORT ?? "4300", 10);
const token = process.env.SUPERVISOR_TOKEN?.trim();
if (!token) {
  console.error(
    "SUPERVISOR_TOKEN is not set. This process holds the Docker socket and will not start without the secret its caller must present.",
  );
  process.exit(1);
}
const image = process.env.COMPUTER_IMAGE ?? "openbot-agent-computer:latest";
const network = process.env.COMPUTER_NETWORK;
const runtime = process.env.COMPUTER_RUNTIME;
const memoryBytes = optionalPositiveInteger(
  process.env,
  "COMPUTER_MEMORY_BYTES",
);
const nanoCpus = optionalPositiveInteger(process.env, "COMPUTER_NANO_CPUS");
const pidsLimit = optionalPositiveInteger(process.env, "COMPUTER_PIDS_LIMIT");
const maxRunning = optionalPositiveInteger(process.env, "COMPUTER_MAX_RUNNING");
const spireSocketVolume = process.env.SPIRE_AGENT_SOCKET_VOLUME;

/** Serialize capacity decisions so two simultaneous requests cannot both take the last slot. */
let capacityQueue: Promise<void> = Promise.resolve();

function withCapacityLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = capacityQueue.then(operation, operation);
  capacityQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * What a computer is told about itself.
 *
 * The egress variables come through so a Bot's traffic still leaves by the route configured for it;
 * everything else a computer needs it already has. Nothing here is caller-supplied: a request says
 * which Bot, never what to run or what to set.
 */
function environmentFor(botId: string): string[] {
  const passthrough = Object.entries(process.env).filter(([key]) =>
    key.startsWith("EGRESS_PROXY"),
  );
  /*
   * The secret the computer demands of its callers. Handed to every container this creates, from
   * this process's own environment, so the server and the computers share one secret and nothing else
   * can drive a Bot's browser. Never caller-supplied: a request says which Bot, never what
   * to set.
   */
  const computerToken = process.env.COMPUTER_TOKEN;
  const allowPrivateHosts =
    process.env.AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS === "true";
  const browserTimeouts = ["ACTION_TIMEOUT_MS", "NAVIGATION_TIMEOUT_MS"]
    .map((key) => [key, process.env[key]] as const)
    .filter((entry): entry is readonly [string, string] => Boolean(entry[1]));
  return [
    // Which Bot this container is. Read by the computer as the Bot to assume when a request does not
    // name one. It is normally named per request, so this is the fallback, and for a container that
    // exists to be one Bot's the fallback must be that Bot rather than the shared default.
    `COMPUTER_BOT_ID=${botId}`,
    // Without this the computer refuses to start; it must never answer an unauthenticated caller.
    ...(computerToken ? [`COMPUTER_TOKEN=${computerToken}`] : []),
    `AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=${allowPrivateHosts}`,
    ...browserTimeouts.map(([key, value]) => `${key}=${value}`),
    // Where to ask what it is. Absent, the computer reports no identity and carries on.
    ...(spireSocketVolume
      ? ["SPIFFE_ENDPOINT_SOCKET=/tmp/spire-agent/public/api.sock"]
      : []),
    ...passthrough.map(([key, value]) => `${key}=${value ?? ""}`),
  ];
}

const app = new Hono();

app.use("*", async (context, next) => {
  // Health is open so an orchestrator can check it without holding the token.
  if (context.req.path === "/health") return next();
  if (context.req.header("authorization") !== `Bearer ${token}`) {
    return context.json({ error: "Unauthorized." }, 401);
  }
  return next();
});

app.get("/health", async (context) =>
  context.json({ status: "ok", docker: await reachable() }),
);

/** The Bot id in the path, validated before it becomes any kind of name. */
function resolve(raw: string) {
  return namesFor(raw);
}

app.post("/computers/:botId/ensure", async (context) => {
  const parsed = resolve(context.req.param("botId"));
  if (!parsed.ok) return context.json({ error: parsed.reason }, 400);

  try {
    const provision = async () => {
      const owned = maxRunning ? await listOwned() : [];
      if (
        maxRunning &&
        !hasComputerCapacity(parsed.names.botId, owned, maxRunning)
      ) {
        return {
          capacity: {
            maxRunning,
            activeComputers: owned
              .filter((computer) => computer.status === "running")
              .map((computer) => ({
                botId: computer.botId,
                ...(computer.startedAt
                  ? { startedAt: computer.startedAt }
                  : {}),
              })),
          },
        };
      }

      // Registered before the computer is handed out, so it can prove which Bot it is from its first
      // request.
      const identity = await registerEntry(parsed.names);
      const state = await ensure(parsed.names, {
        image,
        environment: environmentFor(parsed.names.botId),
        ...(network ? { network } : {}),
        ...(runtime ? { runtime } : {}),
        ...(memoryBytes ? { memoryBytes } : {}),
        ...(nanoCpus ? { nanoCpus } : {}),
        ...(pidsLimit ? { pidsLimit } : {}),
        ...(spireSocketVolume ? { spireSocketVolume } : {}),
      });
      return { identity, state };
    };

    const provisioned = maxRunning
      ? await withCapacityLock(provision)
      : await provision();
    if ("capacity" in provisioned) {
      return context.json(
        {
          error: `This host allows ${maxRunning} running Bot ${maxRunning === 1 ? "computer" : "computers"}. Stop an active computer before starting another.`,
          code: "computer_capacity",
          ...provisioned.capacity,
        },
        429,
      );
    }

    const { identity, state } = provisioned;
    return context.json({
      ...state,
      ...(identity.registered
        ? { spiffeId: identity.spiffeId }
        : { identity: identity.reason }),
    });
  } catch (error) {
    if (error instanceof DockerUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

app.post("/computers/:botId/stop", async (context) => {
  const parsed = resolve(context.req.param("botId"));
  if (!parsed.ok) return context.json({ error: parsed.reason }, 400);
  try {
    const stopped = await stop(parsed.names);
    return context.json({ stopped });
  } catch (error) {
    if (error instanceof DockerUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

app.post("/computers/:botId/reset", async (context) => {
  const parsed = resolve(context.req.param("botId"));
  if (!parsed.ok) return context.json({ error: parsed.reason }, 400);
  try {
    const wasThere = await reset(parsed.names);
    return context.json({ reset: wasThere });
  } catch (error) {
    if (error instanceof DockerUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

app.get("/computers", async (context) => {
  try {
    return context.json({ computers: await listOwned() });
  } catch (error) {
    if (error instanceof DockerUnavailableError) {
      return context.json({ error: error.message }, 503);
    }
    throw error;
  }
});

serve({ port, fetch: app.fetch, idleTimeout: 120 });

console.info(
  `Supervisor listening on http://localhost:${port} (image ${image}${runtime ? `, runtime ${runtime}` : ""})`,
);
