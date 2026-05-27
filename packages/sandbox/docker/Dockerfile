# Sandbox base image for running untrusted LLM-generated TypeScript modules.
# Built once and reused for every integration run. The host wires per-run
# data in via env vars + a single read-only bind mount at /code/main.mjs.
#
# Layering decisions:
#   - node:20-slim, not :alpine. Alpine's musl has bitten ssh2/sftp before;
#     glibc keeps the integration surface boring.
#   - ca-certificates only. No curl, no wget, no compilers, no shells beyond
#     /bin/sh. Anything more is attack surface.
#   - Dedicated runner uid (10001) with /usr/sbin/nologin shell — even if a
#     payload escapes Node, it can't open an interactive shell.
#   - All deps installed --omit=dev at build time so the running container
#     never touches npm/npx at runtime (npm scripts are a common privesc path).
#   - NODE_OPTIONS caps the V8 heap below the cgroup memory limit, so we get
#     a clean V8 OOM error in stderr instead of an opaque SIGKILL when the
#     payload mallocs forever.

FROM node:20-slim AS base

# Minimal CA bundle. Nothing else.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Non-root user. Fixed uid so host bind-mount permissions are predictable.
RUN useradd -u 10001 -m -s /usr/sbin/nologin runner

WORKDIR /sandbox

# Install the baked-in module surface (axios, ssh2-sftp-client, xml2js, csv-parse, dotenv).
# These are the only modules the generated code is allowed to import — the
# entrypoint enforces this further via an import allowlist.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund \
    && npm cache clean --force

# Entrypoint is plain ESM JS; no build step.
COPY entrypoint.js ./entrypoint.js

# Drop privileges before the entrypoint ever runs.
USER 10001:10001

ENV NODE_ENV=production
# --no-deprecation keeps stderr clean; --max-old-space-size caps V8 below the
# cgroup limit so OOMs are reported by Node, not by the kernel.
ENV NODE_OPTIONS="--no-deprecation --max-old-space-size=200"

# The host mounts the integration source at /code/main.mjs read-only.
# Trigger payload + secrets come in via env. The entrypoint reads both.
ENTRYPOINT ["node", "/sandbox/entrypoint.js"]
