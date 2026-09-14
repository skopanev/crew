#!/usr/bin/env bash
set -euo pipefail
usage() {
  cat >&2 <<'USAGE'
usage: run.sh --ticket-id <id> --project <ntk workspace> --mount-rw <repo>
              --cbm-store <dir>
              [--module <module>] [--mount-ro <repo>]... [--ssh-dir <dir>]
              [extra medulla args...]

  --mount-rw  the git repository the ticket is implemented in. EXACTLY ONE:
              the lane writes in one place, and both the landing check and the
              out-of-module verdict depend on that.
  --cbm-store the codebase-memory index directory. The lane gets a COPY of it,
              never the directory itself, and refuses to start if the copy does
              not open and answer.
  --module    ticket module; read from ntk when omitted
  --mount-ro  another repository to mount READ-ONLY, for scope. Repeatable.
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
# ПЕЧАТАЕМ С ВОЗВРАТОМ КАРЕТКИ. В панели терминал оказывается без преобразования
# \n в \r\n, и обычный echo уводит вывод лесенкой: строка опускается, но курсор
# остаётся там же. Медулла печатает свои строки сама и ровно, наши - нет.
say() { printf '%s\r\n' "$*" >&2; }
# Комнаты и курьер - у каждого свои, в общий репозиторий им нельзя.
# Файла нет - полоса работает молча. Образец: lane/local.env.example
[ -f "$WORKFLOW_DIR/local.env" ] && . "$WORKFLOW_DIR/local.env" || true
# Вне дерева инструментов: этого требует --cwd-ro.
RUNS_FOLDER="${LANE_RUNS_FOLDER:-$HOME/.medulla/lane-runs}"
mkdir -p "$RUNS_FOLDER"
# ФИЗИЧЕСКИЙ ПУТЬ, А НЕ ЧЕРЕЗ СИМЛИНК. Медулла монтирует каталог прогонов по
# разрешённому пути, и если ~/.medulla - симлинк, внутри контейнера он лежит
# под другим именем. LANE_WT_ROOT уезжал со старым: узел получал
# "mkdir: cannot create directory /Users: Permission denied".
RUNS_FOLDER="$(cd "$RUNS_FOLDER" && pwd -P)"
# ДЕРЕВЬЯ ВНЕ РЕПОЗИТОРИЯ: внутри его собственные проверки сканировали их как
# свой исходник и валили КАЖДЫЙ коммит в том чекауте, не только наш.
WT_ROOT="$RUNS_FOLDER/worktrees"
mkdir -p "$WT_ROOT"
# ОДИН уровень: лишний отдал бы в /workspace весь каталог проектов.
TOOLING_ROOT="$(cd "$WORKFLOW_DIR/.." && pwd)"

ticket="" project="" repo="" module="" ssh_dir="${LANE_SSH_DIR:-}" cbm_src=""
also=()
passthrough=()
while (( $# )); do
  case "$1" in
    --ticket-id) ticket="${2:-}"; shift 2 ;;
    --project) project="${2:-}"; shift 2 ;;
    # Ровно ОДИН: на этом держатся и проверка посадки, и проверка модуля.
    --mount-rw)
      [ -z "$repo" ] || { say "run.sh: --mount-rw задан дважды: $repo и ${2:-}"
                          say "        полоса пишет в ОДИН репозиторий; остальные через --mount-ro"
                          exit 2; }
      repo="${2:-}"; shift 2 ;;
    --module) module="${2:-}"; shift 2 ;;
    --mount-ro) also+=("${2:-}"); shift 2 ;;
    --ssh-dir) ssh_dir="${2:-}"; shift 2 ;;
    --cbm-store) cbm_src="${2:-}"; shift 2 ;;
    -h|--help) usage ;;
    *) passthrough+=("$1"); shift ;;
  esac
done
[[ -n "$ticket"  ]] || { say "run.sh: --ticket-id is required"; usage; }
[[ -n "$project" ]] || { say "run.sh: --project is required"; usage; }
[[ -n "$repo"    ]] || { say "run.sh: --mount-rw is required"; usage; }
[[ -n "$cbm_src" ]] || { say "run.sh: --cbm-store is required"; usage; }

[[ -d "$repo/.git" || -f "$repo/.git" ]] || {
  say "run.sh: --mount-rw is not a git repository: $repo"
  say "        (it must be the repo itself, not the directory that holds several)"
  exit 2
}
repo="$(cd "$repo" && pwd -P)"
project_dir="/workspace/$(basename "$repo")"

if [[ -e "$TOOLING_ROOT/$(basename "$repo")" ]]; then
  say "run.sh: $TOOLING_ROOT/$(basename "$repo") exists, and the mount would hide it inside"
  say "        the container. Rename one of the two, or mount from elsewhere."
  exit 2
fi

if ! ticket_json="$(cd "$repo" && ntk show "$ticket" -W "$project" --json 2>&1)"; then
  say "run.sh: ${ticket_json%%$'\n'*}"
  say "run.sh: ticket $ticket does not exist in workspace $project - nothing to run"
  exit 2
fi
# --module СВЕРЯЕТ, а не подменяет: модуль принадлежит тикету.
stored="$(jq -r '.module // empty' <<<"$ticket_json" 2>/dev/null || true)"
if [[ -n "$module" ]]; then
  if [[ -z "$stored" ]]; then
    say "run.sh: ticket $ticket declares no module, and --module cannot supply one."
    say "        Set the module on the ticket; the launcher only asserts it."
    exit 2
  fi
  if [[ "$module" != "$stored" ]]; then
    say "run.sh: --module disagrees with the ticket."
    say "        ticket $ticket says: $stored"
    say "        --module says:       $module"
    say "        Refusing before any side effect. Fix the ticket or drop --module."
    exit 2
  fi
  say "run.sh: module asserted: $stored"
fi
module="$stored"
# Без модуля охват судят по границе, которой нет, И память молчит: хуку нужны
# все EQUILL_* или ни одного, а EQUILL_MODULE один из них.
if [[ -z "$module" ]]; then
  say "run.sh: ticket $ticket declares no module."
  say "        A lane judges scope against the module and loads its contract by it;"
  say "        with neither, it would work confidently against a boundary nobody drew."
  say "        Set the module on the ticket, then run this again."
  exit 2
fi

mounts=(--mount-rw "$repo")

for extra in ${also[@]+"${also[@]}"}; do
  [[ -d "$extra" ]] || { say "run.sh: --mount-ro is not a directory: $extra"; exit 2; }
  extra="$(cd "$extra" && pwd -P)"
  base="$(basename "$extra")"
  [[ "$extra" != "$repo" ]] || continue
  if [[ -e "$TOOLING_ROOT/$base" ]]; then
    say "run.sh: $TOOLING_ROOT/$base exists; --mount-ro $extra would hide it inside"
    exit 2
  fi
  # fetch, НИКОГДА pull: в этих деревьях могут сидеть другие полосы.
  if git -C "$extra" rev-parse --git-dir >/dev/null 2>&1; then
    git -C "$extra" fetch --quiet --all --prune 2>/dev/null \
      && say "run.sh: fetched $base" \
      || say "run.sh: could not fetch $base - it travels as it is"
  fi
  mounts+=(--mount "$extra")
done
git_ssh=""
# НЕ ЗАКРЫТО. Ключ с правом ЗАПИСИ попадает в окружение КАЖДОГО узла, включая
# агентные (engine_vars.py:36), - агент способен запушить мимо панели. Запрет
# Bash(*git push*) прикрывает случайность, границей не является: сверка идёт по
# строке команды. Граница - разделение ключей; принято сознательно ради первой
# посадки.
if [[ -f "$ssh_dir/id_ed25519" ]]; then
  mounts+=(--mount "$ssh_dir")
  ssh_in="/workspace/$(basename "$ssh_dir")"
  git_ssh="ssh -F /dev/null -i $ssh_in/id_ed25519 -o IdentitiesOnly=yes"
  git_ssh+=" -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$ssh_in/known_hosts"
else
  say "run.sh: no key at $ssh_dir/id_ed25519 - git fetch will fail at create_worktree"
  say "        put the lane's deploy key there (and nothing else), or pass --ssh-dir"
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

export MEDULLA_IMAGE="${MEDULLA_IMAGE:-medulla-crew:latest}"
export MEDULLA_BRIDGE="${MEDULLA_BRIDGE:-/tmp/medulla-bridge}"

# КЛОН индекса, не индекс: другой inode - блокировка SQLite не идёт через
# границу монтирования, и снимок застывает на старте.
# Имя УНИКАЛЬНО НА ПРОГОН: по одному тикету второй запуск снёс бы индекс уже
# работающей полосы.
cbm_clone="$MEDULLA_BRIDGE/cbm-$ticket-$$-$(date +%s)"
cbm_ok=0
# Имя проекта в индексе выводится из абсолютного пути репозитория.
cbm_probe_projects="$(printf %s "$repo" | sed 's|^/||; s|/|-|g')"
for _e in ${also[@]+"${also[@]}"}; do
  [ -d "$_e" ] || continue
  cbm_probe_projects="$cbm_probe_projects $(cd "$_e" && pwd -P | sed 's|^/||; s|/|-|g')"
done
# СПИСОК НА ПЕРЕИНДЕКСАЦИЮ: только те репы, что сдвинулись с прошлого прогона.
# Отпечаток - HEAD после fetch; метка лежит в каталоге прогонов, то есть у нас,
# а не рядом с чужим хранилищем. Совпало - индекс свежий, тратить 20 секунд не
# на что; разошлось - догоняем именно эту репу.
cbm_index_list=""
cbm_marks="$RUNS_FOLDER/.cbm-marks"; mkdir -p "$cbm_marks"
for r in "$repo" ${also[@]+"${also[@]}"}; do
  [ -d "$r/.git" ] || [ -f "$r/.git" ] || continue
  pr="$(printf %s "$r" | sed 's|^/||; s|/|-|g')"
  fp="$(git -C "$r" rev-parse HEAD 2>/dev/null || echo unknown)"
  if [ "$fp" = "$(cat "$cbm_marks/$pr" 2>/dev/null)" ]; then
    say "run.sh: $(basename "$r") - индекс свежий ($fp)"
  else
    cbm_index_list="$cbm_index_list $pr=/workspace/$(basename "$r")"
    # Метка ставится ПОСЛЕ успеха, а не сейчас: проставь её здесь, и провалившаяся
    # индексация навсегда объявила бы репу свежей.
    cbm_pending_marks="${cbm_pending_marks:-} $pr=$fp"
    say "run.sh: $(basename "$r") сдвинулся - переиндексируем"
  fi
done

if [[ -d "$cbm_src" ]]; then
  rm -rf "$cbm_clone"
  # Без отката в существующий каталог: cp -R вложил бы хранилище глубже.
  if cp -Rc "$cbm_src" "$cbm_clone" 2>/dev/null; then cbm_ok=1
  else rm -rf "$cbm_clone"; cp -R "$cbm_src" "$cbm_clone" 2>/dev/null && cbm_ok=1; fi
fi
# Закрыто ДО заявки: проверяем не "каталог есть", а "копия отвечает".
if (( cbm_ok )); then
  # ПУТИ ПОД КОНТЕЙНЕР: search_code это grep по projects.root_path, а там путь
  # ХОСТА - внутри grep честно вернёт пусто. Правим в КЛОНЕ.
  for db in "$cbm_clone"/*.db; do
    [ -e "$db" ] || continue
    for pair in "$repo:$project_dir" ${also[@]+"${also[@]}"}; do
      src="${pair%%:*}"; [ -d "$src" ] || continue
      sqlite3 "$db" "UPDATE projects SET root_path='/workspace/$(basename "$src")' WHERE root_path='$src';" 2>/dev/null || true
    done
  done

  # cp каталога не атомарен для живой SQLite: битая база проходит list_projects
  # и падает на первом search_graph в середине прогона. Окружение проверки - ТО
  # ЖЕ, что у узлов, и репы монтируются сюда же, иначе проверяем пустоту.
  probe_mounts=(-v "$repo:/workspace/$(basename "$repo"):ro")
  for _e in ${also[@]+"${also[@]}"}; do
    [ -d "$_e" ] && probe_mounts+=(-v "$_e:/workspace/$(basename "$_e"):ro")
  done
  if docker run --rm --entrypoint bash -v "$cbm_clone:$cbm_clone" "${probe_mounts[@]}" \
       -e CBM_CACHE_DIR="$cbm_clone" -e CBM_ALLOWED_ROOT=/workspace \
       -e CBM_PROBE_PROJECTS="$cbm_probe_projects" \
       -e CBM_INDEX_LIST="$cbm_index_list" \
       "$MEDULLA_IMAGE" -c '
         # ДОГОНЯЕМ ТОЛЬКО ТО, ЧТО СДВИНУЛОСЬ. Список считает хост: он только
         # что сделал fetch и знает отпечатки. Пусто - значит всё свежее.
         # Замер: база finik-app не писалась СУТКИ при живом демоне, а
         # index_status всё это время отвечал "ready" - свежесть он не
         # показывает вовсе, и разведчик тратил шесть обращений из восьми на
         # проверку покрытия вместо поиска.
         # --name ОБЯЗАТЕЛЕН: имя проекта выводится из пути, а внутри репа лежит
         # в /workspace/<имя>, и без него завёлся бы ВТОРОЙ проект вместо
         # обновления существующего. Пишем в КЛОН, хостовое хранилище не трогаем.
         for pair in $CBM_INDEX_LIST; do
           codebase-memory-mcp cli index_repository --repo-path "${pair#*=}" \
             --name "${pair%%=*}" --mode fast >/dev/null 2>&1 \
             || say "index_repository: ${pair%%=*} не отработал - идём на том, что есть"
         done
         for db in "$CBM_CACHE_DIR"/*.db; do
           [ -e "$db" ] || continue
           [ "$(sqlite3 "$db" "PRAGMA quick_check;" 2>/dev/null | head -1)" = ok ] || {
             say "torn: $db"; exit 1; }
         done
         # Спрашиваем то, чего в исходниках НЕ МОЖЕТ не быть, и требуем
         # совпадений - по КАЖДОЙ репе: ремап мог не примениться, sqlite молчит.
         ok=1
         for pr in $CBM_PROBE_PROJECTS; do
           codebase-memory-mcp cli search_code --project "$pr" --pattern import \
             --mode files 2>/dev/null | grep -qE "\"total_grep_matches\":[1-9]" \
             || { say "index unusable for $pr"; ok=0; }
         done
         [ "$ok" = 1 ]' 2>/dev/null; then
    for m in ${cbm_pending_marks:-}; do printf '%s' "${m#*=}" > "$cbm_marks/${m%%=*}"; done
    say "run.sh: codebase memory on ($cbm_clone)"
  else
    cbm_ok=0
    say "run.sh: the index clone does not answer - a torn copy, or a store the"
    say "        image cannot open. Refusing: a ticket needs the graph."
  fi
fi
if (( ! cbm_ok )); then
  rm -rf "$cbm_clone"
  say "run.sh: no usable codebase index at $cbm_src - refusing before the claim."
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
    # Роль контракта - на узле; роль ПАМЯТИ одна на прогон (29 уроков против
    # одного под medulla-coder).
    --var "EQUILL_MEMORY_ROLE=lane"
    # Тикетные правила узлу не адресованы. Коммуникационные так не убрать: у
    # них координаты rules нет вовсе, значит они подстановочные.
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
  say "run.sh: memory on (equill bridge pid $(cat "$bridge_dir/bridge.pid"))"
else
  [[ -n "$module" ]] || say "run.sh: no module - memory stays off (the hook needs every EQUILL_* or none)"
  say "run.sh: memory off - equill bridge not running"
fi

# Имя на шине назначается ЗДЕСЬ и внутрь не едет: vars попадают в окружение
# агентных тел, а значит имя оттуда можно перечитать и переобъявить.
bus_from="$(printf 'lane-%s' "$project" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9-]/-/g')"

# Мост шины: комната, имя и список получателей живут на ЭТОЙ стороне.
# ПО ПРОЕКТУ: на общем пидфайле вторая полоса слала уведомления под именем и в
# комнату ПЕРВОЙ. От намеренного захода в чужой каталог это не ограждает -
# нужен помонтажный монтаж, и это к медулле.
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
  say "run.sh: bus on (bridge pid $(cat "$bus_dir/bridge.pid"), as $bus_from)"
else
  # Отказ, а не предупреждение: шина - единственный выход. Без неё полоса
  # возьмёт тикет и не сможет сказать, чем кончила. Проверка ДО заявки.
  say "run.sh: bus bridge did not start - refusing, because every outcome leaves through it."
  say "        log: $MEDULLA_BRIDGE/bus-bridge.log"
  exit 2
fi

cd "$TOOLING_ROOT"
# --cwd-ro: иначе агент правит свой же workflow.yaml, хук памяти и скрипт
# посадки - не прошедший панель может отредактировать правила панели.
# Рабочий репозиторий - отдельное монтирование, остаётся записываемым.
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
