# planning

Общий Medulla граф, промпты и Python-модули планировщика. Своего пусковика
здесь нет: [planning-joppa](../planning-joppa/README.md) запускает этот граф
(`planning-joppa/workflow.yaml` ссылается на `planning/workflow.yaml`) и
импортирует `common`, `stages` и `validation` через `sys.path`.

```text
prepare → research [code | knowledge | external, параллельно]
        → necessity → design → critics [simplicity | correctness, parallel]
        → critique_join (отказ: один раз обратно в design с блокирующими находками)
        → result.json + plan.md
```

## Исполнители

Нужны `medulla`, Python 3.10+, `codex`, `claude`, `agy`, `opencode`, `git`,
`equill` и `codebase-memory-mcp`. Используется штатная авторизация каждого CLI.
Для запуска AGY на хосте рабочий каталог должен быть доверенным в его настройках.

| Участник | Исполнитель | Модель |
| --- | --- | --- |
| Три ветки разведки | Codex | `gpt-6.1-sol` |
| Проектировщик | Claude Code | `claude-opus-5-5` |
| Критик необходимости | Codex | `gpt-6.1-sol` |
| Критик простоты | AGY | `gemini-4-argon-high` |
| Критик корректности | OpenCode | `zai-coding-plan/glm-5.3` |

Модели разведки, проектировщика и критиков задаются по местам в
`workflow.yaml`, как в lane. Общего `--model` нет. Три критика используют разные семейства моделей;
при недоступности участника его не заменяет ещё один запуск оставшейся модели.
Везде `effort: high`; у AGY уровень также указан в имени модели.

Контракты `crew-planning-researcher`, `crew-planning-designer` и
`crew-planning-critic` должны существовать в живом Equill. Снимок для установки
в новый стор: [crew-planning-records.jsonl](../roles/crew-planning-records.jsonl).
Он не подставляется вместо отсутствующего контракта; перед импортом в рабочий
стор сверяйте его с живыми записями. В текущий Equill эти роли уже добавлены.

## Что выполняется

1. `prepare` в planning-joppa читает контекст Joppa, фиксирует состояния Git, проверяет наличие
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
3. The necessity critic first records need, minimum scope, reuse, and required owner decisions.
   Its assessment binds to the assignment and research. A required owner decision stops before design.
   The designer receives this assessment and chooses the smallest sufficient mechanism.
   Each Task contains numbered mechanism steps, a module, dependencies, and observable acceptance checks.
   Lane selects files, functions, test placement, and build details. Source citations are evidence, not edit instructions.
   The validator checks module ownership, AC binding, dependencies, and acceptance check specifications.
   Existing checks may include commands. Planning does not execute project checks.
4. Simplicity and correctness critics receive the same necessity assessment and frozen plan in independent sessions.
   Simplicity checks the assessed scope. A rejection returns to design once, without repeating necessity.
   The plan and assessment digests prevent reuse of results from different inputs.
   Любой
   блокирующий вердикт, отсутствующий ответ или несовпадающий digest останавливает
   подготовку. Проверка готовности также отказывает при изменении исходников,
   входного файла, цепочки Joppa или обязательных контрактов Equill во время прогона.
   Исключение: если репозиторий только продвинулся коммитами (дерево чистое до
   и после, старый HEAD — предок нового), те же три критика один раз получают
   план и diff до 60 KB (`drift_review`). План публикуется на новой базе, только
   если все трое ответили `clear` и на каждый из четырёх вопросов привели
   доказательство с изменённым путём или цитатой плана; `result.json` хранит `drift_review` со старым
   и новым HEAD, digest diff и вердиктами. Переименование или удаление пути,
   на который ссылаются план или разведка, любое бинарное изменение, больший diff, блокирующий ответ или
   любое движение базы после запроса проверки (в том числе обратно к старой)
   — прежний отказ. Исходники сверяются ещё раз после загрузки контрактов,
   непосредственно перед публикацией; атомарной с публикацией эта проверка не является.
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

The workflow permits one necessity assessment and at most two design rounds.
Research has a 600-second limit. Necessity, design, and plan critics each have a 1200-second limit.
The complete workflow has a 7800-second limit, including retries and the optional drift review.
See [workflow.yaml](workflow.yaml) for the stage limits and models.

## Проверка реализации

### Writing standard

Planning and lane receive the shared Equill rule `writing.ste100` ([ASD-STE100, Issue 9](https://www.asd-ste100.org/)).
The workflow does not measure compliance.

### Проверки

```sh
python3 -m pytest -q planning/tests
python3 -m pytest -q planning-joppa/tests
```

`planning/tests` проверяют общие модули: проверку входа и отпечаток исходников,
разбор финальных ответов и проверку drift review на настоящем Git-репозитории.
Сквозные проверки графа с Joppa находятся в `planning-joppa/tests`.
