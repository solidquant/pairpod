FROM node:22-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
      tmux git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code

RUN useradd -m -s /bin/bash agent && mkdir -p /workspace && chown agent:agent /workspace
USER agent
WORKDIR /workspace

ENV DISABLE_AUTOUPDATER=1
ENV LANG=C.UTF-8 LC_ALL=C.UTF-8

CMD ["sleep", "infinity"]
