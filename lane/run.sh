#!/usr/bin/env bash
set -euo pipefail
usage() {
  cat >&2 <<'USAGE'
usage: run.sh --ticket <id> --project <ntk workspace> --repo <host path to repo>
              [--module <module>] [--also <repo>]... [--ssh-dir <dir>]
              [extra medulla args...]

  --repo     host path of the git repository the ticket is implemented in,
             e.g. ~/Projects/<org>/<repo>
  --module   ticket module; read from ntk when omitted
  --also     another repository to mount READ-ONLY, for scope. Repeatable.
             The lane writes only in --repo; these are there to be read.
  --ssh-dir  directory holding ONLY the lane's git key, as id_ed25519, plus an
             optional known_hosts. No default: landing needs a key and a
             made-up path that nobody created is worse than none. The whole
             directory is what the agent can read, so nothing else belongs in it.

Anything after the known flags is passed to medulla unchanged, so --validate,
--dry-run, --resume and --node work as usual.
USAGE
  exit 2
}

WORKFLOW_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# МЕСТНЫЕ ЗНАЧЕНИЯ ОТДЕЛЬНО ОТ КОДА: куда докладывать и кому эскалировать - своё
# у каждого, и в общий репозиторий им нельзя. Файла нет - полоса работает, просто
# молча: пустая комната означает "никому не докладывать", а не ошибку.
# Образец рядом: lane/local.env.example
[ -f "$WORKFLOW_DIR/local.env" ] && . "$WORKFLOW_DIR/local.env" || true
# Outside the tooling tree: --cwd-ro requires it, and a run history written into
# the repository it reviews is the repository reviewing its own record.
RUNS_FOLDER="${LANE_RUNS_FOLDER:-$HOME/.medulla/lane-runs}"
mkdir -p "$RUNS_FOLDER"
# РАБОЧИЕ ДЕРЕВЬЯ ЖИВУТ ЗДЕСЬ, А НЕ ВНУТРИ РЕПОЗИТОРИЯ. Я клал их в
# <repo>/.worktrees - и проверки репозитория начали сканировать их как свой
# исходник: check-legacy-ledger-identifiers нашёл в нашем дереве СВОЙ ЖЕ файл
# со списком запрещённых образцов и завалил КАЖДЫЙ коммит в том чекауте, не
# только наш. Флот держит деревья уровнем выше репозитория; у нас уровень выше
# это смонтированный корень инструментов, тоже не место.
# Каталог прогонов уже смонтирован с хоста: дерево переживает контейнер, видно
# с хоста и невидимо для проверок репозитория.
WT_ROOT="$RUNS_FOLDER/worktrees"
mkdir -p "$WT_ROOT"
# ОДИН уровень, а не два: воркфлоу лежит в <repo>/lane. Ошибка здесь стоит
# дорого - корень монтируется в контейнер как /workspace, и лишний уровень
# отдал бы туда ВЕСЬ каталог проектов: чужие репозитории, ключи, рабочие
# деревья других полос.
TOOLING_ROOT="$(cd "$WORKFLOW_DIR/.." && pwd)"

ticket="" project="" repo="" module="" ssh_dir="${LANE_SSH_DIR:-}"
also=()
passthrough=()
while (( $# )); do
  case "$1" in
    --ticket|--ticket_id) ticket="${2:-}"; shift 2 ;;
    --project|--project_name) project="${2:-}"; shift 2 ;;
    --repo|--project_dir) repo="${2:-}"; shift 2 ;;
    --module|--module_name) module="${2:-}"; shift 2 ;;
    --also) also+=("${2:-}"); shift 2 ;;
    --ssh-dir) ssh_dir="${2:-}"; shift 2 ;;
    -h|--help) usage ;;
    *) passthrough+=("$1"); shift ;;
  esac
done
[[ -n "$ticket"  ]] || { echo "run.sh: --ticket is required" >&2; usage; }
[[ -n "$project" ]] || { echo "run.sh: --project is required" >&2; usage; }
[[ -n "$repo"    ]] || { echo "run.sh: --repo is required" >&2; usage; }

[[ -d "$repo/.git" || -f "$repo/.git" ]] || {
  echo "run.sh: --repo is not a git repository: $repo" >&2
  echo "        (it must be the repo itself, not the directory that holds several)" >&2
  exit 2
}
repo="$(cd "$repo" && pwd -P)"
project_dir="/workspace/$(basename "$repo")"

if [[ -e "$TOOLING_ROOT/$(basename "$repo")" ]]; then
  echo "run.sh: $TOOLING_ROOT/$(basename "$repo") exists, and the mount would hide it inside" >&2
  echo "        the container. Rename one of the two, or mount from elsewhere." >&2
  exit 2
fi

if ! ticket_json="$(cd "$repo" && ntk show "$ticket" -W "$project" --json 2>&1)"; then
  echo "run.sh: ${ticket_json%%$'\n'*}" >&2
  echo "run.sh: ticket $ticket does not exist in workspace $project - nothing to run" >&2
  exit 2
fi
# --module ASSERTS, it does not override. The ticket owns its module; a launcher
# argument that silently replaced it could point a lane at a module the ticket
# does not claim, and a ticket with NO module could be concealed by supplying one.
# Checked here, before any mount, daemon or container exists.
stored="$(jq -r '.module // empty' <<<"$ticket_json" 2>/dev/null || true)"
if [[ -n "$module" ]]; then
  if [[ -z "$stored" ]]; then
    echo "run.sh: ticket $ticket declares no module, and --module cannot supply one." >&2
    echo "        Set the module on the ticket; the launcher only asserts it." >&2
    exit 2
  fi
  if [[ "$module" != "$stored" ]]; then
    echo "run.sh: --module disagrees with the ticket." >&2
    echo "        ticket $ticket says: $stored" >&2
    echo "        --module says:       $module" >&2
    echo "        Refusing before any side effect. Fix the ticket or drop --module." >&2
    exit 2
  fi
  echo "run.sh: module asserted: $stored" >&2
fi
module="$stored"
# A ticket with no module does not go to a lane, and this refuses rather than
# warns. Proceeding was the worst of the three options: the lane ran with
# module_name empty, so cbm_discovery was asked whether the work stays inside a
# module that does not exist - a coin toss whose OUT_OF_MODULE answer goes to
# triage - AND memory stayed off, because the hook needs every EQUILL_* or none
# and EQUILL_MODULE was one of them. So it ran without the contract while being
# judged against a boundary nobody had drawn.
#
# This is the same rule the old launcher asserts, and for the same reason: the
# ticket owns its module, and nothing downstream can supply what it lacks.
if [[ -z "$module" ]]; then
  echo "run.sh: ticket $ticket declares no module." >&2
  echo "        A lane judges scope against the module and loads its contract by it;" >&2
  echo "        with neither, it would work confidently against a boundary nobody drew." >&2
  echo "        Set the module on the ticket, then run this again." >&2
  exit 2
fi

# СОСЕДНИЕ РЕПОЗИТОРИИ ПОДКЛЮЧАЮТСЯ САМИ, а не по флагу, который надо вспомнить.
# Замерено на этом же тикете: разведчик вынес OUT_OF_MODULE и был прав по факту -
# значения жили в соседнем репозитории, которого в песочнице не было, - но полоса
# встала не потому, что работа вне модуля, а потому что соседнюю репу ей не дали.
# Модуль ограничивает, ГДЕ она пишет; читать она должна всё, что рядом.
# Пишет по-прежнему ровно в одно место: соседи монтируются только на чтение.
parent="$(dirname "$repo")"
for sib in "$parent"/*/; do
  sib="${sib%/}"
  [[ -e "$sib/.git" ]] || continue
  [[ "$sib" != "$repo" ]] || continue
  skip=""
  for a in ${also[@]+"${also[@]}"}; do [[ "$a" != "$sib" ]] || skip=1; done
  [[ -n "$skip" ]] || also+=("$sib")
done

mounts=(--mount-rw "$repo")

# Scope repositories, read-only. A lane that can read the app and the docs beside
# its own backend answers questions it would otherwise have to guess at; it still
# writes in exactly one place.
scope=()
for extra in ${also[@]+"${also[@]}"}; do
  [[ -d "$extra" ]] || { echo "run.sh: --also is not a directory: $extra" >&2; exit 2; }
  extra="$(cd "$extra" && pwd -P)"
  base="$(basename "$extra")"
  [[ "$extra" != "$repo" ]] || continue
  if [[ -e "$TOOLING_ROOT/$base" ]]; then
    echo "run.sh: $TOOLING_ROOT/$base exists; --also $extra would hide it inside" >&2
    exit 2
  fi
  # Fetched HERE, on the host: the mount is read-only, so the container cannot
  # refresh it. fetch only - never pull. These are live working trees that other
  # lanes may be sitting in, and moving one out from under them is not ours to do.
  # The working tree can therefore be behind; origin/<branch> is the fresh view.
  if git -C "$extra" rev-parse --git-dir >/dev/null 2>&1; then
    git -C "$extra" fetch --quiet --all --prune 2>/dev/null \
      && echo "run.sh: fetched $base" >&2 \
      || echo "run.sh: could not fetch $base - it travels as it is" >&2
  fi
  mounts+=(--mount "$extra")
  scope+=("/workspace/$base")
done
git_ssh=""
# РЕШИТЬ ОБЯЗАТЕЛЬНО. Сюда монтируется ключ, которым можно ПИСАТЬ в репозиторий,
# и он попадает в окружение КАЖДОГО тела узла, включая агентные: движок кладёт
# туда все переменные прогона (engine_vars.py:36). То есть агент, работающий с
# пропущенными разрешениями, физически способен запушить мимо панели — ровно так
# и уехал в ствол коммит, который приёмка отклонила.
#
# Запрет Bash(*git push*) в настройках прикрывает СЛУЧАЙНОСТЬ и не является
# границей: сопоставление идёт по строке команды, и смена инструмента его
# обходит (измерено: python3 создал файл, которого не мог создать запрещённый
# touch). Границей будет только разделение ключей — в контейнер read-only для
# fetch, запись в процессе хостового моста, куда агент не дотянется. Дизайн
# готов, исполнитель назначен, ждёт слова владельца.
#
# До тех пор это временное состояние, принятое сознательно ради первой посадки.
if [[ -f "$ssh_dir/id_ed25519" ]]; then
  mounts+=(--mount "$ssh_dir")
  ssh_in="/workspace/$(basename "$ssh_dir")"
  git_ssh="ssh -F /dev/null -i $ssh_in/id_ed25519 -o IdentitiesOnly=yes"
  git_ssh+=" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$ssh_in/known_hosts"
else
  echo "run.sh: no key at $ssh_dir/id_ed25519 - git fetch will fail at create_worktree" >&2
  echo "        put the lane's deploy key there (and nothing else), or pass --ssh-dir" >&2
fi

made=()
cleanup() {
  local d
  [[ -z "${cbm_clone:-}" ]] || rm -rf "$cbm_clone"
  for d in "${made[@]:-}"; do [[ -n "$d" ]] && rmdir "$d" 2>/dev/null || true; done
}
trap cleanup EXIT
for m in "$repo" "$ssh_dir" ${also[@]+"${also[@]}"}; do
  point="$TOOLING_ROOT/$(basename "$m")"
  [[ " ${mounts[*]} " == *" $m "* ]] || continue
  [[ -e "$point" ]] || { mkdir -p "$point" && made+=("$point"); }
done

export MEDULLA_IMAGE="${MEDULLA_IMAGE:-medulla-lane:latest}"
export MEDULLA_BRIDGE="${MEDULLA_BRIDGE:-/tmp/medulla-bridge}"

# CODEBASE MEMORY. The lane gets a CLONE of the host index, never the index.
# `cp -c` on APFS is copy-on-write: measured at 7ms and 0 bytes for 138MB.
# A clone is a different inode, so no SQLite lock crosses the macOS->Linux mount
# boundary, and it freezes at run start - the daemon reindexes trunk while the
# lane works, and a shared store would answer one question two ways.
#
# UNIQUE PER RUN, not per ticket: named by ticket alone, a second launch of the
# same ticket would `rm -rf` the index of the lane already running, and only
# afterwards learn from ntk that the ticket was taken. Found by qwen.
cbm_src="${LANE_CBM_STORE:-$HOME/.cache/skk-cbm/store}"
cbm_clone="$MEDULLA_BRIDGE/cbm-$ticket-$$-$(date +%s)"
cbm_ok=0
# Имя проекта в индексе выводится из абсолютного пути репозитория.
cbm_probe_projects="$(printf %s "$repo" | sed 's|^/||; s|/|-|g')"
for _e in ${also[@]+"${also[@]}"}; do
  [ -d "$_e" ] || continue
  cbm_probe_projects="$cbm_probe_projects $(cd "$_e" && pwd -P | sed 's|^/||; s|/|-|g')"
done
if [[ -d "$cbm_src" ]]; then
  rm -rf "$cbm_clone"
  # NO fallback into an existing destination: a partial `cp -Rc` leaves one, and
  # a plain `cp -R` would then nest the store one level deeper - a clone that
  # looks right and answers nothing.
  if cp -Rc "$cbm_src" "$cbm_clone" 2>/dev/null; then cbm_ok=1
  else rm -rf "$cbm_clone"; cp -R "$cbm_src" "$cbm_clone" 2>/dev/null && cbm_ok=1; fi
fi
# FAIL CLOSED before the claim. A ticket requires the codebase preflight,
# and a lane that starts without the graph repeats exactly what stopped the last
# run. The check is not "the directory exists" but "the copy opens and answers".
if (( cbm_ok )); then
  # ПУТИ ПЕРЕПИСЫВАЮТСЯ ПОД КОНТЕЙНЕР. search_code — это grep по projects.root_path
  # из базы; в индексе записан путь ХОСТА, а внутри код смонтирован в
  # /workspace/<имя>, поэтому grep честно возвращает ПУСТО. Именно поэтому в первом
  # сквозном прогоне разведка и кодер сделали 84 вызова Bash и НИ ОДНОГО к графу.
  # Нашёл qwen. Штатного ремапа у CBM нет — правим в КЛОНЕ, он живёт один прогон.
  for db in "$cbm_clone"/*.db; do
    [ -e "$db" ] || continue
    for pair in "$repo:$project_dir" ${also[@]+"${also[@]}"}; do
      src="${pair%%:*}"; [ -d "$src" ] || continue
      sqlite3 "$db" "UPDATE projects SET root_path='/workspace/$(basename "$src")' WHERE root_path='$src';" 2>/dev/null || true
    done
  done

  # Не "каталог открылся", а "каждая база цела и по ней реально отвечают".
  # cp каталога не атомарен для работающей SQLite: повреждённая база проекта
  # проходит list_projects и падает на первом search_graph в середине прогона.
  # Окружение проверки — ТО ЖЕ, что у узлов, иначе проверено другое.
  # Репозитории монтируются и в ПРОВЕРОЧНЫЙ контейнер, по тем же путям: после
  # ремапа индекс указывает на /workspace/<имя>, и без монтирования канарейка
  # проверяла бы пустоту вместо индекса.
  probe_mounts=(-v "$repo:/workspace/$(basename "$repo"):ro")
  for _e in ${also[@]+"${also[@]}"}; do
    [ -d "$_e" ] && probe_mounts+=(-v "$_e:/workspace/$(basename "$_e"):ro")
  done
  if docker run --rm --entrypoint bash -v "$cbm_clone:$cbm_clone" "${probe_mounts[@]}" \
       -e CBM_CACHE_DIR="$cbm_clone" -e CBM_ALLOWED_ROOT=/workspace \
       -e CBM_PROBE_PROJECTS="$cbm_probe_projects" \
       "$MEDULLA_IMAGE" -c '
         for db in "$CBM_CACHE_DIR"/*.db; do
           [ -e "$db" ] || continue
           [ "$(sqlite3 "$db" "PRAGMA quick_check;" 2>/dev/null | head -1)" = ok ] || {
             echo "torn: $db" >&2; exit 1; }
         done
         # КАНАРЕЙКА С НЕНУЛЕВЫМ ОТВЕТОМ. list_projects доказывал лишь, что
         # каталог открылся, и спокойно подтверждал индекс, из которого grep не
         # достаёт ничего — ровно то, что случилось в первом прогоне. Спрашиваем
         # то, чего в исходниках НЕ МОЖЕТ не быть, и требуем совпадений.
         # По КАЖДОМУ смонтированному репозиторию, а не только по главному:
         # ремап мог не примениться к scope-репозиториям, и sqlite молчит.
         ok=1
         for pr in $CBM_PROBE_PROJECTS; do
           codebase-memory-mcp cli search_code --project "$pr" --pattern import \
             --mode files 2>/dev/null | grep -qE "\"total_grep_matches\":[1-9]" \
             || { echo "index unusable for $pr" >&2; ok=0; }
         done
         [ "$ok" = 1 ]' 2>/dev/null; then
    echo "run.sh: codebase memory on ($cbm_clone)" >&2
  else
    cbm_ok=0
    echo "run.sh: the index clone does not answer - a torn copy, or a store the" >&2
    echo "        image cannot open. Refusing: a ticket needs the graph." >&2
  fi
fi
if (( ! cbm_ok )); then
  rm -rf "$cbm_clone"
  echo "run.sh: no usable codebase index at $cbm_src - refusing before the claim." >&2
  exit 2
fi

bridge_dir="$MEDULLA_BRIDGE/equill"
mkdir -p "$bridge_dir/req" "$bridge_dir/resp"
if [[ ! -f "$bridge_dir/bridge.pid" ]] || ! kill -0 "$(cat "$bridge_dir/bridge.pid" 2>/dev/null)" 2>/dev/null; then
  nohup bash "$WORKFLOW_DIR/bridge/equill-bridge.sh" >>"$MEDULLA_BRIDGE/equill-bridge.log" 2>&1 &
  disown || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [[ -f "$bridge_dir/bridge.pid" ]] && break
    sleep 0.2
  done
fi

equill_vars=()
if [[ -f "$bridge_dir/bridge.pid" ]] && kill -0 "$(cat "$bridge_dir/bridge.pid")" 2>/dev/null && [[ -n "$module" ]]; then
  equill_vars=(
    --var "EQUILL_STORE=${EQUILL_STORE:-$HOME/.equill/dev}"
    --var "EQUILL_ACTOR=lane"
    # Роль КОНТРАКТА ставится на узле и разная: medulla-coder не сажает.
    # Роль ПАМЯТИ одна на прогон, потому что урок про этот репозиторий верен
    # независимо от того, какой узел его читает. Замер: под lane 29 уроков,
    # под medulla-coder один.
    --var "EQUILL_MEMORY_ROLE=lane"
    # Узлу конвейера тикетные правила не адресованы: он не ведёт тикет, он
    # выполняет четыре шага и печатает сигнал. Координата убирает девять из них.
    # Семнадцать коммуникационных убрать отсюда НЕЛЬЗЯ: у них координаты rules
    # нет вовсе, значит они подстановочные и приходят при любом значении.
    # Чтобы ушли и они, правилам нужна координата — это к владельцу правил.
    --var "EQUILL_RULES=${EQUILL_RULES:-none}"
    --var "EQUILL_SESSION_PROFILE=${EQUILL_SESSION_PROFILE:-agent.context.target}"
    --var "EQUILL_PROMPT_PROFILE=${EQUILL_PROMPT_PROFILE:-agent.memory.hybrid}"
    --var "LANE_WT_ROOT=$WT_ROOT"
    --var "TELEGRAM_ROOM=${TELEGRAM_ROOM:-}"
    --var "TELEGRAM_TOPIC=${TELEGRAM_TOPIC:-}"
    --var "ESCALATION_ROOM=${ESCALATION_ROOM:-}"
    --var "ESCALATION_COURIER=${ESCALATION_COURIER:-}"
    --var "EQUILL_PROJECT=$project"
    --var "EQUILL_TICKET=$ticket"
    --var "EQUILL_MODULE=$module"
    --var "EQUILL_PM=${LANE_PM_ALIAS:-${project}-pm}"
  )
  echo "run.sh: memory on (equill bridge pid $(cat "$bridge_dir/bridge.pid"))" >&2
else
  [[ -n "$module" ]] || echo "run.sh: no module - memory stays off (the hook needs every EQUILL_* or none)" >&2
  echo "run.sh: memory off - equill bridge not running" >&2
fi

# The bus name is assigned HERE and never travels into the container as a var:
# vars reach every body's environment, agent bodies included, so a name passed
# inward is a name the agent can read and re-export. The bridge holds it instead.
bus_from="$(printf 'lane-%s' "$project" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g')"

# The bus bridge. Same shape as the equill one: the container writes a request,
# nothing in it speaks NATS. Room, identity, intent and the recipient allowlist
# all live on this side.
# PER PROJECT, not one for everybody. A second lane used to find the first
# lane's live pidfile, skip starting its own, and send every notification under
# the FIRST lane's identity and room - so a GM reading "from lane-<project>" was
# reading the wrong project's name on the wrong project's failure.
#
# What this does NOT do, and it should be said plainly: medulla mounts the whole
# bridge root at one path, writable, so a lane can still reach another lane's
# directory on purpose. This fixes the collision, which is an accident and
# happens whenever two lanes run at once; it does not fence a body that goes
# looking. That fence needs a per-run mount, which is medulla's to give.
bus_dir="$MEDULLA_BRIDGE/bus-$bus_from"
mkdir -p "$bus_dir/req" "$bus_dir/resp"
if [[ ! -f "$bus_dir/bridge.pid" ]] || ! kill -0 "$(cat "$bus_dir/bridge.pid" 2>/dev/null)" 2>/dev/null; then
  LANE_BUS_ROOM="${LANE_BUS_ROOM:-}" \
  LANE_BUS_FROM="$bus_from" \
  LANE_BUS_ALLOWED="${LANE_BUS_ALLOWED:-}" \
  LANE_BUS_DIR="$bus_dir" \
    nohup bash "$WORKFLOW_DIR/bridge/bus-bridge.sh" >>"$MEDULLA_BRIDGE/bus-bridge.log" 2>&1 &
  for _ in {1..30}; do
    [[ -f "$bus_dir/bridge.pid" ]] && break
    sleep 0.1
  done
fi
if [[ -f "$bus_dir/bridge.pid" ]] && kill -0 "$(cat "$bus_dir/bridge.pid" 2>/dev/null)" 2>/dev/null; then
  echo "run.sh: bus on (bridge pid $(cat "$bus_dir/bridge.pid"), as $bus_from)" >&2
else
  # Refusing rather than warning. The bus is the lane's only way out: every
  # outcome, success and failure alike, leaves through notify_*. A run started
  # without it claims a ticket and then cannot tell anyone what became of it -
  # which is the silent outcome this whole graph is built to prevent. Better to
  # not start than to start mute, and this is checked BEFORE the claim.
  echo "run.sh: bus bridge did not start - refusing, because every outcome leaves through it." >&2
  echo "        log: $MEDULLA_BRIDGE/bus-bridge.log" >&2
  exit 2
fi

# The engine inside the image and the engine on this machine must be the same
# one. The image used to run `medulla upgrade` at build time, so its version
# floated: every reading of render.py or the signal rules - mine, and both
# architects' - would have described an engine other than the one executing the
# nodes, and nobody would have known.
host_medulla="$(medulla --version 2>/dev/null | awk '{print $2}')"
img_medulla="$(docker run --rm --entrypoint bash "$MEDULLA_IMAGE" \
                 -lc 'medulla --version' 2>/dev/null | awk '{print $2}')"
# Fail CLOSED. Requiring both to be non-empty before comparing meant that an
# unreadable version - no docker, no image, a version string in another shape -
# skipped the check entirely and the run continued. That is fail-open on the one
# guard protecting every conclusion anybody drew about how this engine renders.
if [[ -z "$host_medulla" || -z "$img_medulla" ]]; then
  echo "run.sh: could not read the engine version (host '${host_medulla:-?}', image '${img_medulla:-?}')." >&2
  echo "        Refusing rather than skipping: this check is what makes the workflow's" >&2
  echo "        rules describe the engine that actually runs the nodes." >&2
  exit 2
fi
if [[ "$host_medulla" != "$img_medulla" ]]; then
  echo "run.sh: engine mismatch - host $host_medulla, image $img_medulla." >&2
  echo "        Rebuild the image, or pin it: every claim about rendering and" >&2
  echo "        signals was made against one of these, not both." >&2
  exit 2
fi

# CBM drifts differently from medulla: the host daemon updates itself, while the
# image pins a version at build. A store written by a newer daemon can carry a
# schema the image cannot read, and that surfaces as empty answers rather than
# an error. Named LOUDLY and not fatal: a graph one version behind is still a
# graph, and the degradation is already declared.
host_cbm="$(codebase-memory-mcp --version 2>/dev/null | awk '{print $2}')"
img_cbm="$(docker run --rm --entrypoint bash "$MEDULLA_IMAGE" \
             -c 'codebase-memory-mcp --version' 2>/dev/null | awk '{print $2}')"
if [[ -n "$host_cbm" && -n "$img_cbm" && "$host_cbm" != "$img_cbm" ]]; then
  echo "run.sh: CODEBASE MEMORY MISMATCH - host $host_cbm, image $img_cbm." >&2
  echo "        The index was written by the host build; the image reads it." >&2
  echo "        Update through the broker and rebuild before trusting the graph." >&2
fi

cd "$TOOLING_ROOT"
# --cwd-ro, and the runs folder OUTSIDE cwd because that flag requires it.
#
# Without this the agent - which runs with permissions skipped - has write access
# to the whole tooling tree mounted at /workspace: its own workflow.yaml, its
# memory hook, the landing script. An agent that cannot get past a review panel
# can edit the rules of the panel. Read-only cwd is what makes the prompt's
# instructions something it obeys rather than something it can amend.
#
# The repository under work is a SEPARATE mount and stays writable, so this costs
# the lane nothing: the worktree is container-local and .git is in that mount.
medulla \
  --docker \
  --cwd-ro \
  -w "${WORKFLOW_DIR#"$TOOLING_ROOT"/}" \
  --runs-folder "$RUNS_FOLDER" \
  "${mounts[@]}" \
  --var "cbm_cache_dir=$cbm_clone" \
  --var "ticket_id=$ticket" \
  --var "project_name=$project" \
  --var "project_dir=$project_dir" \
  --var "module_name=$module" \
  --var "GIT_SSH_COMMAND=$git_ssh" \
  --var "LANE_BUS_DIR=$bus_dir" \
  ${equill_vars[@]+"${equill_vars[@]}"} \
  ${passthrough[@]+"${passthrough[@]}"}
