# Lane runtime; CBM and Equill remain host services.
FROM node:24-trixie-slim

ARG TARGETARCH
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in arm64|aarch64) echo arm64 ;; amd64|x86_64) echo amd64 ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; esac > /tmp/arch

RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends \
      ca-certificates curl git openssh-client python3 python3-venv jq ripgrep unzip less procps \
      gcc libc6-dev \
 && rm -rf /var/lib/apt/lists/*

# System Git trust survives repository hooks that clear Git environment variables.
RUN git config --system --add safe.directory /workspace \
 && git config --system --add safe.directory '*'

RUN python3 -m venv /opt/medulla \
 && /opt/medulla/bin/pip install --no-cache-dir -q \
      "git+https://github.com/skopanev/medulla.git" \
 && ln -s /opt/medulla/bin/medulla /usr/local/bin/medulla
# Update Medulla by rebuilding the image.
ENV MEDULLA_UPGRADE_ON_START=0

RUN npm i -g --silent "@anthropic-ai/claude-code@stable" "@openai/codex@latest" "opencode-ai@latest"

RUN a="$(cat /tmp/arch)"; set -eux; \
    case "$a" in arm64) asset="rtk-aarch64-unknown-linux-gnu" ;; \
                 *)     asset="rtk-x86_64-unknown-linux-musl" ;; esac; \
    curl -fsSL "https://github.com/rtk-ai/rtk/releases/latest/download/${asset}.tar.gz" \
      -o /tmp/rtk.tgz \
 && tar -xzf /tmp/rtk.tgz -C /tmp \
 && install -m 755 "$(find /tmp -maxdepth 2 -type f -name rtk | head -1)" /usr/local/bin/rtk \
 && rm -rf /tmp/rtk.tgz

COPY lane-launcher/ntk-status lane-launcher/ntk-status.mjs lane-launcher/ntk.mjs /usr/local/bin/
RUN chmod 755 /usr/local/bin/ntk-status

COPY lane/bridge/equill-shim.sh /usr/local/bin/equill
RUN chmod 755 /usr/local/bin/equill

# Match the host UID for files written into mounted checkouts.
ARG USER_UID=501
RUN if getent passwd ${USER_UID} >/dev/null; then \
      existing="$(getent passwd ${USER_UID} | cut -d: -f1)"; \
      usermod -l medulla "$existing"; \
      usermod -d /home/medulla -m medulla; \
      groupmod -n medulla "$(id -gn medulla)" 2>/dev/null || true; \
    else \
      useradd -m -u ${USER_UID} -s /bin/bash medulla; \
    fi
USER medulla

# Create parents before Medulla mounts credentials and executables.
RUN mkdir -p /home/medulla/.local/bin /home/medulla/.local/share \
             /home/medulla/.config /home/medulla/.cache /home/medulla/.medulla \
 && chown -R medulla:medulla /home/medulla

RUN curl -fsSL https://antigravity.google/cli/install.sh | bash

RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/home/medulla/.bun/bin:/home/medulla/.local/bin:${PATH}"

# Chain into Medulla credential setup.
COPY --chown=medulla:medulla lane/bin/entrypoint.sh /usr/local/bin/lane-entrypoint.sh
USER root
RUN chmod 755 /usr/local/bin/lane-entrypoint.sh \
 && ln -s /home/medulla/.bun/bin/bun /usr/local/bin/bun
# Repository checks use pinned OpenTofu and Gitleaks binaries.
RUN set -eux; a="$(cat /tmp/arch)"; \
    case "$a" in \
      arm64) tofu_sha=e573979ba68a17fe7b881752051a694a7efcd970e39521f6a25775197861ed4d; \
             leaks_arch=arm64; leaks_sha=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;; \
      amd64) tofu_sha=5dc43da4f750f33873dc25e94587128709e819e544b7be9016b255316153c3a8; \
             leaks_arch=x64; leaks_sha=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;; \
    esac; \
    curl -fsSL "https://github.com/opentofu/opentofu/releases/download/v1.12.6/tofu_1.12.6_linux_${a}.zip" -o /tmp/tofu.zip; \
    curl -fsSL "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_${leaks_arch}.tar.gz" -o /tmp/gitleaks.tgz; \
    printf '%s  /tmp/tofu.zip\n%s  /tmp/gitleaks.tgz\n' "$tofu_sha" "$leaks_sha" | sha256sum -c -; \
    mkdir /tmp/lane-tools; \
    unzip -q /tmp/tofu.zip -d /tmp/lane-tools; \
    tar -xzf /tmp/gitleaks.tgz -C /tmp/lane-tools; \
    install -m 755 /tmp/lane-tools/tofu /tmp/lane-tools/gitleaks /usr/local/bin/; \
    rm -rf /tmp/lane-tools /tmp/tofu.zip /tmp/gitleaks.tgz
USER medulla
ENTRYPOINT ["/usr/local/bin/lane-entrypoint.sh"]
