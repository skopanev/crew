# Reuse the broker box tools and private Docker entrypoint.
FROM broker-box

ARG TARGETARCH
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

RUN arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in arm64|aarch64) echo arm64 ;; amd64|x86_64) echo amd64 ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; esac > /tmp/arch

RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends \
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

COPY lane-launcher/ntk-status lane-launcher/ntk-status.mjs lane-launcher/ntk.mjs /usr/local/bin/
RUN chmod 755 /usr/local/bin/ntk-status

COPY lane/bridge/equill-shim.sh /usr/local/bin/equill
RUN chmod 755 /usr/local/bin/equill

# Match the host UID for files written into mounted checkouts.
ARG USER_UID=501
ARG USER_GID=501
RUN if ! getent group ${USER_GID} >/dev/null; then groupadd -g ${USER_GID} medulla; fi; \
    if getent passwd ${USER_UID} >/dev/null; then \
      existing="$(getent passwd ${USER_UID} | cut -d: -f1)"; \
      usermod -l medulla "$existing"; \
      usermod -d /home/medulla -m medulla; \
      usermod -g ${USER_GID} medulla; \
    else \
      useradd -m -u ${USER_UID} -g ${USER_GID} -s /bin/bash medulla; \
    fi
USER ${USER_UID}:${USER_GID}
ENV HOME=/home/medulla

# Create parents before Medulla mounts credentials and executables.
RUN mkdir -p /home/medulla/.local/bin /home/medulla/.local/share \
             /home/medulla/.config /home/medulla/.cache /home/medulla/.medulla \
 && chown -R ${USER_UID}:${USER_GID} /home/medulla

ENV PATH="/home/medulla/.local/bin:${PATH}"

# Chain into Medulla credential setup.
COPY --chown=${USER_UID}:${USER_GID} lane/bin/entrypoint.sh /usr/local/bin/lane-entrypoint.sh
USER root
RUN chmod 755 /usr/local/bin/lane-entrypoint.sh
# Repository checks use a pinned OpenTofu binary; Gitleaks comes from broker-box.
RUN set -eux; a="$(cat /tmp/arch)"; \
    case "$a" in \
      arm64) tofu_sha=e573979ba68a17fe7b881752051a694a7efcd970e39521f6a25775197861ed4d ;; \
      amd64) tofu_sha=5dc43da4f750f33873dc25e94587128709e819e544b7be9016b255316153c3a8 ;; \
    esac; \
    curl -fsSL "https://github.com/opentofu/opentofu/releases/download/v1.12.6/tofu_1.12.6_linux_${a}.zip" -o /tmp/tofu.zip; \
    printf '%s  /tmp/tofu.zip\n' "$tofu_sha" | sha256sum -c -; \
    mkdir /tmp/lane-tools; \
    unzip -q /tmp/tofu.zip -d /tmp/lane-tools; \
    install -m 755 /tmp/lane-tools/tofu /usr/local/bin/; \
    rm -rf /tmp/lane-tools /tmp/tofu.zip
USER ${USER_UID}:${USER_GID}
ENTRYPOINT ["/usr/local/bin/lane-entrypoint.sh"]
