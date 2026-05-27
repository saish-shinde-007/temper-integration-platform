FROM node:20-slim
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/mocks/sftp/package.json ./packages/mocks/sftp/
RUN pnpm install --filter @temper/mock-sftp --prod=false --ignore-scripts
COPY packages/mocks/sftp ./packages/mocks/sftp
RUN pnpm --filter @temper/mock-sftp build
# Inside the container we listen on the standard SSH port; docker-compose maps
# this to MOCK_SFTP_PORT (5022) on the host.
ENV MOCK_SFTP_PORT=22
EXPOSE 22
CMD ["node", "packages/mocks/sftp/dist/index.js"]
