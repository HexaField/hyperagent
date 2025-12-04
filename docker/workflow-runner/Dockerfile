FROM node:20-bookworm

ENV DEBIAN_FRONTEND=noninteractive
ENV XDG_CONFIG_HOME=/root/.config

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    git \
    ca-certificates \
    openssh-client \
    curl \
    unzip \
    xz-utils \
  && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /root/.config && touch /root/.bashrc

RUN curl -fsSL https://opencode.ai/install | bash && \
  ln -sf /root/.opencode/bin/opencode /usr/local/bin/opencode && \
  ln -sf /root/.opencode/bin/opencode /usr/local/bin/opencode-cli

RUN curl -fsSL https://radicle.xyz/install | sh -s -- --prefix=/usr/local/radicle --no-modify-path

ENV PATH="/root/.opencode/bin:/usr/local/bin:/usr/local/radicle/bin:${PATH}"
ENV RADICLE_BIN_PATH=/usr/local/radicle/bin/rad
ENV RADICLE_CLI_PATH=/usr/local/bin/rad

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN chmod +x docker/workflow-runner/bin/rad \
  && cp docker/workflow-runner/bin/rad /usr/local/bin/rad

ENV OPENCODE_LOG_DIR=/var/log/opencode
RUN mkdir -p "$OPENCODE_LOG_DIR"

RUN npm run build:runner

ENTRYPOINT ["node", "dist/src/runner/workflowRunner.js"]
