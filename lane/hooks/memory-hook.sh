#!/usr/bin/env bash
set -uo pipefail
# The lane's memory hook. Self-contained: nothing here reaches into company/.
#
#   SessionStart      the contract, by coordinates (ticket, module, pm), once
#   UserPromptSubmit  retrieval on the user's actual message
#   PostToolUse     retrieval on what just happened, before the next model call
#
# Why the third one exists, counted on run 2026-09-11_11-21-28: implement_code
# made 100 model calls and 99 of them carried tool_use. SessionStart and
# UserPromptSubmit together reach exactly one of those 100.
jq_bin="${JQ_BIN:-jq}"
equill_bin="${EQUILL_BIN:-equill}"

input="$(cat 2>/dev/null || true)"
event="$("$jq_bin" -r '.hook_event_name // empty' <<<"$input" 2>/dev/null || true)"

# ЖУРНАЛ СОБЫТИЙ, ПЕРЕЖИВАЮЩИЙ КОНТЕЙНЕР. Единственный оставшийся вопрос -
# какие события вообще ДОХОДЯТ до неинтерактивного запуска. Документация на
# него не отвечает: она описывает событие, а не режим. Замер отвечает.
# MEDULLA_RUN_DIR смонтирован с хоста, значит запись переживёт контейнер и её
# можно будет прочитать после прогона.
printf '%s\t%s\n' "${event:-НЕТ_ИМЕНИ}" "${EQUILL_ROLE:-?}" \
  >> "${MEDULLA_RUN_DIR:-/tmp}/hook-events.log" 2>/dev/null || true

# ── НАПОМИНАНИЕ О СИГНАЛЕ ───────────────────────────────────────────────────
# Контракт приезжает ОДИН раз, на старте. Дальше идут часы работы: у кодера
# замерено 12 минут, 70 вызовов инструментов и 134 события хука - и к моменту,
# когда он писал итог, словарь сигналов был на другом конце пятисотстрочной
# расшифровки. Он закончил без тега, ушёл в __default__, и вся работа - 10
# правок и 2 новых файла в дереве контейнера - пропала.
# Сжатия при этом НЕ БЫЛО: SessionStart за прогон ровно один. Это разбавление,
# а не забывчивость.
# Эти 134 события возвращали пустоту. Теперь каждое несёт одну строку: чем
# заканчивать. Дешевле напоминания нет - канал уже есть и уже вызывается.
# ── STOP: НЕ ВЫПУСКАЕМ БЕЗ ТЕГА ─────────────────────────────────────────────
# Напоминание на каждый инструмент - мера статистическая. Stop - единственная
# детерминированная: он срабатывает, когда агент СЧИТАЕТ работу законченной, и
# умеет вернуть отказ, то есть заставить продолжить.
# Замер, ради которого это делается: кодер отработал 12 минут, сделал 10 правок
# и 2 новых файла, кончил кодом ноль и НЕ НАПЕЧАТАЛ ТЕГ. Узел ушёл в __default__,
# дерево жило в /tmp контейнера - вся работа пропала.
# stop_hook_active защищает от петли: отказ даётся РОВНО ОДИН раз, второй Stop
# пропускается. Лучше один лишний круг, чем потерянные двенадцать минут.
if [[ "$event" == Stop ]]; then
  active="$("$jq_bin" -r '.stop_hook_active // false' <<<"$input" 2>/dev/null || echo false)"

  # ТЕГ ПРОВЕРЯЕТСЯ, А НЕ ПРЕДПОЛАГАЕТСЯ. Раньше первый Stop блокировался
  # БЕЗУСЛОВНО: узел, честно напечатавший тег, всё равно платил лишний круг -
  # лишний вызов модели на каждом узле каждого прогона. Нашёл квен на ревью.
  # Расшифровка приходит в payload как transcript_path; смотрим хвост, где
  # лежит последнее сказанное. Не прочли - ведём себя как раньше: лучше лишний
  # круг, чем выпустить узел без сигнала.
  tagged=""
  tp="$("$jq_bin" -r '.transcript_path // empty' <<<"$input" 2>/dev/null || true)"
  if [[ -n "$tp" && -r "$tp" ]]; then
    tail -c 200000 "$tp" 2>/dev/null | grep -q '<signal:[A-Z_]\+>' && tagged=1
  fi
  # Выход прямой, а не через quiet: она объявлена ниже по файлу и на этой
  # строке ещё не существует - проверено трассировкой, "quiet: command not
  # found". Тег есть, добавлять нечего.
  if [[ -n "$tagged" ]]; then
    "$jq_bin" -cn --arg e "$event" \
      '{hookSpecificOutput:{hookEventName:$e,additionalContext:""}}'
    exit 0
  fi

  if [[ "$active" != true ]]; then
    # ПРОЦЕСС ПЕРЕЧИТЫВАЕТСЯ ЗАНОВО, а не берётся из головы сессии. К моменту
    # Stop контракт уехал на другой конец расшифровки - у кодера это 500 строк
    # и 12 минут назад. Здесь он отдаётся СВЕЖИМ и вплотную к моменту решения,
    # ровно по тому же правилу, по которому предполёт работает рядом с задачей,
    # а не на старте.
    # ПОЛЕ ЗАПИСИ, А НЕ КУСОК ОТРЕНДЕРЕННОГО ТЕКСТА. ends_when процесса и есть
    # словарь исходов - "признак завершения обязан называть то, чем завершение
    # проверяется". Берём его структурно, jq по полю: ни sed по markdown, ни
    # regex по заглавным буквам, ни второго источника правды.
    # И это одна строка вместо пяти килобайт отрендеренного контракта.
    finish=""
    if [[ -n "${EQUILL_STORE:-}" && -n "${EQUILL_ROLE:-}" ]]; then
      finish="$("$equill_bin" search --store "$EQUILL_STORE" --type agent.process.v1 \
                  --query "${EQUILL_PROCESS:-$EQUILL_ROLE}" --limit 5 --json 2>/dev/null \
                | "$jq_bin" -r --arg a "${EQUILL_PROCESS:-$EQUILL_ROLE}" \
                    '[.hits[]?.record.payload | select(.actor==$a) | .ends_when] | first // empty' \
                2>/dev/null || true)"
    fi
    # ends_when И ЕСТЬ ЭТО СООБЩЕНИЕ. Не список, из которого хук что-то
    # собирает, а готовый текст: требование, пример формы и имена исходов -
    # всё написано в процессе один раз. Хук печатает поле как есть.
    # Так у нас ОДИН источник: поменяется процесс - поменяется и то, что
    # видит агент, без единой правки здесь.
    reason="$finish"
    [[ -n "$reason" ]] || reason="Emit a signal from the list below with a briefly described result. Example: <signal:OK>your results</signal:OK>"
    "$jq_bin" -cn --arg r "$reason" '{decision:"block",reason:$r}'
    exit 0
  fi
fi



# PostToolUse ОТДАЁТ ОДИН ИНСТРУМЕНТ, а весь разбор ниже написан под список
# `tool_calls[]`. Нормализуем здесь, один раз, чтобы не править четыре jq-запроса
# и не разъехаться между ними.
#
# ЗАРЕГИСТРИРОВАНЫ ОБА СОБЫТИЯ, И ЭТО НЕ ПЕРЕСТРАХОВКА. PostToolBatch
# задокументирован - срабатывает один раз после ПАРТИИ инструментов, вход
# tool_calls[]. PostToolUse отдаёт ОДИН инструмент. Схемы разные, поддержка
# зависит от версии клиента, и проверяется она замером, а не чтением файлов.
#
# Я утверждал, что PostToolBatch "не существует", на том основании, что имя
# встречается только в этих двух файлах. Это вывод из отсутствия, а не замер;
# Equill PM показал документацию. Настоящей причиной пустой квитанции было
# другое - блок записи стоял ниже по файлу, за тремя `exit 0`, и управление
# до него не доходило.
if [[ "$event" == PostToolUse ]]; then   # PostToolBatch уже отдаёт список
  input="$("$jq_bin" -c 'if has("tool_calls") then . else
      . + {tool_calls: [ {tool_name: (.tool_name // ""),
                          tool_input: (.tool_input // {}),
                          tool_response: (.tool_response // "")} ]} end' \
    <<<"$input" 2>/dev/null || printf '%s' "$input")"
fi




# PostToolUse ОТДАЁТ ОДИН ИНСТРУМЕНТ, а весь разбор ниже написан под список
# `tool_calls[]`. Нормализуем здесь, один раз, чтобы не править четыре jq-запроса
# и не разъехаться между ними.
#
# ЗАРЕГИСТРИРОВАНЫ ОБА СОБЫТИЯ, И ЭТО НЕ ПЕРЕСТРАХОВКА. PostToolBatch
# задокументирован - срабатывает один раз после ПАРТИИ инструментов, вход
# tool_calls[]. PostToolUse отдаёт ОДИН инструмент. Схемы разные, поддержка
# зависит от версии клиента, и проверяется она замером, а не чтением файлов.
#
# Я утверждал, что PostToolBatch "не существует", на том основании, что имя
# встречается только в этих двух файлах. Это вывод из отсутствия, а не замер;
# Equill PM показал документацию. Настоящей причиной пустой квитанции было
# другое - блок записи стоял ниже по файлу, за тремя `exit 0`, и управление
# до него не доходило.
if [[ "$event" == PostToolUse ]]; then   # PostToolBatch уже отдаёт список
  input="$("$jq_bin" -c 'if has("tool_calls") then . else
      . + {tool_calls: [ {tool_name: (.tool_name // ""),
                          tool_input: (.tool_input // {}),
                          tool_response: (.tool_response // "")} ]} end' \
    <<<"$input" 2>/dev/null || printf '%s' "$input")"
fi

# ── КВИТАНЦИЯ О ПРЕДПОЛЁТЕ CBM ──────────────────────────────────────────────
# Квен доказал каузально, на одной модели, одном образе и одном индексе: без
# строки рядом с задачей узел делал 0/2 вызова CBM и уходил в Bash; со строкой -
# 2/2 search_code и 2/2 search_graph, все до Bash. Причина в ПОЛОЖЕНИИ правила:
# то, что пришло на SessionStart, планировщик инструментов читает как фон.
#
# Строку я поставил, но послушание промпту остаётся статистическим, а владелец
# просил "как часы". Поэтому факт вызова ЗАПИСЫВАЕТСЯ, и следующий узел судит
# по записи, а не по словам вердикта: вердикт может сослаться на CBM, ничего не
# вызвав, и отличить это можно только здесь.
#
# Пишется в /tmp намеренно: узлы полосы живут в одном контейнере и делят его.
#
# СТОИТ ЗДЕСЬ, В САМОМ НАЧАЛЕ, И ЭТО ИСПРАВЛЕНИЕ ПОСЛЕ ПРОГОНА 8ea6ec5c.
# Раньше блок лежал ниже по файлу, за несколькими `exit 0` - проверками на
# equill, на пусковые переменные, на событие. До него не доходило управление,
# квитанция оставалась пустой, и запрет остановил прогон, в котором разведка
# ЧЕСТНО сделала оба поиска: её вердикт перечисляет search_code с 23
# результатами. Счётчик не зависит ни от equill, ни от контракта - значит и
# стоять он обязан до всего, что может выйти.


emit() {
  "$jq_bin" -cn --arg e "$1" --arg c "$2" --arg w "${3:-}" \
    '{hookSpecificOutput:{hookEventName:$e,additionalContext:$c}}
     + if $w == "" then {} else {systemMessage:$w} end'
}
emit_fatal() {
  "$jq_bin" -cn --arg e "$1" --arg m "$2" \
    '{continue:false,stopReason:$m,systemMessage:$m,
      hookSpecificOutput:{hookEventName:$e,additionalContext:""}}'
}
quiet() { emit "${event:-Unknown}" ""; exit 0; }

case "$event" in SessionStart|UserPromptSubmit|PostToolUse|PostToolBatch|Stop) ;; *) quiet ;; esac
command -v "$jq_bin" >/dev/null 2>&1 || quiet
# A hook does not inherit the launching shell's PATH, and equill lives outside
# the default one. Looked for where it is actually installed before giving up -
# going quiet here would mean no contract and no memory, with nobody told.
if ! command -v "$equill_bin" >/dev/null 2>&1; then
  for c in "$HOME/.cargo/bin/equill" /usr/local/bin/equill \
           /opt/homebrew/bin/equill "$HOME/.local/bin/equill"; do
    [[ -x "$c" ]] || continue
    equill_bin="$c"; break
  done
fi
if ! command -v "$equill_bin" >/dev/null 2>&1; then
  msg="lane memory: equill not found on PATH - no contract, no memory"
  [[ "$event" != SessionStart ]] || { emit_fatal "$event" "$msg"; exit 0; }
  emit "$event" "" "$msg"; exit 0
fi

# All of the launch variables or none. A session with none was not started by a
# launcher and has no contract to load; a session with some was started by a
# launcher that got it wrong, and that must be loud rather than half-fed.
missing=()
for n in EQUILL_STORE EQUILL_ACTOR EQUILL_ROLE EQUILL_PROCESS EQUILL_RULES; do
  [[ -n "${!n:-}" ]] || missing+=("$n")
done
if (( ${#missing[@]} )); then
  [[ -n "${EQUILL_STORE:-}${EQUILL_ACTOR:-}${EQUILL_ROLE:-}${EQUILL_PROCESS:-}${EQUILL_RULES:-}" ]] || quiet
  if [[ "$event" == SessionStart ]]; then
    emit_fatal "$event" "lane memory: missing launch variables: ${missing[*]}"
  else
    emit "$event" "" "lane memory: missing launch variables: ${missing[*]}"
  fi
  exit 0
fi

ctx_args=(context --json --store "$EQUILL_STORE" --role "$EQUILL_ROLE"
          --process "$EQUILL_PROCESS" --format llm)
[[ -z "${EQUILL_PROJECT:-}" ]] || ctx_args+=(--project "$EQUILL_PROJECT")

# TWO ROLES, BECAUSE THEY ANSWER TWO QUESTIONS. The contract asks what this node
# is ALLOWED to do, and that differs per node - medulla-coder may not land.
# A lesson asks what this codebase has already taught us, and that is the same
# whoever is holding the keyboard: "scripts/*.test.ts are auto-discovered" is a
# fact about the repository, not about rank.
#
# Measured on one query against the live store:
#   role=lane           29 lessons
#   role=medulla-coder   1
#   role=medulla-qa      1
# Lessons carry `role: lane, pm` and the selector matches role as a SET, so the
# per-node roles I introduced to stop the lane landing on its own authority cut
# it off from the whole corpus at the same stroke. Retrieval asks as the lane.
memory_role="${EQUILL_MEMORY_ROLE:-$EQUILL_ROLE}"

# ── SessionStart: the contract ───────────────────────────────────────────────
if [[ "$event" == SessionStart ]]; then
  args=("${ctx_args[@]}"
        --profile "${EQUILL_SESSION_PROFILE:-agent.context.target}"
        --coordinate "rules=$EQUILL_RULES"
        # НА СТАРТЕ ОГРАНИЧЕНИЙ НЕТ, и это проверено, а не заявлено: контракт
        # medulla-coder это 19 записей и при бюджете 30, и при 1000, и при
        # 100000, degraded:false во всех трёх. Безлимита у equill нет, поэтому
        # стоит потолок заведомо выше всего, что может прийти. А если он всё же
        # когда-нибудь сработает — теперь об этом скажут: предупреждение об
        # усечении ниже раньше вычислялось и молча затиралось.
        --budget-records "${EQUILL_SESSION_BUDGET_RECORDS:-1000}")
  [[ -z "${EQUILL_TICKET:-}" ]] || args+=(--coordinate "ticket=$EQUILL_TICKET")
  [[ -z "${EQUILL_MODULE:-}" ]] || args+=(--coordinate "module=$EQUILL_MODULE")
  [[ -z "${EQUILL_PM:-}" ]]     || args+=(--coordinate "pm=$EQUILL_PM")

  # ПРАВИЛА ОТБИРАЮТСЯ ПО МОДУЛЮ, а не координатой rules. Замерено на живом
  # сторе: у всех комм-правил и у tools.rtk поле rules=null, то есть
  # подстановка, и они приходят под ЛЮБОЕ значение координаты - rules=tickets и
  # rules=tickets,comm дали побайтово одинаковые 4435 символов.
  #
  # Чего это стоило разведке: контракт 4719 символов, из них своих - роль,
  # цель, финиш и пять шагов - 1026. Остальные 3670, семьдесят восемь
  # процентов, это правила, которые роль физически не может исполнить: формат
  # сообщений владельцу и минимум получателей на шине у узла, у которого нет
  # ни шины, ни владельца; согласование превышения капа с PM у узла, который
  # не пишет тикеты; и tools.rtk уровня must - "prefix shell commands with
  # rtk" - при том что rtk в образе НЕТ вовсе, проверено запуском.
  #
  # --where отбирает по полю, а --strict НЕ ставится намеренно: без него
  # записи, у которых поля module нет вообще, остаются. Именно так выживает
  # собственный процесс роли, у шагов модуля нет.
  #
  # Общие записи при этом не трогаются: отбор происходит на стороне запроса,
  # и другие роли флота продолжают получать их целиком.
  [[ -z "${EQUILL_RULE_MODULES:-}" ]] || args+=(--where "module=$EQUILL_RULE_MODULES")

  warn=""
  err="$(mktemp "${TMPDIR:-/tmp}/lane-memory.XXXXXX")"
  trap 'rm -f -- "$err"' EXIT
  baseline=""
  if bundle="$("$equill_bin" "${args[@]}" 2>"$err")"; then
    baseline="$("$jq_bin" -er '.content | select(type=="string" and length>0)' <<<"$bundle" 2>/dev/null || true)"
    # Усечение по бюджету МОЛЧАЛИВОЕ: content приходит, просто без части записей.
    # Измерено: при бюджете 30 отдаётся 30 записей из 76 и никаких правил вовсе,
    # при 100 — всё и degraded:false. Запас 24 записи, и он кончится.
    if [[ "$("$jq_bin" -r '.receipt.degraded // .degraded // false' <<<"$bundle" 2>/dev/null)" == "true" ]]; then
      warn="контракт УСЕЧЁН бюджетом: часть правил и шагов не пришла"
    fi
  fi
  # A lane without its contract must not run: it would work confidently under
  # rules it never read.
  [[ -n "$baseline" ]] || { emit_fatal "$event" "lane memory: baseline failed: $(tr '\n' ' ' <"$err" | cut -c1-400)"; exit 0; }

  # The coordinates select records; they do not appear in what those records
  # say. The role is judged against a module the contract never names, so the
  # launch facts are rendered here rather than repeated in every prompt.
  assignment=""
  [[ -z "${EQUILL_TICKET:-}" ]]  || assignment+="- ticket: $EQUILL_TICKET"$'\n'
  [[ -z "${EQUILL_PROJECT:-}" ]] || assignment+="- project: $EQUILL_PROJECT"$'\n'
  [[ -z "${EQUILL_MODULE:-}" ]]  || assignment+="- module: $EQUILL_MODULE"$'\n'
  [[ -z "${LANE_WORKTREE:-}" ]]  || assignment+="- worktree: $LANE_WORKTREE"$'\n'
  [[ -z "$assignment" ]] || baseline="$baseline"$'\n\n## ASSIGNMENT\n'"$assignment"

  # СЛОВАРЬ СИГНАЛОВ БЕРЁТСЯ ИЗ КОНТРАКТА, А НЕ ДУБЛИРУЕТСЯ В ВОРКФЛОУ.
  # ends_when процесса и так называет исходы - по определению своей работы:
  # признак завершения обязан называть то, чем завершение проверяется.
  # Сохраняем строку здесь, чтобы Stop и напоминание брали её же. Один
  # источник: поменяется контракт - поменяется и то, чем узел не выпускают.
  emit "$event" "$baseline" "$warn"
  exit 0
fi

# ── the two retrieval events ────────────────────────────────────────────────
profile="${EQUILL_PROMPT_PROFILE:-}"
[[ -n "$profile" ]] || quiet          # unset profile disables retrieval, baseline stays

if [[ "$event" == UserPromptSubmit ]]; then
  query="$("$jq_bin" -r '.prompt // empty' <<<"$input")"
else
  # PostToolUse carries no .prompt. The query is what JUST happened, and only
  # the calls that say something about the WORK.
  #
  # Measured on implement_code of run e9ea21af, 54 calls: Bash 38, ToolSearch 9,
  # Read 5, Monitor 1, ListAgents 1. Eleven say nothing about the ticket -
  # ToolSearch answers "No matching deferred tools found" every time - and those
  # are the ones dropped, by TOOL rather than by size.
  #
  # A short answer is NOT dropped. "1.4.2" beside "Verify bun is now discoverable
  # on PATH" is a real question about the environment; judging it by the length
  # of the response alone throws away the description that gives it meaning.
  #
  # Deliberately NOT the original task: it is identical on every batch, so it
  # drags every query toward the same records. Deliberately not the tool names
  # either - "Bash" and "Read" are noise in a search.
  #
  # HEAD for a file, TAIL for a command. A file opens with the doc comment that
  # names its subject; a command ENDS with the verdict - "error: script test
  # exited with code 1" - while its head is the runner's boilerplate.
  did="$("$jq_bin" -r '
      [ .tool_calls[]?
        | . as $c
        | (.tool_name // "") as $n
        | if ($n | test("^(Read|Edit|Write|NotebookEdit)$")) then (.tool_input.file_path // empty)
          elif ($n | test("^(Grep|Glob)$"))                 then (.tool_input.pattern // .tool_input.query // empty)
          elif $n == "Bash"                                  then (.tool_input.description // empty)
          # MCP несёт САМОЕ содержательное - сам запрос. Раньше он попадал в
          # else empty, то есть поиск по графу и по коду не говорил памяти
          # ничего, хотя именно он и описывает, что ищут.
          elif ($n | startswith("mcp__"))                     then
               (.tool_input.query // .tool_input.pattern // .tool_input.name
                // .tool_input.symbol // .tool_input.path // empty)
          else empty end
      ] | map(select(type=="string" and length>0)) | unique | join(". ")' <<<"$input" 2>/dev/null)"

  # THE BUDGET COVERS BOTH HALVES, and it did not used to. Equill keeps the HEAD
  # of a query and drops the TAIL - vector/model.rs bounded_chars, applied at
  # embedding/mod.rs, cap 2000 by default and our descriptor does not override
  # it. So the descriptions, which go in front, survived while every response
  # tail behind them was silently thrown away - exactly the tails this hook
  # takes on purpose. Found by qwen, confirmed in Equill's own source.
  #
  # A description is one line and it is the signal, so it keeps the larger half
  # and is trimmed only when it alone would fill the query: measured on
  # implement_code of run e9ea21af, 54 calls at roughly 40 characters each came
  # to 3130 - the descriptions ALONE were already over the cap, so nothing else
  # was reaching Equill at all.
  did="${did:0:900}"
  got_cap=$(( 2000 - ${#did} - 1 ))
  [ "$got_cap" -gt 0 ] || got_cap=1

  # ONLY THE LAST TEN CALLS, and dropping the rest is deliberate. 54 calls
  # sharing what is left of 2000 is eighteen characters each - fragments too
  # short to retrieve anything, so an equal split spends the whole budget on
  # noise. The query asks what just happened; the tail of the batch is what
  # just happened.
  got="$("$jq_bin" -r --argjson cap "$got_cap" '
      [ .tool_calls[]?
        | (.tool_name // "") as $n
        | select($n | test("^(Read|Edit|Write|NotebookEdit|Grep|Glob|Bash)$"))
        | { n: $n,
            r: (.tool_response
                | if type=="string" then .
                  elif type=="object" then (.content // .output // .stdout // "" | tostring)
                  else tostring end) } ]
      | .[-10:]
      | (if length == 0 then 1 else length end) as $k
      | (($cap / $k) | floor) as $share
      | map(if (.n | test("^(Read|Edit|Write|NotebookEdit)$")) then .r[0:$share] else .r[-$share:] end)
      | join(" ") | gsub("\\s+"; " ")' <<<"$input" 2>/dev/null)"

  # Trimmed here rather than left to Equill. It would cut at the same place -
  # head kept, tail dropped - but a budget that is only enforced downstream is
  # a budget nobody can check, and the joins above spend more than their share.
  query="$(printf '%s %s' "$did" "$got")"
  query="${query:0:2000}"
fi

# Whitespace only. The budget was shared out above and the descriptions are
# deliberately outside it, so nothing is cut here - a blanket cut would take the
# front of the string, which is where the descriptions are.
query="$(printf '%s' "$query" | tr '\n' ' ' | sed -E 's/[[:space:]]+/ /g')"
[[ -n "${query// /}" ]] || quiet

# A batch that asks what the last one asked retrieves what the last one got.
# Seen live: "Typecheck the notification package EXIT=0" fired twice in a row.
if [[ ( "$event" == PostToolUse || "$event" == PostToolBatch ) && -n "${EQUILL_TICKET:-}" ]]; then
  last_f="${TMPDIR:-/tmp}/lane-memory-last.${EQUILL_TICKET}"
  now_h="$(printf '%s' "$query" | shasum -a 256 2>/dev/null | cut -d" " -f1)"
  [[ -z "$now_h" || "$now_h" != "$(cat "$last_f" 2>/dev/null)" ]] || quiet
  [[ -z "$now_h" ]] || printf '%s' "$now_h" > "$last_f" 2>/dev/null || true
fi

# Retrieval asks under the memory role, not the contract role - see above. The
# array is rebuilt rather than edited because --role appears once and a sed on
# an array is how the lane learned about word splitting.
mem_args=(context --json --store "$EQUILL_STORE" --role "$memory_role"
          --process "$EQUILL_PROCESS" --format llm)
[[ -z "${EQUILL_PROJECT:-}" ]] || mem_args+=(--project "$EQUILL_PROJECT")

# PHASE narrows to the stage doing the asking. Measured against the live store:
# 29 lessons with no phase, 18 under phase=unit, 20 under phase=land - so the
# coordinate drops what belongs to the other stage instead of retrieving it.
# harness is deliberately NOT passed: measured at 29 with and without, our
# lessons do not carry it, so it would be a coordinate that only looks precise.
[[ -z "${EQUILL_PHASE:-}" ]] || mem_args+=(--coordinate "phase=$EQUILL_PHASE")

# --query=VALUE attached, not separated: a value beginning with a dash is read as
# another flag in the separated form, and a user line starting with a bullet was
# enough to break it.
rerr="$(mktemp "${TMPDIR:-/tmp}/lane-memory-r.XXXXXX")"
trap 'rm -f -- "$rerr"' EXIT
if ! bundle="$("$equill_bin" "${mem_args[@]}" --profile "$profile" "--query=$query" 2>"$rerr")"; then
  # A refused retrieval used to say nothing at all. The contract still stands,
  # so this does not stop the session - but an agent working without the memory
  # it believes it has is the silent failure this lane exists to avoid.
  emit "$event" "" "lane memory: retrieval failed: $(tr '\n' ' ' <"$rerr" | cut -c1-300)"
  exit 0
fi
content="$("$jq_bin" -er '.content | select(type=="string" and length>0)' <<<"$bundle" 2>/dev/null || true)"
emit "$event" "$content"
