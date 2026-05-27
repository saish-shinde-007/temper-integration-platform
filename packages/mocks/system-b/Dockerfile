FROM node:20-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/mocks/system-b/package.json ./packages/mocks/system-b/
RUN pnpm install --filter @temper/mock-system-b --prod=false --ignore-scripts
COPY packages/mocks/system-b ./packages/mocks/system-b
RUN pnpm --filter @temper/mock-system-b build
ENV PORT=8080
EXPOSE 8080
CMD ["node", "packages/mocks/system-b/dist/index.js"]
