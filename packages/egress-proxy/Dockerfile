FROM node:20-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared ./packages/shared
COPY packages/egress-proxy/package.json ./packages/egress-proxy/
RUN pnpm install --filter @temper/egress-proxy --filter @temper/shared --prod=false --ignore-scripts
COPY packages/egress-proxy ./packages/egress-proxy
RUN pnpm --filter @temper/shared build && pnpm --filter @temper/egress-proxy build
EXPOSE 5080
CMD ["node", "packages/egress-proxy/dist/index.js"]
