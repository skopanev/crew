# БАЗА НЕ ПРИШПИЛЕНА ЧИСЛОМ. Медулла везёт свой базовый образ с собой, и его
# тег - отпечаток той версии движка, что была при сборке. Пришпиленный тег
# застывает: у нас внутри оказалась 4.76.4 при 4.90 на хосте, разрыв в
# четырнадцать версий, и все замеры описывали не тот движок, который исполняет.
# Тег подставляет build-image.sh, беря САМЫЙ СВЕЖИЙ из имеющихся. Обновил
# медуллу - пересобрал - база подтянулась. Править тут нечего и не надо.
ARG BASE_IMAGE=medulla-default:latest
FROM ${BASE_IMAGE}

USER root

# АРХИТЕКТУРА ОПРЕДЕЛЯЕТСЯ, А НЕ ПРЕДПОЛАГАЕТСЯ. Раньше здесь было жёстко
# arm64 - на Apple Silicon это родная и всё работало, а на обычном linux/amd64
# сборка либо падает на скачивании, либо кладёт внутрь двоичные файлы не той
# архитектуры, и они не запускаются.
ARG TARGETARCH
RUN arch="${TARGETARCH:-$(dpkg --print-architecture 2>/dev/null || uname -m)}"; \
    case "$arch" in aarch64|arm64) echo arm64 ;; x86_64|amd64) echo amd64 ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; esac > /tmp/arch

RUN a="$(cat /tmp/arch)"; \
    curl -fsSL "https://ntk.otion.us/v1/download?platform=linux-${a}" -o /usr/local/bin/ntk \
 && chmod +x /usr/local/bin/ntk \
 && ntk --version

# sqlite3 for the launcher's index preflight: `cp` of a directory is not an
# atomic snapshot of a live SQLite store, and a torn project database opens fine
# in list_projects and fails on the first real query, mid-run.
RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends sqlite3 \
 && rm -rf /var/lib/apt/lists/* && sqlite3 --version

# Codebase Memory runs NATIVELY here, not through the host bridge: the project
# ships a build for this architecture of the same version the host runs, so the lane gets
# the graph itself rather than a report about it.
ARG CBM_VERSION=0.10.8
RUN set -eux; a="$(cat /tmp/arch)"; \
    curl -fsSL "https://github.com/DeusData/codebase-memory-mcp/releases/download/v${CBM_VERSION}/codebase-memory-mcp-linux-${a}.tar.gz" \
      -o /tmp/cbm.tar.gz; \
    tar -xzf /tmp/cbm.tar.gz -C /tmp; \
    install -m 755 "$(find /tmp -maxdepth 2 -type f -name 'codebase-memory-mcp' | head -1)" \
      /usr/local/bin/codebase-memory-mcp; \
    rm -rf /tmp/cbm.tar.gz; \
    got="$(codebase-memory-mcp --version | awk '{print $2}')"; \
    [ "$got" = "${CBM_VERSION}" ] || { echo "cbm is $got, this image pins ${CBM_VERSION}" >&2; exit 1; }

# RTK: переписывает команды оболочки в компактный эквивалент. Замер на хосте -
# 123039 команд, сэкономлено 126.7M токенов, 66.9%. В полосе это прямая
# экономия контекста кодера, который делает по 35 вызовов Bash за прогон.
#
# ВАЖНО, ЧЕМ ЭТО НЕ ЯВЛЯЕТСЯ: `rtk proxy` ничего не режет, он только считает -
# так флот оборачивает медуллу. Режет `rtk hook`, повешенный на PreToolUse.
#
# Правило tools.rtk уровня must ("prefix shell commands with rtk") существовало
# в контракте всё это время, а бинаря в образе не было вовсе - я это замерил и
# снял правило отбором. Теперь оно исполнимо.
ARG RTK_VERSION=0.49.0
RUN set -eux; a="$(cat /tmp/arch)"; \
    rtk_arch="$([ "$a" = arm64 ] && echo aarch64 || echo x86_64)"; \
    curl -fsSL "https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}/rtk-${rtk_arch}-unknown-linux-gnu.tar.gz" \
      -o /tmp/rtk.tar.gz; \
    tar -xzf /tmp/rtk.tar.gz -C /tmp; \
    install -m 755 "$(find /tmp -maxdepth 2 -type f -name rtk | head -1)" /usr/local/bin/rtk; \
    rm -rf /tmp/rtk.tar.gz; \
    rtk --version

# equill is a macOS binary; inside, it can only be a client of the host bridge
COPY lane/bridge/equill-shim.sh /usr/local/bin/equill
RUN chmod 755 /usr/local/bin/equill && bash -n /usr/local/bin/equill

# agentbus is how a failed lane tells a PERSON, and without it every
# notification exited 127 into a `|| true` - a crashed lane told nobody and, from
# outside, looked exactly like a lane still working.
#
# But the CLIENT does not belong in here. It is a full dispatcher: `drain`,
# `reply`, `history` and `requests` are subcommands of the same script, a NATS
# pull primitive ships beside it, and the sender name is self-declared - one
# `export AGENTBUS_FROM=gm` away from speaking as the GM, in a container whose
# body runs with permissions skipped.
#
# So the image gets a shim and no NATS at all. Reading the bus and choosing a
# name are not forbidden here; they are absent. The host bridge decides the room,
# the identity and who may be written to.
COPY lane/bridge/agentbus-shim.sh /usr/local/bin/agentbus
RUN chmod 755 /usr/local/bin/agentbus && sh -n /usr/local/bin/agentbus

# must CHAIN to /mnt/init-docker.sh, never replace it: it sets up credentials
RUN cat > /usr/local/bin/lane-entrypoint.sh <<'ENTRY'
#!/bin/sh
exec /mnt/init-docker.sh "$@"
ENTRY
RUN chmod 755 /usr/local/bin/lane-entrypoint.sh \
 && sh -n /usr/local/bin/lane-entrypoint.sh

USER medulla

# the repos' own pre-push hooks run on bun; a push died without it
RUN curl -fsSL https://bun.sh/install | bash \
 && /home/medulla/.bun/bin/bun --version
ENV PATH="/home/medulla/.bun/bin:$PATH"

# Baked current, so init-docker.sh's per-start check says "current" and skips.
# ASSERTED, not merely taken: `upgrade` alone let the engine inside the image
# float independently of the one on the machine, and every statement about how
# templates render or signals route would then describe a different engine than
# the one executing the nodes. If upstream has moved, this build stops and says
# so instead of shipping a silent divergence. run.sh checks the pair again at
# launch, because an image can also sit unrebuilt while the host moves on.
# HARNESS VERSIONS: THE IMAGE TAKES THE HIGHER OF THE TWO, never simply the
# host's. Measured today: host claude was 2.1.236 while the image carried
# 2.1.268 - and --strict-mcp-config cuts host MCP servers on 2.1.268 and does
# NOT on 2.1.236. "Follow the host" would have downgraded this lane into the
# behaviour its whole isolation depends on not having.
#
# Versions arrive as build args from build-image.sh, which reads them off the
# host. Nothing updates at run time; a rebuild is what moves them.
ARG CLAUDE_HOST_VERSION=
ARG CODEX_HOST_VERSION=
RUN set -eu; \
    newer() { [ -n "$1" ] && [ "$1" != "$2" ] && \
              [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]; }; \
    have="$(claude --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"; \
    if newer "${CLAUDE_HOST_VERSION}" "$have"; then \
      echo "claude: host ${CLAUDE_HOST_VERSION} is newer than image $have - taking it" >&2; \
      npm i -g --silent "@anthropic-ai/claude-code@${CLAUDE_HOST_VERSION}"; \
    else echo "claude: image $have kept (host '${CLAUDE_HOST_VERSION}')" >&2; fi; \
    have="$(codex --version 2>/dev/null | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"; \
    if newer "${CODEX_HOST_VERSION}" "$have"; then \
      echo "codex: host ${CODEX_HOST_VERSION} is newer than image $have - taking it" >&2; \
      npm i -g --silent "@openai/codex@${CODEX_HOST_VERSION}"; \
    else echo "codex: image $have kept (host '${CODEX_HOST_VERSION}')" >&2; fi

# ДВИЖОК БЕРЁТСЯ ИЗ БАЗОВОГО ОБРАЗА, БЕЗ upgrade. Обновление на сборке тянуло
# самую свежую версию из сети - а она выходит по нескольку раз в день: сегодня
# хост ушёл с 4.86 на 4.87, потом 4.88, потом 4.90, и каждый раз сборка падала
# на несовпадении с пришпиленным числом.
# Версия здесь ТА, ЧТО В БАЗОВОМ ОБРАЗЕ, и меняется вместе с ним - осознанно, а
# не на каждой пересборке.
# Совпадение с хостом проверяет run.sh при запуске: утверждения о том, как
# раскрываются шаблоны и маршрутизируются сигналы, описывают ОДИН движок, и
# расхождение делает их описанием другого.
RUN medulla --version

ENTRYPOINT ["/usr/local/bin/lane-entrypoint.sh"]
