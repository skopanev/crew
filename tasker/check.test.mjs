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
const settings = JSON.parse(fs.readFileSync(path.join(here, "config.example.json"), "utf8")).vars;
const identity = {GIT_AUTHOR_NAME: 'lane', GIT_AUTHOR_EMAIL: 'lane@example.invalid',
  GIT_COMMITTER_NAME: 'lane', GIT_COMMITTER_EMAIL: 'lane@example.invalid', GIT_CONFIG_GLOBAL: '/dev/null'};
const ac = 'ac:sample0003';
const reporter = name => ({kind: 'test', address: 'test:sample0001',
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
    const input = {selected: {address: ac}, children, schema: {types: {task: {field_max_length: 4096}, test: {role: 'test'}}}};
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

test('names the dependency reason of a split (task:sample0002: a new workspace dependency with code)', () => {
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
  const passed = {...reporter('packages/a/src/b.itest.ts > case'), document: {present: true, data: {}},
    status: {tone: 'green'}, result: {status: 'pass', commit: 'a'.repeat(40)}};
  const done = sha => ({verdict: 'DONE', reason: 'b.ts has it', done_commit: sha});
  assert.deepEqual(run(done, {children: [passed]}).problems, []);
  assert.match(run(done).problems.join(), /recorded PASS/);
  for (const change of [node => {delete node.result;}, node => {node.result.status = 'fail';},
    node => {node.result.commit = '';}, node => {node.status.tone = 'blue';}]) {
    const failed = structuredClone(passed); change(failed);
    assert.match(run(done, {children: [passed, failed]}).problems.join(), /recorded PASS/);
  }
  assert.match(run({verdict: 'DONE', reason: 'x', done_commit: 'deadbeef'}).problems.join(), /done_commit/);
  assert.match(run({verdict: 'GAP', reason: 'x'}).problems.join(), /GAP.*needs/);
  const gap = {owner: 'cto', question: 'Which rule?', a: 'Use A.', b: 'Use B.', recommended: 'A'};
  assert.deepEqual(run({verdict: 'GAP', reason: 'x', gap}).problems, []);
  for (const invalid of ['A or B?', {...gap, owner: 'other'}, {...gap, a: ''}, {...gap, recommended: 'C'}]) {
    assert.match(run({verdict: 'GAP', reason: 'x', gap: invalid}).problems.join(), /GAP.*needs/);
  }
  assert.match(run({verdict: 'MAYBE', reason: 'x'}).problems.join(), /verdict must be/);
});

// publication.jq turns two critic reviews into the publication envelope.
test('an oversized body gives its exact length and the minimum cut', () => {
  const files=[{path:'packages/a/src/b.ts',change:'edit',lines:4}];
  const result=run(draft([task(files,{body:'x'.repeat(4169)})]));
  assert.match(result.problems.join(),/body has 4169 characters, limit 4096\. Remove at least 73 characters/);
});

test('the 3500-character writing target preserves the existing 4096-character schema limit', () => {
  const files = [{path: 'packages/a/src/b.ts', change: 'edit', lines: 4}];
  for (const length of [3500, 3501, 4096, 4097]) {
    const value = task(files, {body: body(files.map(file => file.path)).padEnd(length, ' ')});
    const result = run(draft([value]));
    assert.equal(result.ok, length <= 4096, result.problems.join());
    if (length > 4096) assert.match(result.problems.join(), /body has 4097 characters, limit 4096/);
  }
});

test('Tests body sections contain IDs only and omit copied Test binding metadata', () => {
  const files = [{path: 'packages/a/src/b.ts', change: 'edit', lines: 4}];
  const prefix = body(files.map(file => file.path));
  for (const value of ['Tests: test:a, test:b', 'Tests:\n- test:a\n- test:b', 'Tests: none']) {
    assert.equal(run(draft([task(files, {body: prefix + '\n' + value})])).ok, true, value);
  }
  for (const value of ['Tests: test:a > expected result', 'Tests: test:a. Reporter name: file.test.ts > case',
    'Tests:\n- test:a command: bun run test', 'Tests: none. Internal helper.']) {
    assert.match(run(draft([task(files, {body: prefix + '\n' + value})])).problems.join(), /Tests in body must contain only Test IDs/, value);
  }
  for (const value of ['Reporter name: file.test.ts > case', 'Expected: the returned value is 5', 'Command: bun run test']) {
    assert.match(run(draft([task(files, {body: prefix + '\nTests: none\n' + value})])).problems.join(), /keep Reporter names, Expected and command/, value);
  }
  assert.equal(run(draft([task(files, {body: prefix + '\nTests: none\nDo:\n- Select the branch when the returned value is 5.'})])).ok, true);
});

test('new Task and READY APIs share the lane body restriction check without changing valid file lines', () => {
  run((sha, root) => {
    const clean = task([{path: 'packages/a/src/b.ts', change: 'edit', lines: 179}]);
    clean.body += '\nTests: test:sample0001\nDo:\n- Keep the payload unchanged.';
    const selected = {address: 'task:t1', kind: 'task', document: {data: {title: clean.title, body: clean.body}}};
    const input = {selected, schema: {types: {task: {field_max_length: 4096}, ac: {}}}, context: {
      parent: {address: ac, kind: 'ac', document: {data: {title: 'Criterion', body: 'Required behavior'}}},
      children: [], references: {}, incoming: []}};
    const trees = {'example-backend': {path: root, sha}}, options = {trees, maxFiles: 8, maxLines: 300, forecast: () => null};
    const verify = body => [check({...options, input: {selected: input.context.parent, children: []}, draft: draft([{...clean, body}])}),
      checkRepair({...options, input, repair: {ac_text_changed: false}, checkPlan: check,
        draft: {verdict: 'READY', reason: 'Required work', task: {...clean, body}}})];
    assert.ok(verify(clean.body).every(result => result.ok));
    for (const line of ['Size: three files, about 179 lines', 'Gate: 12 Test files', 'Line count: 179',
      '- packages/a/src/b.ts (~179 lines)']) {
      for (const result of verify(clean.body + '\n' + line)) {
        assert.equal(result.ok, false, line); assert.match(result.problems.join('\n'), /restriction/i);
      }
    }
    return draft([clean]);
  });
});


test('the native title limit accepts 128 characters and refuses 129 before publication', () => {
  const files = [{path: 'packages/a/src/b.ts', change: 'edit', lines: 4}];
  for (const letter of ['x', 'я', '😀']) {
    assert.deepEqual(run(draft([task(files, {title: letter.repeat(128)})])).problems, []);
    assert.match(run(draft([task(files, {title: letter.repeat(129)})])).problems.join(), /128 characters/);
  }
});
