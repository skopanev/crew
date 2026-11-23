import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {check} from './check.mjs';
import {checkRepair} from './repair-plan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const identity = {GIT_AUTHOR_NAME: 'lane', GIT_AUTHOR_EMAIL: 'lane@example.invalid',
  GIT_COMMITTER_NAME: 'lane', GIT_COMMITTER_EMAIL: 'lane@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null'};
const ac = 'ac:sample0005';
const reporter = name => ({kind: 'test', address: 'test:177ws50j',
  document: {data: {title: 't', body: `Given: x.\nRepository: example-backend. Reporter name: ${name}`}}});

// A fixed develop tree. The fixture forecast returns the given gate.
function run(draft, {children = [], gate = {long: false, split: false, detail: '3 Test file(s)'}} = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tasker-check-'));
  try {
    for (const file of ['packages/a/src/b.ts', 'packages/a/src/b.itest.ts', 'packages/a/src/covered.itest.ts']) {
      fs.mkdirSync(path.dirname(path.join(root, file)), {recursive: true});
      fs.writeFileSync(path.join(root, file), 'export {};\n');
    }
    const git = (...args) => execFileSync('git', ['-C', root, ...args], {env: {...process.env, ...identity}, encoding: 'utf8'});
    git('init', '-q');
    git('add', '.');
    git('commit', '-q', '-m', 'base');
    const sha = git('rev-parse', 'HEAD').trim();
    const input = {selected: {address: ac}, children, schema: {types: {task: {field_max_length: 4096}}}};
    const result = check({input, trees: {'example-backend': {path: root, sha}}, draft: typeof draft === 'function' ? draft(sha, root) : draft,
      maxFiles: 8, maxLines: 300, forecast: () => gate});
    return result;
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
}

const body = files => `Criterion: ${ac}@28. "x"\nRepository: example-backend\nFiles (touched):\n${files.map(file => `- ${file}`).join('\n')}`;
const task = (files, extra = {}) => ({id: 't1', title: 'Do it', repository: 'example-backend',
  files, tests: [], depends_on: [], body: body(files.map(file => file.path)), ...extra});
const draft = tasks => ({verdict: 'OK', reason: 'Minimal change', tasks});

test('accepts a Task within the limits whose files match develop', () => {
  const result = run(draft([task([{path: 'packages/a/src/b.ts', change: 'edit', lines: 40},
    {path: 'packages/a/src/c.itest.ts', change: 'new', lines: 80}])]));
  assert.deepEqual(result.problems, []);
  assert.equal(result.tasks[0].lines, 120);
});

test('refuses a Task over the size limit, and does not count migration SQL', () => {
  const files = Array.from({length: 9}, (_, index) => ({path: `packages/a/src/n${index}.ts`, change: 'new', lines: 10}));
  assert.match(run(draft([task(files)])).problems.join('\n'), /9 files and 90 lines exceed the limit of 8 files/);
  const sql = [{path: 'packages/db/migrations/0420_x.sql', change: 'new', lines: 500}, {path: 'packages/a/src/b.ts', change: 'edit', lines: 290}];
  assert.deepEqual(run(draft([task(sql)])).problems, []);
});

test('refuses a planned gate that splits (Dolber SPLIT returns)', () => {
  const result = run(draft([task([{path: 'packages/a/src/b.ts', change: 'edit', lines: 4}])]),
    {gate: {long: true, split: true, detail: 'full suite'}});
  assert.match(result.problems.join('\n'), /forecastPlanGate split true\): full suite/);
});

test('names the dependency reason of a split (task:sample0003: a new workspace dependency with code)', () => {
  const reason = 'The plan adds a workspace dependency (bun.lock) together with code. A dependency is no unavoidable path.';
  const result = run(draft([task([{path: 'packages/a/src/b.ts', change: 'edit', lines: 4}])]),
    {gate: {long: true, split: true, splitReason: reason, detail: 'backend-test-local: full suite'}});
  assert.match(result.problems.join('\n'), /t1: The plan adds a workspace dependency \(bun\.lock\) together with code\..*split true\): backend-test-local: full suite/);
});

test('refuses a new file that develop has, an edited file that develop lacks and a file the body does not name', () => {
  const result = run(draft([task([{path: 'packages/a/src/b.ts', change: 'new', lines: 4}, {path: 'packages/a/src/gone.ts', change: 'edit', lines: 4}],
    {body: `Criterion: ${ac}@28.\nRepository: example-backend\n- packages/a/src/b.ts`})]));
  const text = result.problems.join('\n');
  assert.match(text, /b\.ts is marked new, but develop/);
  assert.match(text, /gone\.ts is not in develop/);
  assert.match(text, /the body does not name packages\/a\/src\/gone\.ts/);
});

test('checks Reporter files for planned Tests without requiring edits to other covered Tests', () => {
  const missing = reporter('packages/a/src/b.itest.ts > missing case');
  missing.document.data.command = 'run packages/a/src/b.itest.ts';
  const covered = {...reporter('packages/a/src/covered.itest.ts > covered case'), address: 'test:covered'};
  const files = [{path: 'packages/a/src/b.itest.ts', change: 'edit', lines: 9}];
  const value = draft([task(files, {tests: [missing.address]})]);
  const result = run(value, {children: [missing, covered]});
  assert.deepEqual(result.problems, []);
  const wrong = run(draft([task([{path: 'packages/a/src/b.ts', change: 'edit', lines: 4}], {tests: [missing.address]})]),
    {children: [missing, covered]});
  assert.match(wrong.problems.join(), /Reporter name file packages\/a\/src\/b\.itest\.ts is in develop, but no Task touches it/);
});

test('refuses parallel Tasks on one file and an unknown draft dependency', () => {
  const file = [{path: 'packages/a/src/b.ts', change: 'edit', lines: 4}];
  const result = run(draft([task(file), task(file, {id: 't2', depends_on: ['missing']})]));
  const text = result.problems.join('\n');
  assert.match(text, /is also in task t1/);
  assert.match(text, /depends_on must list existing Task addresses/);
});

test('accepts bounded extraction and functional Tasks in either draft order, with ordered file overlap', () => {
  const file = {path: 'packages/a/src/b.ts', change: 'edit', lines: 40};
  const extraction = task([file, {path: 'packages/a/src/extracted.ts', change: 'new', lines: 100}], {id: 'extract'});
  const feature = task([file], {id: 'feature', depends_on: ['extract', 'task:existing']});
  for (const tasks of [[extraction, feature], [feature, extraction]]) assert.deepEqual(run(draft(tasks)).problems, []);
  const next = task([file], {id: 'next', depends_on: ['feature']});
  assert.deepEqual(run(draft([next, feature, extraction])).problems, []);
  const parallel = task([file], {id: 'parallel', depends_on: ['extract']});
  assert.match(run(draft([parallel, feature, extraction])).problems.join(), /overlapping Tasks need an explicit depends_on order/);
  const tooLarge = {...extraction, files: extraction.files.map(file => ({...file, lines: 200}))};
  assert.match(run(draft([tooLarge, feature])).problems.join(), /400 lines exceed/);
});

test('rejects self dependencies and cycles even when they would order overlapping files', () => {
  const file = [{path: 'packages/a/src/b.ts', change: 'edit', lines: 4}];
  assert.match(run(draft([task(file, {depends_on: ['t1']})])).problems.join(), /depends_on has a cycle/);
  const first = task(file, {id: 'first', depends_on: ['second']});
  const second = task(file, {id: 'second', depends_on: ['first']});
  assert.match(run(draft([first, second])).problems.join(), /depends_on has a cycle/);
});

test('file existence follows explicit prerequisites without admitting files from parallel Tasks', () => {
  const file = 'packages/a/src/extracted.ts';
  const extract = task([{path: file, change: 'new', lines: 100}], {id: 'extract'});
  const feature = task([{path: file, change: 'edit', lines: 40}], {id: 'feature', depends_on: ['extract']});
  assert.deepEqual(run(draft([feature, extract])).problems, []);
  assert.match(run(draft([{...feature, depends_on: []}, extract])).problems.join(), /is not in develop/);
  const remove = task([{path: 'packages/a/src/b.ts', change: 'delete', lines: 40}], {id: 'remove'});
  const later = task([{path: 'packages/a/src/b.ts', change: 'edit', lines: 40}], {id: 'later', depends_on: ['remove']});
  assert.match(run(draft([later, remove])).problems.join(), /is not in develop/);
  assert.deepEqual(run(draft([{...later, files: [{...later.files[0], change: 'new'}]}, remove])).problems, []);
});

test('requires exactly one literal Repository line before a Task can reach publication', () => {
  const files = [{path: 'packages/a/src/b.ts', change: 'edit', lines: 4}];
  for (const line of ['Repository: example-backend.', 'Repository: example-backend,',
    'Repository: example-backend. Module: core.', 'Repo: example-backend',
    'Repository: example-backend\nRepository: example-backend.', 'Repository: example-backend\nRepository: example-backend']) {
    const value = task(files, {body: body(files.map(file => file.path)).replace('Repository: example-backend', line)});
    assert.match(run(draft([value])).problems.join('\n'), /exactly one line "Repository: example-backend"/, line);
  }
});

test('checks DONE against the develop tree and GAP for its question', () => {
  assert.deepEqual(run(sha => ({verdict: 'DONE', reason: 'b.ts has it', done_commit: sha})).problems, []);
  assert.match(run({verdict: 'DONE', reason: 'x', done_commit: 'deadbeef'}).problems.join(), /done_commit/);
  assert.match(run({verdict: 'GAP', reason: 'x'}).problems.join(), /GAP needs gap/);
  assert.match(run({verdict: 'MAYBE', reason: 'x'}).problems.join(), /verdict must be/);
});

// publication.jq turns two critic reviews into the publication envelope.
