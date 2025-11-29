# Workflow runner image used for e2e tests.
# The image now bundles git, curl, a mock opencode CLI, and a mock rad CLI so the runtime
# can validate provider/rad prerequisites inside Docker.
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

COPY bin/opencode /usr/local/bin/opencode
COPY bin/rad /usr/local/bin/rad
RUN chmod +x /usr/local/bin/opencode /usr/local/bin/rad

ENV OPENCODE_LOG_DIR=/var/log/opencode
RUN mkdir -p "$OPENCODE_LOG_DIR"

CMD ["curl"]
