# All-in-one platform service (API + workflow worker, sharing SQLite in /tmp).
# Used by Cloud Run; local dev still runs the packages separately.

FROM node:20-slim AS deps
WORKDIR /app
RUN corepack enable

# Copy workspace root config first (changes rarely).
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./

# Copy every workspace package.json so pnpm can build the dependency graph
# without needing the source yet. This is the canonical pnpm-in-Docker pattern.
COPY packages/shared/package.json ./packages/shared/
COPY packages/db/package.json ./packages/db/
COPY packages/agent/package.json ./packages/agent/
COPY packages/sandbox/package.json ./packages/sandbox/
COPY packages/api/package.json ./packages/api/
COPY packages/workflows/package.json ./packages/workflows/
COPY packages/runner/package.json ./packages/runner/
COPY packages/platform/package.json ./packages/platform/

# Install all workspace deps (transitive too). Allow scripts so better-sqlite3
# builds its native binding for linux/amd64; --frozen-lockfile=false because
# the lockfile may not match exactly.
RUN apt-get update && apt-get install -y --no-install-recommends python3 build-essential && rm -rf /var/lib/apt/lists/*
# Claude Agent SDK shells out to the `claude` CLI for inference; it must be on PATH.
RUN npm install -g @anthropic-ai/claude-code
RUN pnpm install --frozen-lockfile=false

# Now copy source and build.
COPY packages/shared ./packages/shared
COPY packages/db ./packages/db
COPY packages/agent ./packages/agent
COPY packages/sandbox ./packages/sandbox
COPY packages/api ./packages/api
COPY packages/workflows ./packages/workflows
COPY packages/runner ./packages/runner
COPY packages/platform ./packages/platform

RUN pnpm --filter @temper/shared build
RUN pnpm --filter @temper/db build
RUN pnpm --filter @temper/sandbox build
RUN pnpm --filter @temper/agent build
RUN pnpm --filter @temper/api build
RUN pnpm --filter @temper/workflows build
RUN pnpm --filter @temper/runner build
RUN pnpm --filter @temper/platform build

# Cloud Run default port. The platform's API listens on $PORT.
ENV PORT=8080
EXPOSE 8080

CMD ["node", "packages/platform/dist/index.js"]
