# Самодостаточный образ полосы. Базы медуллы здесь НЕТ намеренно: наследование
# от неё привязывало нас к чужому образу, который отстаёт молча - внутри
# оказалась medulla 4.76.4 при 4.90 на хосте, разрыв в четырнадцать версий, и
# все замеры о шаблонах и сигналах описывали не тот движок, который исполняет.
# Здесь всё ставится явно и видно одним взглядом.
FROM node:24-trixie-slim

ARG TARGETARCH
SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# Архитектура определяется, а не предполагается: жёсткий arm64 ломал сборку на
# обычном linux/amd64 либо клал внутрь двоичные файлы не той архитектуры.
RUN arch="${TARGETARCH:-$(dpkg --print-architecture)}"; \
    case "$arch" in arm64|aarch64) echo arm64 ;; amd64|x86_64) echo amd64 ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; esac > /tmp/arch

# git и ssh нужны посадке, python3 - движку, jq - хукам, sqlite3 - проверке
# индекса перед стартом: копия базы открывается и отвечает, а не просто лежит.
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends \
      ca-certificates curl git openssh-client python3 python3-venv jq sqlite3 ripgrep unzip less procps \
 && rm -rf /var/lib/apt/lists/*

# ── ДВИЖОК ───────────────────────────────────────────────────────────────────
# Ставится КОММИТОМ, а не "последним": последний выходит по нескольку раз в
# день, и образ, собранный дважды подряд, оказывался разным. Коммит передаёт
# build-image.sh, читая его с хоста - так снаружи и внутри работает один движок.
ARG MEDULLA_REF=main
RUN python3 -m venv /opt/medulla \
 && /opt/medulla/bin/pip install --no-cache-dir -q \
      "git+https://github.com/skopanev/medulla.git@${MEDULLA_REF}" \
 && ln -s /opt/medulla/bin/medulla /usr/local/bin/medulla \
 && medulla --version

# ── ХАРНЕССЫ ─────────────────────────────────────────────────────────────────
# Версии приходят с хоста: расхождение между тем, чем меряли, и тем, что
# исполняет, дороже свежести. Пусто - берётся последняя.
ARG CLAUDE_VERSION=latest
ARG CODEX_VERSION=latest
RUN npm i -g --silent "@anthropic-ai/claude-code@${CLAUDE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
 && claude --version && codex --version

# ── ИНСТРУМЕНТЫ ──────────────────────────────────────────────────────────────
# CBM: предполёт по графу кода. Работает НАТИВНО, а не через мост к хосту -
# полоса получает сам граф, а не отчёт о нём.
ARG CBM_VERSION=0.10.8
RUN a="$(cat /tmp/arch)"; set -eux; \
    curl -fsSL "https://github.com/DeusData/codebase-memory-mcp/releases/download/v${CBM_VERSION}/codebase-memory-mcp-linux-${a}.tar.gz" \
      -o /tmp/cbm.tgz \
 && tar -xzf /tmp/cbm.tgz -C /tmp \
 && install -m 755 "$(find /tmp -maxdepth 2 -type f -name codebase-memory-mcp | head -1)" /usr/local/bin/codebase-memory-mcp \
 && rm -rf /tmp/cbm.tgz \
 && codebase-memory-mcp --version

# RTK: переписывает команды оболочки в компактный эквивалент. Замер на хосте -
# 123 тысячи команд, сэкономлено 66.9% вывода. Кодер делает по три десятка
# вызовов за прогон, и это прямая экономия его контекста.
ARG RTK_VERSION=0.49.0
RUN a="$(cat /tmp/arch)"; set -eux; \
    case "$a" in arm64) asset="rtk-aarch64-unknown-linux-gnu" ;; \
                 *)     asset="rtk-x86_64-unknown-linux-musl" ;; esac; \
    curl -fsSL "https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}/${asset}.tar.gz" \
      -o /tmp/rtk.tgz \
 && tar -xzf /tmp/rtk.tgz -C /tmp \
 && install -m 755 "$(find /tmp -maxdepth 2 -type f -name rtk | head -1)" /usr/local/bin/rtk \
 && rm -rf /tmp/rtk.tgz \
 && rtk --version

# NTK: тикеты. Публичная загрузка, ключ прокидывается при запуске.
RUN a="$(cat /tmp/arch)"; \
    curl -fsSL "https://ntk.otion.us/v1/download?platform=linux-${a}" -o /usr/local/bin/ntk \
 && chmod 755 /usr/local/bin/ntk && ntk --version

# ── ПРОСЛОЙКИ ────────────────────────────────────────────────────────────────
# equill - бинарь macOS; внутри он может быть только клиентом моста к хосту.
COPY lane/bridge/equill-shim.sh /usr/local/bin/equill
# Шина: сюда едет ТОЛЬКО прослойка, без клиента. Клиент - полный диспетчер, и
# имя отправителя в нём объявляется само: одна переменная окружения - и тело
# говорит от чужого лица, в контейнере, где согласования пропущены.
COPY lane/bridge/agentbus-shim.sh /usr/local/bin/agentbus
RUN chmod 755 /usr/local/bin/equill /usr/local/bin/agentbus \
 && bash -n /usr/local/bin/equill && sh -n /usr/local/bin/agentbus

# Пользователь без прав root: агент пишет в своё дерево, а не в систему.
RUN useradd -m -u 1001 -s /bin/bash medulla
USER medulla

# Хуки репозиториев ходят через bun; без него посадка падала на pre-commit.
RUN curl -fsSL https://bun.sh/install | bash && /home/medulla/.bun/bin/bun --version
ENV PATH="/home/medulla/.bun/bin:/home/medulla/.local/bin:${PATH}"

# ЦЕПЬЮ к /mnt/init-docker.sh, не заменой: он раскладывает учётные данные.
# Файл монтирует медулла при запуске, поэтому его здесь нет и быть не должно.
COPY --chown=medulla:medulla lane/bin/entrypoint.sh /usr/local/bin/lane-entrypoint.sh
USER root
RUN chmod 755 /usr/local/bin/lane-entrypoint.sh && sh -n /usr/local/bin/lane-entrypoint.sh
USER medulla
ENTRYPOINT ["/usr/local/bin/lane-entrypoint.sh"]
