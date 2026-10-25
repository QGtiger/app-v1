# builder：在 monorepo 上下文里装依赖 + 构建 server
FROM node:24-slim AS builder
WORKDIR /app

# 先拷锁文件与 manifest 利用层缓存（pnpm install 只在依赖变化时重跑）
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json ./apps/server/

# 固定 pnpm 版本对齐 packageManager，否则装到 v11 会忽略 onlyBuiltDependencies。
# 国内构建加速：npm 走 npmmirror；pnpm store 用 BuildKit 缓存挂载，
# 锁文件变化导致本层重跑时也不必全量重新下载依赖包。
RUN npm config set registry https://registry.npmmirror.com \
    && npm install -g pnpm@9.15.0 \
    && pnpm config set store-dir /opt/pnpm-store --global
RUN --mount=type=cache,id=pnpm-store,target=/opt/pnpm-store pnpm install

COPY apps/server/ ./apps/server/
RUN pnpm --filter server build

# pnpm 的 node_modules 是指向全局 store 的符号链接，不能直接 COPY 进运行镜像；
# pnpm deploy 把 server 包及其依赖解析成真实的 node_modules 树，供下一步拷贝。
RUN pnpm deploy --filter server /app/deploy

# 运行镜像：只带 dist + 解析后的 node_modules，不含源码/构建工具
FROM node:24-slim
WORKDIR /app
RUN mkdir -p /app/data
COPY --from=builder /app/deploy ./
EXPOSE 3060
CMD ["node", "dist/index.js"]
