FROM oven/bun:1.3.14

WORKDIR /app

# The bundled Codex binary uses the operating system trust store for ChatGPT device authentication.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock bunfig.toml ./
COPY patches patches
COPY app/package.json app/package.json
COPY evals/package.json evals/package.json
COPY sdk/package.json sdk/package.json
COPY server/package.json server/package.json
COPY worker/package.json worker/package.json
RUN bun install --frozen-lockfile

COPY server server
COPY sdk sdk
COPY examples examples

WORKDIR /app/server

ENV NODE_ENV=production
ENV PATH="/app/server/node_modules/.bin:${PATH}"
EXPOSE 3001
CMD ["bun", "src/index.ts"]
