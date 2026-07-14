# syntax=docker/dockerfile:1.7
FROM node:24-slim

# 基础工具：git 用于 diff/file 操作，lsof 用于端口检查，tini 作为 PID 1 处理信号与僵尸进程
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates \
       curl \
       tar \
       git \
       lsof \
       tini \
    && rm -rf /var/lib/apt/lists/*

# pnpm + @lightfish/cli（workspace 脚手架用，server 会 exec lightfish create 进来）+ opencode CLI
# 单个 RUN 减层数；pnpm store 固定到 /opt/pnpm-store 便于缓存挂载
RUN npm install -g pnpm@9.12.0 \
    && pnpm config set store-dir /opt/pnpm-store --global \
    && npm install -g @lightfish/cli \
    && arch=$(dpkg --print-architecture) \
    && curl -fsSL -o /tmp/opencode.tar.gz \
         "https://github.com/anomalyco/opencode/releases/latest/download/opencode-linux-${arch}.tar.gz" \
    && tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin/ \
    && chmod +x /usr/local/bin/opencode \
    && rm -f /tmp/opencode.tar.gz

WORKDIR /workspace

# opencode 全局配置放到默认配置目录，运行时直接读，避免从 workspace 复制
ENV HOME=/root
RUN mkdir -p /root/.config/opencode
COPY opencode.json /root/.config/opencode/opencode.json
COPY prompts/ /root/.config/opencode/prompts/

COPY start.sh /start.sh
RUN chmod +x /start.sh

EXPOSE 4096

# tini 作 PID 1，转发信号给 opencode serve，干净退出
ENTRYPOINT ["/usr/bin/tini", "--", "/start.sh"]
