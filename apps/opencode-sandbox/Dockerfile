# syntax=docker/dockerfile:1.7
FROM node:24-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates \
       curl \
       tar \
       git \
       lsof \
       tini \
    && rm -rf /var/lib/apt/lists/*

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

ENV HOME=/root
RUN mkdir -p /root/.config/opencode
COPY opencode.json /root/.config/opencode/opencode.json
COPY prompts/ /root/.config/opencode/prompts/

COPY start.sh /start.sh
RUN chmod +x /start.sh

EXPOSE 4096

ENTRYPOINT ["/usr/bin/tini", "--", "/start.sh"]
