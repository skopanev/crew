# planning

Отдельный исполняемый Medulla workflow. Берёт один AC вместе с контекстом
Domain → Capability → Requirement и возвращает проверенный план реализации
и атомарные Tasks. Domain и Capability обязательны: `id` и `text` с их смыслом
и ограничениями. Родительский контекст не расширяет работу за пределы одного AC.

```text
prepare → research [code | knowledge | external, параллельно]
        → design → critics [necessity | simplicity | correctness, параллельно]
        → critique_join (отказ: один раз обратно в design с блокирующими находками)
        → result.json + plan.md
```

## Запуск

Проверить граф без обращений к Equill, CBM и LLM:

```sh
sh ./planning/run.sh --input ./planning/input.example.json --dry-run
```

Для настоящего прогона скопируйте `input.example.json` в `input.local.json` и
укажите текущую цепочку Domain/Capability/Requirement/AC из Joppa, решения, абсолютные пути репозиториев,
точные имена проектов из CBM `list_projects` и границы модулей. Локальные
`*.local.*` уже исключены из Git. ID выбирают цепочку; перед разведкой workflow
читает актуальную Joppa и подставляет её формулировки вместо локальных копий.
Перед успешным завершением цепочка проверяется повторно.

```sh
sh ./planning/run.sh \
  --input ./planning/input.local.json \
  --cbm-store /absolute/path/to/cbm/store \
  --cbm-root /absolute/path/allowed/by/cbm \
  --equill-store /absolute/path/to/equill/store
```

Нужны `medulla`, Python 3.10+, `codex`, `claude`, `agy`, `opencode`, `git`,
`equill` и `codebase-memory-mcp`. Используется штатная авторизация каждого CLI.
Для запуска AGY на хосте рабочий каталог должен быть доверенным в его настройках.
При нестандартном размещении доступны `MEDULLA_BIN`, `EQUILL_BIN`, `CBM_BIN`.

| Участник | Исполнитель | Модель |
| --- | --- | --- |
| Три ветки разведки | Codex | `gpt-6.1-sol` |
| Проектировщик | Claude Code | `claude-opus-5-5` |
| Критик необходимости | Codex | `gpt-6.1-sol` |
| Критик простоты | AGY | `Gemini 3.1 Pro (High)` |
| Критик корректности | OpenCode | `zai-coding-plan/glm-5.3` |

Разведка и проектировщик настраиваются отдельно через `--research-model` и
`--design-model`. Состав критиков задаётся по местам в `workflow.yaml`, как
в lane. Общего `--model` нет. Три критика используют разные семейства моделей;
при недоступности участника его не заменяет ещё один запуск оставшейся модели.
Везде `effort: high`; у AGY уровень также указан в имени модели.

Для детерминированных чтений Joppa используется штатный HTTPS MCP и отдельная
сервисная учётная запись агента, имеющая доступ к workspace:

```sh
export JOPPA_MCP_URL=https://joppa.otion.us/mcp
export JOPPA_TOKEN_FILE=/private/path/to/crew-agent-token
```

Путь указывает на уже выданный сервисный credential. Интерактивный OAuth вход
редактора не настраивает это окружение автоматически. Клиент вызывает только
`joppa_read`; токен не записывается в артефакты/аргументы, переменные
`JOPPA_TOKEN` и `JOPPA_TOKEN_FILE` очищаются в агентных узлах и перед Medulla lane.
При отсутствии доступа workflow отказывает до начала разведки.

Контракты `crew-planning-researcher`, `crew-planning-designer` и
`crew-planning-critic` должны существовать в живом Equill. Снимок для установки
в новый стор: [crew-planning-records.jsonl](../roles/crew-planning-records.jsonl).
Он не подставляется вместо отсутствующего контракта; перед импортом в рабочий
стор сверяйте его с живыми записями. В текущий Equill эти роли уже добавлены.

## Что выполняется

1. Пусковик проверяет вход. `prepare` читает живую цепочку Joppa, фиксирует состояния Git, проверяет наличие
   проектов в CBM, получает три обязательных контракта и применимые знания из
   Equill. Общие правила без нужного процесса и шагов не считаются контрактом.
2. Три исследователя работают параллельно. Кодовая ветка обязана действительно
   вызвать CBM search и запрос `SIMILAR_TO` для каждого репозитория в заданном охвате AC:
   post hook проверяет события CLI. В отчёте перечисляются `inspected_paths`;
   для этих путей нужны успешные квитанции `check_index_coverage` с полными,
   согласованными метаданными и `freshness: metadata_match`. Пропущенные или
   устаревшие сведения останавливают проход. Файлы из ссылок `evidence.source`
   должны входить в `inspected_paths`, чтобы агент не обходил проверку покрытия.
   Fresh `parse_partial` entries require direct source verification, not another index pass.
   Other coverage issues still block planning.
   Это best-effort проверка индекса;
   она не доказывает полноту графа или совпадение его дерева с текущим worktree.
   Агент обязан прочитать исходники, включая применимые локальные изменения.
   История исследуется через Git; внешняя ветка может обоснованно вернуть
   `not_needed`. Индексацию и watchers этот workflow не запускает.
3. The designer chooses the smallest sufficient mechanism and explains necessity, reuse, safety, and extensibility.
   Each Task contains numbered mechanism steps, a module, dependencies, and observable acceptance checks.
   Lane selects files, functions, test placement, and build details. Source citations are evidence, not edit instructions.
   The validator checks module ownership, AC binding, dependencies, and acceptance check specifications.
   Existing checks may include commands. Planning does not execute project checks.
4. Три критика получают один план и его digest в независимых сессиях. Любой
   блокирующий вердикт, отсутствующий ответ или несовпадающий digest останавливает
   подготовку. Проверка готовности также отказывает при изменении исходников,
   входного файла, цепочки Joppa или обязательных контрактов Equill во время прогона.
   Исключение: если репозиторий только продвинулся коммитами (дерево чистое до
   и после, старый HEAD — предок нового), те же три критика один раз получают
   план и diff до 60 KB (`drift_review`). План публикуется на новой базе, только
   если все трое ответили `clear`; `result.json` хранит `drift_review` со старым
   и новым HEAD, digest diff и вердиктами. Переименование или удаление пути,
   на который ссылаются план или разведка, больший diff, блокирующий ответ или
   повторное движение базы во время проверки — прежний отказ.
   Digest защищает от вердикта для другого плана; понимание плана агентом
   математически не подтверждает.
5. Успех сохраняет `result.json` и читаемый `plan.md`. Провал сохраняет причину
   и уже полученные отчёты. Medulla также сохраняет журнал и `outcome.json`,
   включая прерывание или исчерпание общего времени.
   Ошибки post hook сохраняются отдельно для каждой ветки и попадают в
   `result.json.errors` вместе с исходной причиной. Большие Git diff и
   неотслеживаемые файлы хешируются без полной загрузки содержимого в память.

Все агентные узлы используют `sandbox: read-only`, который Medulla переводит
в разрешения соответствующего CLI. Post hook принимает финальное сообщение
Codex, успешный результат Claude/Gemini или текст последнего сообщения OpenCode;
вывод инструментов и незавершённые потоки не подменяют результат. Артефакты
записывает post hook, а в вердиктах сохраняется назначенный исполнитель и модель.
Разведка подключает CBM с явным списком инструментов чтения. Проектировщик и
критики получают собранные доказательства и читают исходники штатными средствами.
Настройка Codex соответствует
[Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

По умолчанию один проход: до 300 секунд на каждую агентную стадию и 1800 секунд
на весь workflow. Бесконечного цикла «ещё раз покритикуем» нет. Лимиты и состав
групп видны в [workflow.yaml](workflow.yaml).

## Результат и граница с lane

Прогоны лежат в `~/.medulla/planning-runs` либо в `--runs-folder`; этот каталог
должен находиться вне исследуемых репозиториев.

| `artifacts/result.json`: status | Значение |
| --- | --- |
| `ready` | План структурно корректен, все критики вернули `clear`, исходный снимок и обязательные контракты сохранились. |
| `verify_existing` | Изменение кода не требуется; подготовлены проверки существующего поведения. Это ещё не прошедшая проверка AC. |
| `blocked` | Есть отказ, недостающие данные, некорректный ответ или изменившиеся предпосылки. Причина и отчёты сохранены. |

Это локальный результат planning. Workflow не изменяет `ready` в Joppa, не
создаёт и не захватывает Tasks, не запускает lane и не публикует код.
Квитанция содержит `scope: local_plan`, `joppa_currentness_verified: true`,
снимок `joppa_snapshot` и время успешного завершения `completed_at` в UTC.
Проверка живой цепочки не означает, что AC выполнен или принят владельцем.

## Срок годности и допуск lane

```sh
python3 planning/admit.py --result /path/to/run/artifacts/result.json
```

| Исход | Условие | Код выхода |
| --- | --- | --- |
| `allowed` | Цепочка совпадает и возраст строго меньше 24 часов. | 0 |
| `stale` | Изменилась цепочка, возраст ≥24 часов либо у старого результата нет проверенного снимка. Нужен новый planning. | 3 |
| `error` | Текущее состояние не прочитано, ответ некорректен, часы противоречивы или результат не допускает реализацию. Запуск запрещён. | 2 |

Сравниваются формулировки, описания, владельцы, подтверждение и связи Domain,
Capability, текущей ревизии Requirement и её AC. Все AC входят в контекст REQ;
новая ревизия тоже считается изменением. Счётчики заметок, обычные комментарии,
просмотры карточек, активность Tasks и результаты проверок не являются изменением
формулировки. Для двух чтений Joppa требуется одинаковая позиция журнала;
при гонке выполняется до трёх попыток, затем отказ. Сама позиция не входит
в сравнение: изменение постороннего объекта не инвалидирует план.

TTL фиксирован: 24 часа после успешного завершения planning. Проверка не
перезаписывает результат и не продлевает время; возраст проверяется также после
сетевых обращений. Старые результаты без времени/снимка требуют нового planning.

The lane launcher accepts these optional admission arguments with its required launch options:

```sh
--planning-result /path/to/run/artifacts/result.json --planning-task task-1
```

Both flags are required together. Admission checks the Task, repository, ticket
module, live Joppa chain, and plan age. It runs before container preparation and
again before Medulla. A `stale` or `error` result stops the launch.

These flags check admission only. They do not deliver the plan or Task steps to
scout or coder. Dolber does not link an NTK ticket to a planning result. Both
agents read the NTK ticket. The ticket must contain the chosen approach, edit
steps, scope, and acceptance checks before dispatch.

Создание Joppa Tasks, перенос плана в их контракты и автоматическая передача
в очередь остаются отдельной интеграцией. Адаптеру нужны сопоставление
репозиториев с Joppa projects и соблюдение зависимостей до захвата:
локальное `depends_on` Joppa не исполняет.

## Проверка реализации

### Writing standard

Planning and lane receive the shared Equill rule `writing.ste100` ([ASD-STE100, Issue 9](https://www.asd-ste100.org/)).
The workflow does not measure compliance.

### Проверки

```sh
python3 -m unittest discover -s planning/tests -v
```

Нужен установленный Medulla с его Python-зависимостями (включая PyYAML).
Если `medulla` отсутствует в PATH, задайте `MEDULLA_BIN` абсолютным путём к его
исполняемому файлу. Временные зависимости из окружения другого разработчика
не предполагаются доступными; без Medulla тесты движка будут помечены skipped.

Тесты запускают настоящий движок Medulla с подставными ответами Codex, Claude,
AGY, OpenCode, Equill и CBM в отдельных временных репозиториях. Они проверяют
фактический выбор разных CLI/моделей, параллельность, успешный
выход, маршрут существующего поведения, отказы и отсутствие вызовов при dry-run.
Также проверяются прохождение контекста Domain/Capability, пагинация CBM,
устаревшие сведения о путях, ошибки JSON в обеих параллельных группах,
изоляция вложенных сигналов и изменение содержимого больших локальных файлов.
HTTP MCP тесты проверяют TTL на границе 24 часов, изменения всех уровней,
отказ при недоступности и гонке чтений, а также повторный допуск в настоящем
`lane/run.sh` с тестовыми NTK, Docker и Medulla без реального запуска полосы.
Это проверка оркестрации, не замер качества LLM или проверка живой авторизации.
