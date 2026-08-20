FROM oven/bun:1.3.14

WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY patches patches
COPY app/package.json app/package.json
COPY evals/package.json evals/package.json
COPY sdk/package.json sdk/package.json
COPY server/package.json server/package.json
COPY worker/package.json worker/package.json
RUN bun install --frozen-lockfile

COPY sdk sdk
COPY server server
COPY worker worker

WORKDIR /app/worker
ENV NODE_ENV=production
ENV PATH="/app/worker/node_modules/.bin:${PATH}"
CMD ["bun", "src/index.ts"]
