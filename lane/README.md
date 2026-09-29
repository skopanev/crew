# lane

Configure Dolber in its selected `lane-launcher/*.json` file. `run.sh` receives
those settings as arguments and does not load `lane/local.env`. Additional
read-only repositories are mounted as they are; startup never fetches them.

Ведёт один тикет от взятия до посадки внутри докера, под
`--dangerously-skip-permissions`. Контейнер — единственная граница.

```
run.sh --dispatcher-id <dolber-id> --ticket-id <id> --project <ntk workspace> --repo <repository> --source-root <source-workspace> --cbm-mcp-command <shared-connector.py> --gate-command '<check>' --ssh-dir <key-directory>
```

Sources are read-only. Only the run directory (including the ticket worktree)
and the selected repository's Git metadata are writable. No repository is copied.

## Граф

Смотреть командой, не по памяти — она рисует собранный файл:

```
medulla -w lane --graph
```

Прямой путь: взять тикет, сделать ворктри, реализовать, панель из трёх
ревьюеров, свести вердикты, посадить, убрать. Две петли: отказ панели
возвращает к исполнителю до трёх раз; конфликт при посадке чинится и уходит
**снова на панель** — сведённый код панель не видела.

Всё, что пошло не так, идёт в `notify_failure`, всё, что получилось — в
`notify_success`. Эти узлы сохраняют отчёт в `artifacts/failure.txt` или
`artifacts/outcome.txt` и выводят его в поток прогона. Отказ завершает lane
ошибкой; оператор разбирает причину и подхватывает работу с исправлениями.
AgentBus для запуска и завершения lane не нужен.

## Правка

`workflow.yaml` правится напрямую. Проверка — `medulla -w workflow.yaml --validate`.

Переходы отказного узла проверяются без очереди и Docker:
`python3 -m unittest discover -s lane/tests -v` (из корня Crew).
Проверка исполняет настоящий shell узла с локальными заглушками внешних команд.
До подтверждённого claim любой отказ завершает прогон ошибкой без изменения тикета.
После claim обычные отказы переводят работу в blocked и прикрепляют полный отчёт
к NTK: причина, отчёты LLM и ревью. Копия остаётся в artifacts/ntk-failure-report.txt.
После посадки перевод в to_test делает до трёх попыток с паузой 1 секунду.
После третьей ошибки — неуспешный выход; artifacts/landing.txt сохраняет SHA,
artifacts/to-test-errors.txt — ошибки API. Код заново не выполняется, blocked
не выставляется: требуется восстановить статус уже посаженной работы.

Перед запуском оператор задаёт команды проверок через повторяемый
`--gate-command`. Они выполняются из корня кандидата перед каждым ревью.
Без команд запуск отказывает до чтения очереди. Код возврата, команда, cwd,
Git tree и SHA кандидата, версии оболочки/Git/Python и SHA-256 логов сохраняются
в `artifacts/gates/<id>/receipt.json`. Изменение кандидата или отказ проверки
запрещает посадку; после чистого rebase lane снова идёт на проверки и ревью.
Конкретные команды выбираются для репозитория; исключений для красных тестов нет.
Артефакты локальные: серверная Attempt и защищённое хранилище доказательств
ещё не подключены.

## Промпты

В промпте только то, чего контракт знать не может: координаты, где ворктри,
чего нет в этом окружении, какой сигнал печатать, как прогон сюда попал.

Процесс приезжает из Equill: каждая агентная нода в `pre:` тянет контекст по
СВОЕЙ роли и процессу прогона в файл и читает его первым делом. Файлом, а не
хуком — хуки читает только claude-code, а панель ходит на codex, opencode и agy.

Роли: исполнитель и починка конфликта — `crew-lane-coder`, панель — `crew-lane-qa`.

## Сигналы

`<signal:ИМЯ>текст</signal:ИМЯ>`, с начала строки. У агентной ноды `__default__`
означает, что модель не напечатала известного тега, `__failed__` — что она не
дошла до ответа. У шелловой решает код возврата.

Вердикт панелиста — это **имя сигнала**, а не слово в тексте: движок кладёт в
сообщение тело сигнала, и панелист без тега приезжает пустым. Два разных
вердикта в одной строке вердиктом не считаются.

Кап раундов проверяется **до** печати сигнала: движок маршрутизирует по первому
известному, и лимит, напечатанный после, не читается вовсе.

## Границы

Ключ монтируется на запись, и он попадает в окружение каждого тела — движок
кладёт туда все переменные прогона. Значит агент технически может запушить мимо
панели; запрет `Bash(*git push*)` в настройках прикрывает случайность, но не
является границей: сопоставление идёт по строке команды. Настоящая граница —
разделение ключей, read-only в контейнер и запись на хосте. Помечено в `run.sh`.

`equill` в контейнере — клиент хостового моста. AgentBus в образ не входит,
моста и настроек доставки у lane нет. Текущие настройки MCP лежат в `hooks/`.

Lane uses the **shared host CBM service**, through the existing Python stdio
connector configured as `cbmMcpCommand` in Dolber (`--cbm-mcp-command` for
`run.sh`). The same connector can be used by every dispatcher. Only the small
connector script is copied into the run environment; no database is copied,
mounted, reindexed, or started by lane. A read-only MCP handshake and search
must succeed from the container before claiming a ticket.

Codex and Claude receive generated configurations in `/tmp/codex-home` that
point to this connector. CBM paths describe host repositories; agents must
verify findings against the actual mounted repository or ticket worktree.
OpenCode and AGY review the contract, code and verification results without
separate CBM configuration.

Lane executes one prepared ticket. Planning owns reconnaissance, decomposition
and cross-ticket coordination, completed before dispatch. Agents do not fetch
other tickets or their attachments, traverse dependencies, or seek fresh approval.
The local preflight uses scoped CBM and current code to locate the implementation
and necessary checks. The coder implements only this ticket's acceptance criteria.
Missing implementation inputs or contradictions in current code stop the lane
with an exact blocker; they do not trigger another planning pass.

NTK MCP не используется: после захвата shell сохраняет полный тикет в
`artifacts/ticket.json`; захват, чтение и обновление исхода идут через HTTP. Авторизацию Codex обслуживает
broker; `codex-home.sh` не копирует и не заменяет его `auth.json`.

Хостовый мост Equill всегда исполняет запросы как `lane` и разрешает только
`context` и `search`. Перед claim проверяются PID и `bridge.identity`:
старый мост без фиксированного актора нужно остановить, когда он не используется,
и повторить запуск. Сам пусковик работающий мост не останавливает.

Докера внутри тоже нет, поэтому тикет, чья приёмка требует интеграционных
тестов, этой полосе не по силам.

## Прогоны

`~/.medulla/lane-runs/crew-dispatchers/<dolber-id>/` — вне дерева репозитория, иначе `--cwd-ro` не даст
писать. Медулла пишет туда всё сама: журнал, отрендеренные промпты, потоки
ответов. Своего только `artifacts/`: вердикты панели, история раундов, тексты
исходов прогона.
