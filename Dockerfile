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
# gcc с заголовками - ЛИНКЕР ДЛЯ RUST, и без него полоса такой репозиторий не
# проверяет. Сам тулчейн в образ не кладём: он приезжает с хоста оверлеем
# медуллы (~/.cargo и ~/.rustup симлинками в ~/.medulla/container/), и тогда
# кодер компилирует ТЕМ ЖЕ rustc, что и человек, с уже прогретым кэшем крейтов.
# А вот линковать нечем: rustc зовёт системный cc, и без него не собирается
# даже cargo check - сборочные скрипты зависимостей (proc-macro2, quote, libc)
# сами исполняемые, "No such file or directory (os error 2)" на каждом.
# Замерено на ntk: с этой строкой cargo check 29s и cargo test 20 passed,
# оба --offline. Без неё кодер честно доложил, что проверить компиляцией не
# может, и пошёл качать rustup внутрь контейнера - гигабайт на каждый прогон.
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends \
      ca-certificates curl git openssh-client python3 python3-venv jq sqlite3 ripgrep unzip less procps \
      gcc libc6-dev \
 && rm -rf /var/lib/apt/lists/*

# ── ДВИЖОК ───────────────────────────────────────────────────────────────────
# Ставится КОММИТОМ, а не "последним": последний выходит по нескольку раз в
# день, и образ, собранный дважды подряд, оказывался разным. Коммит передаёт
# build-image.sh, читая его с хоста - так снаружи и внутри работает один движок.
RUN python3 -m venv /opt/medulla \
 && /opt/medulla/bin/pip install --no-cache-dir -q \
      "git+https://github.com/skopanev/medulla.git" \
 && ln -s /opt/medulla/bin/medulla /usr/local/bin/medulla
# И ЗАПРЕТ САМООБНОВЛЕНИЯ. init-docker.sh, который монтирует медулла, на КАЖДОМ
# старте тянет main и ставит его поверх - для образа с плавающей версией это
# лечение, для нашего пина на коммит хоста это отмена пина: контейнер уехал бы
# на HEAD, а проверка версий в run.sh отрабатывает ДО старта и этого не увидит.
# Обновление приходит пересборкой, и только ей.
ENV MEDULLA_UPGRADE_ON_START=0

# ── ХАРНЕССЫ ─────────────────────────────────────────────────────────────────
# Каналом, а не версией: claude - stable, тот же, что объявлен в настройках
# полосы ("autoUpdatesChannel": "stable"). У codex канала stable нет, есть
# latest и alpha.
RUN npm i -g --silent "@anthropic-ai/claude-code@stable" "@openai/codex@latest" "opencode-ai@latest"

# ── ИНСТРУМЕНТЫ ──────────────────────────────────────────────────────────────
# CBM: предполёт по графу кода. Работает НАТИВНО, а не через мост к хосту -
# полоса получает сам граф, а не отчёт о нём.
RUN a="$(cat /tmp/arch)"; set -eux; \
    curl -fsSL "https://github.com/DeusData/codebase-memory-mcp/releases/latest/download/codebase-memory-mcp-linux-${a}.tar.gz" \
      -o /tmp/cbm.tgz \
 && tar -xzf /tmp/cbm.tgz -C /tmp \
 && install -m 755 "$(find /tmp -maxdepth 2 -type f -name codebase-memory-mcp | head -1)" /usr/local/bin/codebase-memory-mcp \
 && rm -rf /tmp/cbm.tgz

# RTK: переписывает команды оболочки в компактный эквивалент. Замер на хосте -
# 123 тысячи команд, сэкономлено 66.9% вывода. Кодер делает по три десятка
# вызовов за прогон, и это прямая экономия его контекста.
RUN a="$(cat /tmp/arch)"; set -eux; \
    case "$a" in arm64) asset="rtk-aarch64-unknown-linux-gnu" ;; \
                 *)     asset="rtk-x86_64-unknown-linux-musl" ;; esac; \
    curl -fsSL "https://github.com/rtk-ai/rtk/releases/latest/download/${asset}.tar.gz" \
      -o /tmp/rtk.tgz \
 && tar -xzf /tmp/rtk.tgz -C /tmp \
 && install -m 755 "$(find /tmp -maxdepth 2 -type f -name rtk | head -1)" /usr/local/bin/rtk \
 && rm -rf /tmp/rtk.tgz

# NTK: тикеты. Публичная загрузка, ключ прокидывается при запуске.
# БЕЗ ВЕРСИИ НАМЕРЕННО: ntk должен быть свежим, эндпоинт без параметра отдаёт
# новейший. Две сборки в разные дни несут разный ntk - это замысел, не изъян.
# Перевод архитектуры здесь больше не нужен: раньше /tmp/arch с дебиановским
# amd64 давал 404 (ntk публиковался как linux-x86_64), и сборка на linux/amd64
# падала. С 0.5.70 служба читает amd64, x64, x86-64 как x86_64 и aarch64 как
# arm64 - проверено: оба имени отдают один объект, sha256 8d73a56b5ce3a3ad.
RUN a="$(cat /tmp/arch)"; \
    curl -fsSL "https://ntk.otion.us/v1/download?platform=linux-${a}" -o /usr/local/bin/ntk \
 && chmod 755 /usr/local/bin/ntk

# ── ПРОСЛОЙКИ ────────────────────────────────────────────────────────────────
# equill - бинарь macOS; внутри он может быть только клиентом моста к хосту.
COPY lane/bridge/equill-shim.sh /usr/local/bin/equill
# Шина: сюда едет ТОЛЬКО прослойка, без клиента. Клиент - полный диспетчер, и
# имя отправителя в нём объявляется само: одна переменная окружения - и тело
# говорит от чужого лица, в контейнере, где согласования пропущены.
COPY lane/bridge/agentbus-shim.sh /usr/local/bin/agentbus
RUN chmod 755 /usr/local/bin/equill /usr/local/bin/agentbus

# ПОЛЬЗОВАТЕЛЬ С UID ХОСТА, А НЕ С ПРОИЗВОЛЬНЫМ. Репозитории монтируются с
# хоста, и git отказывается работать с чужим по владельцу деревом:
# "fatal: detected dubious ownership in repository at /workspace/<repo>" - на
# этом встал fetch, origin/<ветка> не появился, и узел доложил NO_TARGET_BRANCH.
# Собирать так: docker build --build-arg USER_UID=$(id -u) -t medulla-crew .
# Если uid уже занят (в node:24 это node с 1000), переименовываем существующего,
# а не заводим второго - так же делает сама медулла в своём базовом образе.
ARG USER_UID=501
RUN if getent passwd ${USER_UID} >/dev/null; then \
      existing="$(getent passwd ${USER_UID} | cut -d: -f1)"; \
      usermod -l medulla "$existing"; \
      usermod -d /home/medulla -m medulla; \
      # usermod -l переименовывает ПОЛЬЗОВАТЕЛЯ, но не его группу: в node:24
      # uid 1000 это node:node, и после переименования chown medulla:medulla
      # падает на "invalid group". Видно только там, где uid хоста совпал с
      # существующим - на маке с uid 501 срабатывает ветка useradd, которая
      # заводит группу сама.
      groupmod -n medulla "$(id -gn medulla)" 2>/dev/null || true; \
    else \
      useradd -m -u ${USER_UID} -s /bin/bash medulla; \
    fi
USER medulla

# КАТАЛОГИ ДОМА СОЗДАЮТСЯ ЗАРАНЕЕ, И ЭТО НЕ КОСМЕТИКА. Медулла монтирует внутрь
# отдельные ФАЙЛЫ - ~/.local/bin/claude, ~/.config/ntk и прочее, - а Docker
# создаёт недостающие родительские каталоги от ROOT. После этого init-docker.sh
# не может сделать mkdir $HOME/.local/share и раскладка учётных данных падает.
RUN mkdir -p /home/medulla/.local/bin /home/medulla/.local/share \
             /home/medulla/.config /home/medulla/.cache /home/medulla/.medulla \
 && chown -R medulla:medulla /home/medulla

# agy - третье место панели. Без него expert_review падал ЦЕЛИКОМ: два места
# из трёх не стартовали ("binary not on PATH"), синтез не получал единогласия и
# выдавал REJECT на каждом круге. Полоса сожгла три раунда работы кодера на
# переделку того, что никто не смотрел, и ушла в TOO_MANY_ROUNDS.
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash

# Хуки репозиториев ходят через bun; без него посадка падала на pre-commit.
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/home/medulla/.bun/bin:/home/medulla/.local/bin:${PATH}"

# GIT ДОЛЖЕН ПРИНЯТЬ ПРИМОНТИРОВАННЫЕ РЕПОЗИТОРИИ. Docker Desktop отдаёт тома с
# владельцем root, и git отказывается: "fatal: detected dubious ownership in
# repository at /workspace/<repo>" - fetch не проходит, origin/<ветка> не
# появляется, узел докладывает NO_TARGET_BRANCH. Подгонка uid этого НЕ решает:
# владелец внутри всё равно root. Базовый образ медуллы нёс ровно эти
# переменные, и с ними полоса работала; при отказе от базы они потерялись.
ENV GIT_CONFIG_COUNT=2 \
    GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0=/workspace \
    GIT_CONFIG_KEY_1=safe.directory GIT_CONFIG_VALUE_1=*

# ЦЕПЬЮ к /mnt/init-docker.sh, не заменой: он раскладывает учётные данные.
# Файл монтирует медулла при запуске, поэтому его здесь нет и быть не должно.
COPY --chown=medulla:medulla lane/bin/entrypoint.sh /usr/local/bin/lane-entrypoint.sh
USER root
RUN chmod 755 /usr/local/bin/lane-entrypoint.sh
USER medulla
ENTRYPOINT ["/usr/local/bin/lane-entrypoint.sh"]
