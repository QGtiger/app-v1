FROM node:24-slim AS builder
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json ./apps/server/

RUN npm install -g pnpm@9.15.0 && pnpm install

COPY apps/server/ ./apps/server/
RUN pnpm --filter server build

RUN pnpm deploy --filter server /app/deploy

FROM node:24-slim
WORKDIR /app
RUN mkdir -p /app/data
COPY --from=builder /app/deploy ./
EXPOSE 3060
CMD ["node", "dist/index.js"]
