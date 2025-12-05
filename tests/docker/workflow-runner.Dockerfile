# Workflow runner image used for e2e tests.
# The image bundles git, curl, and the real opencode CLI so the runtime can validate
# provider prerequisites inside Docker. A lightweight rad mock is kept for testing.
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		curl \
		ca-certificates \
		git \
		openssh-client \
		nodejs \
		npm \
	&& rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://opencode.ai/install | bash \
	&& ln -sf /root/.opencode/bin/opencode /usr/local/bin/opencode \
	&& ln -sf /root/.opencode/bin/opencode /usr/local/bin/opencode-cli

COPY bin/rad /usr/local/bin/rad
RUN chmod +x /usr/local/bin/rad

ENV OPENCODE_LOG_DIR=/var/log/opencode
RUN mkdir -p "$OPENCODE_LOG_DIR"

CMD ["curl"]
