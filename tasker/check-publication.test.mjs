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

function review(draftValue, reviews, dry = 'false', owner = 'fixture-owner') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tasker-review-'));
  try {
    const write = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
    write('draft.json', draftValue);
    write('input.json', {selected: {address: ac, kind: 'ac', document: {data: {owner}}}, claim_revision: 31, children: [reporter('packages/a/src/b.itest.ts > existing case')]});
    write('codex.json', reviews[0]);
    write('second.json', reviews[1]);
    return JSON.parse(execFileSync('jq', ['-nc', '--arg', 'digest', 'd1', '--arg', 'run', 'run-1', '--arg', 'stage', 'to_implement',
      '--arg', 'dry', dry, '--slurpfile', 'draft', 'draft.json', '--slurpfile', 'input', 'input.json',
      '--slurpfile', 'codex', 'codex.json', '--slurpfile', 'second', 'second.json',
      '-f', path.join(here, 'publication.jq')], {cwd: dir, encoding: 'utf8'}));
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}
const checks = ok => Object.fromEntries(['gate', 'size', 'reporter_names', 'outside_files', 'already_in_develop', 'ac_test_consistency', 'ac_scope']
  .map(key => [key, {ok: key === 'outside_files' ? ok : true, evidence: 'b.ts::run'}]));
const approve = {draft_digest: 'd1', verdict: 'APPROVE', checks: checks(true), findings: [], summary: 's'};

test('publishes the Tasks in to_implement only when both critics approve every check of this draft', () => {
  const okDraft = {verdict: 'OK', reason: 'r', tasks: [{id: 't1', title: 'Do it', body: 'B', repository: 'example-backend', depends_on: ['task:abc']}]};
  const result = review(okDraft, [approve, approve]);
  assert.equal(result.approved, true);
  assert.deepEqual(result.publication.operations[0].command, {op: 'save_object', kind: 'ac', id: 'sample0005', revision: 31,
    data: {stage: 'to_implement'}, reason: 'tasker: the AC goes to to_implement.'});
  assert.deepEqual(result.publication.operations[1].command, {op: 'save_object', kind: 'task', revision: 0, parent: ac,
    reason: 'Publish a Task that both independent critics approved.', data: {title: 'Do it', body: 'B', repository: 'example-backend', stage: 'to_implement', owner: 'fixture-owner'},
    relations: {depends_on: {edges: [{to: 'task:abc'}]}}});
  okDraft.tasks[0].owner = 'draft-owner';
  assert.equal(review(okDraft, [approve, approve], 'false', 'other-ac-owner').publication.operations[1].command.data.owner, 'other-ac-owner');
  assert.throws(() => review(okDraft, [approve, approve], 'false', null), /Parent AC owner is missing/);
  const rework = {...approve, verdict: 'REWORK', checks: checks(false), findings: [{problem: 'p', advice: 'a'}]};
  const refused = review(okDraft, [approve, rework]);
  assert.equal(refused.approved, false);
  assert.deepEqual(refused.critique.second.failing, [{check: 'outside_files', evidence: 'b.ts::run'}]);
  assert.match(review(okDraft, [approve, {...approve, draft_digest: 'old'}]).critique.second.invalid, /another draft/);
  assert.match(review(okDraft, [approve, {...approve, checks: {gate: approve.checks.gate}}]).critique.second.invalid, /output contract/);
});

test('publication orders prerequisites before reversed dependents and uses existing native refs', () => {
  const extract = {id: 'extract', title: 'Extract existing code', body: 'Keep behavior', repository: 'example-backend', depends_on: []};
  const feature = {id: 'feature', title: 'Implement the AC', body: 'Required behavior', repository: 'example-backend', depends_on: ['extract', 'task:existing']};
  const value = {verdict: 'OK', reason: 'The target module needs extraction first', tasks: [feature, extract]};
  const output = review(value, [approve, approve]);
  assert.equal(output.approved, true);
  const creates = output.publication.operations.filter(row => row.command.revision === 0);
  assert.deepEqual(creates.map(row => row.ref), ['task-extract', 'task-feature']);
  assert.deepEqual(creates[1].command.relations.depends_on.edges, [
    {to: {$ref: 'task-extract/address'}}, {to: 'task:existing'}]);
  const dry = review(value, [approve, approve], 'true');
  assert.deepEqual(dry.publication.operations, []);
  assert.deepEqual(dry.would_publish.operations, output.publication.operations);
  assert.equal(review(value, [approve, {...approve, draft_digest: 'old'}]).approved, false);
  assert.throws(() => review({...value, tasks: [{...extract, depends_on: ['unknown']}]}, [approve, approve]), /dependency does not name/);
  assert.throws(() => review({...value, tasks: [{...extract, depends_on: ['feature']}, feature]}, [approve, approve]), /dependencies contain a cycle/);
});

test('DONE moves the AC with develop and Test evidence, while dry run writes nothing and GAP asks a decision', () => {
  const done = review({verdict: 'DONE', reason: 'r', done_commit: 'abc1234'}, [approve, approve]);
  assert.deepEqual(done.publication.operations[0].command, {op: 'save_object', kind: 'ac', id: 'sample0005', revision: 31,
    data: {stage: 'to_implement'}, reason: 'Develop already has this behavior at abc1234. Tests: test:177ws50j. r'});
  assert.equal(done.publication.operations[1].command.op, 'note');
  assert.equal(done.publication.operations[1].command.text, done.publication.operations[0].command.reason);
  assert.equal(done.publication.outcome.reason_code, 'ALREADY_IN_DEVELOP');
  const gap = review({verdict: 'GAP', reason: 'r', gap: 'A=0: split the AC'}, [approve, approve]);
  assert.deepEqual(gap.publication.operations.map(row => row.command.op), ['save_object', 'note']);
  assert.deepEqual(gap.publication.operations[0].command.data, {stage: 'to_decide'});
  assert.equal(done.publication.operations.length, 2);
  assert.equal(done.publication.operations.some(row => row.command.kind === 'task'), false);
  assert.deepEqual(review({verdict: 'DONE', reason: 'r', done_commit: 'abc1234'}, [approve, approve], 'true').publication.operations, []);
  assert.equal(review({verdict: 'DONE', reason: 'r', done_commit: 'abc1234'}, [approve, {...approve, draft_digest: 'old'}]).approved, false);
  const dry = review({verdict: 'GAP', reason: 'r', gap: 'A or B?'}, [approve, approve], 'true');
  assert.deepEqual(dry.publication.operations, []);
  assert.match(dry.publication.outcome.reason, /^Dry run, nothing published\. Would be DECISION_REQUIRED: A or B\?/);
  assert.equal(dry.would_publish.operations[1].command.op, 'note');
});

// Active work stays untouched. A reviewed refusal changes the claimed AC stage.
test('ACTIVE_TASK writes nothing and REJECTED sends the claimed AC to to_decide', () => {
  const workflow = fs.readFileSync(path.join(here, 'workflow.yaml'), 'utf8');
  const active = workflow.slice(workflow.indexOf('      active="$('), workflow.indexOf('      bash "$MEDULLA_WORKFLOW_DIR/trees.sh" add'));
  const rejected = workflow.split('  rejected:\n')[1].split('    shell: |\n')[1].split('    on_signal:')[0];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tasker-routes-'));
  try {
    const artifacts = path.join(root, 'artifacts');
    fs.mkdirSync(artifacts);
    const output = path.join(artifacts, 'operations.json');
    for (const data of [{stage: 'in_progress'}, {stage: 'to_review'}, {stage: 'to_implement', assignee: 'crew-lane:r1'}]) {
      fs.writeFileSync(path.join(artifacts, 'input.json'), JSON.stringify({children: [{kind: 'task', address: 'task:active', document: {data}}]}));
      const message = execFileSync('sh', ['-c', active], {encoding: 'utf8', env: {...process.env, a: artifacts, file: 'operations.json'}});
      assert.match(message, /<signal:ACTIVE>/);
      const publication = JSON.parse(fs.readFileSync(output, 'utf8'));
      assert.deepEqual(publication.operations, []);
      assert.equal(publication.outcome.reason_code, 'ACTIVE_TASK');
      fs.unlinkSync(output);
    }
    fs.writeFileSync(path.join(artifacts, 'input.json'), JSON.stringify({selected: {kind: 'ac', address: 'ac:a'}, claim_revision: 9}));
    const reason = 'critic: reuse the existing caller. Fix: remove the duplicate helper.\n';
    fs.writeFileSync(path.join(artifacts, 'failure.txt'), reason);
    const execute = dry => execFileSync('sh', ['-c', rejected], {encoding: 'utf8', env: {...process.env,
      MEDULLA_RUN_DIR: root, MEDULLA_WORKFLOW_DIR: here, DRY_RUN: String(dry), FLOW_PUBLICATION: '{"file":"operations.json"}'}});
    assert.match(execute(false), /<signal:DECISION>/);
    const publication = JSON.parse(fs.readFileSync(output, 'utf8'));
    assert.deepEqual(publication.operations[0].command, {op: 'save_object', kind: 'ac', id: 'a', revision: 9,
      data: {stage: 'to_decide'}, reason});
    assert.equal(publication.operations[1].command.text, reason);
    assert.equal(publication.outcome.reason_code, 'REJECTED');
    assert.match(execute(true), /<signal:DECISION>/);
    assert.deepEqual(JSON.parse(fs.readFileSync(output, 'utf8')).operations, []);
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
});

test('publishes a reviewed test-only Task and refuses a critic rejection of repeated product work', () => {
  const value = draft([task([{path: 'packages/a/src/b.itest.ts', change: 'edit', lines: 9}])]);
  const approved = review(value, [approve, approve]);
  assert.equal(approved.approved, true);
  assert.equal(approved.publication.operations.filter(row => row.command.kind === 'task').length, 1);
  const rejectsRepeat = {...approve, verdict: 'REWORK',
    checks: {...approve.checks, already_in_develop: {ok: false, evidence: 'The product behavior exists. Reuse its module::symbol.'}},
    findings: [{problem: 'The plan repeats product behavior.', advice: 'Plan only the missing exact Test cases.'}]};
  assert.equal(review(value, [rejectsRepeat, approve]).approved, false);
  assert.equal(review(value, [approve, rejectsRepeat]).approved, false);
  assert.equal(review(value, [approve, {...approve, draft_digest: 'old'}]).approved, false);
});
test('a rejected result records REJECTED and preserves the critic reason for the dashboard', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tasker-rejected-'));
  try {
    const artifacts = path.join(root, 'artifacts'); fs.mkdirSync(artifacts);
    fs.writeFileSync(path.join(artifacts, 'failure-code.txt'), 'REJECTED\n');
    fs.writeFileSync(path.join(artifacts, 'result.json'), JSON.stringify({status: 'blocked', reason: 'critic: existing code', claim_released: true}));
    fs.writeFileSync(path.join(root, 'trees.sh'), 'exit 0\n');
    const workflow = fs.readFileSync(path.join(here, 'workflow.yaml'), 'utf8');
    const script = workflow.split('  failed:\n')[1].split('    shell: |\n')[1].split('    on_signal:')[0];
    execFileSync('sh', ['-c', script], {env: {...process.env, MEDULLA_RUN_DIR: root, MEDULLA_WORKFLOW_DIR: root}});
    const result = JSON.parse(fs.readFileSync(path.join(artifacts, 'result.json'), 'utf8'));
    assert.equal(result.reason_code, 'REJECTED');
    assert.equal(result.reason, 'critic: existing code');
    assert.equal(result.claim_released, true);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

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
    clean.body += '\nTests: test:177ws50j\nDo:\n- Keep the payload unchanged.';
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
