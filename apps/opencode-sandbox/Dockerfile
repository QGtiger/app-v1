# syntax=docker/dockerfile:1.7
FROM node:24-slim

# 国内构建加速：apt 换阿里云源（bookworm 的源可能在两个位置，逐个存在者替换），
# npm 换 npmmirror（写入 /root/.npmrc，对后续所有 RUN 里跑的 npm/pnpm 生效）
RUN set -eux; \
    for f in /etc/apt/sources.list /etc/apt/sources.list.d/debian.sources; do \
      [ -f "$f" ] && sed -i 's|deb.debian.org|mirrors.aliyun.com|g' "$f" || true; \
    done; \
    npm config set registry https://registry.npmmirror.com; \
    apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates \
       curl \
       tar \
       git \
       lsof \
       tini \
    && rm -rf /var/lib/apt/lists/*

# pnpm：store 固定到 /opt/pnpm-store 便于缓存挂载
RUN npm install -g pnpm@9.12.0 \
    && pnpm config set store-dir /opt/pnpm-store --global

# @lightfish/cli：workspace 脚手架，server 会 exec lightfish create 进来
# @latest 只在本层真正重跑时解析最新版（平时命中缓存不会自动升级）；
# 想强制刷新到最新：docker compose build --no-cache opencode-sandbox
RUN npm install -g @lightfish/cli@latest

# opencode CLI：版本固定避免 latest 自动升级；升级时改 OPENCODE_VERSION 即可
# GitHub 直连在国内服务器上极慢，走 gh-proxy.com 加速前缀（2026-10 实测可用；
# ghfast.top / mirror.ghproxy.com 已失效）。若再失效，换其他加速站，前缀拼法不变
ARG OPENCODE_VERSION=v1.18.1
RUN arch=$(dpkg --print-architecture) \
    && case "$arch" in \
         amd64) oc_arch=x64 ;; \
         arm64) oc_arch=arm64 ;; \
         *) echo "unsupported arch: $arch" >&2; exit 1 ;; \
       esac \
    && curl -fsSL --retry 3 -o /tmp/opencode.tar.gz \
         "https://gh-proxy.com/https://github.com/anomalyco/opencode/releases/download/${OPENCODE_VERSION}/opencode-linux-${oc_arch}.tar.gz" \
    && tar -xzf /tmp/opencode.tar.gz -C /usr/local/bin/ \
    && chmod +x /usr/local/bin/opencode \
    && rm -f /tmp/opencode.tar.gz

WORKDIR /workspace

# opencode 全局配置放到默认配置目录，运行时直接读，避免从 workspace 复制
ENV HOME=/root
RUN mkdir -p /root/.config/opencode
COPY opencode.json /root/.config/opencode/opencode.json
COPY prompts/ /root/.config/opencode/prompts/
COPY tools/ /root/.config/opencode/tools/

COPY start.sh /start.sh
RUN chmod +x /start.sh

EXPOSE 4096

# tini 作 PID 1，转发信号给 opencode serve，干净退出
ENTRYPOINT ["/usr/bin/tini", "--", "/start.sh"]
