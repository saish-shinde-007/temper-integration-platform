FROM node:20-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/mocks/system-a/package.json ./packages/mocks/system-a/
RUN pnpm install --filter @temper/mock-system-a --prod=false --ignore-scripts
COPY packages/mocks/system-a ./packages/mocks/system-a
RUN pnpm --filter @temper/mock-system-a build
ENV PORT=8080
EXPOSE 8080
CMD ["node", "packages/mocks/system-a/dist/index.js"]
