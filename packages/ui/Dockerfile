# Next.js UI for Cloud Run.

FROM node:20-slim AS build
WORKDIR /app
RUN corepack enable

# Workspace root + UI manifests for the dependency install.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/ui/package.json ./packages/ui/

RUN pnpm install --filter @temper/ui... --frozen-lockfile=false --ignore-scripts

# Source
COPY packages/shared ./packages/shared
COPY packages/ui ./packages/ui

# NEXT_PUBLIC_* env vars are baked into the JS bundle at build time, so they
# must be passed as build args, not container env. The Cloud Run image's
# bundled JS references these URLs from the user's browser.
ARG NEXT_PUBLIC_API_URL=http://localhost:4000
ARG NEXT_PUBLIC_TENANT_ID=tenant-demo
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_TENANT_ID=$NEXT_PUBLIC_TENANT_ID

# Build shared first (UI's transpilePackages config picks it up).
RUN pnpm --filter @temper/shared build
RUN pnpm --filter @temper/ui build

# Production runner (smaller image, no devDeps).
FROM node:20-slim AS run
WORKDIR /app
RUN corepack enable

COPY --from=build /app/package.json /app/pnpm-workspace.yaml /app/pnpm-lock.yaml ./
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/ui ./packages/ui

# Install only what's needed at runtime.
RUN pnpm install --filter @temper/ui --prod --frozen-lockfile=false --ignore-scripts

ENV PORT=8080
ENV NEXT_TELEMETRY_DISABLED=1
EXPOSE 8080

WORKDIR /app/packages/ui
CMD ["node_modules/.bin/next", "start", "-p", "8080"]
