import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {bindingPlan, bindingPublication} from './test-bindings.mjs';
import {check} from './check.mjs';
import {checkRepair, repairPublication} from './repair-plan.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const settings = JSON.parse(fs.readFileSync(path.join(here, "config.example.json"), "utf8")).vars;
const binding = {test: 'test:t', repository: 'example-fixture', reporter_name: 'src/new.test.ts > suite > preserves the result', command: 'bun test src/new.test.ts'};
const acceptance = 'Given: an existing decision.\nWhen: its evidence changes.\nThen: retain the previous decision.\n';
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tasker-bindings-')), artifacts = path.join(root, 'artifacts'), repo = path.join(root, 'repo');
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.mkdirSync(artifacts); fs.mkdirSync(repo);
  const env = {...process.env, ...settings, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid'};
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], {encoding: 'utf8', env}).trim();
  fs.writeFileSync(path.join(repo, 'base.ts'), 'export {};\n'); git('init', '-q'); git('add', '.'); git('commit', '-q', '-m', 'Base');
  const input = {selected: {kind: 'ac', address: 'ac:a', current_revision: 4, document: {data: {title: 'A', body: 'Outcome', owner: 'binding-owner'}}},
    claim_revision: 5, schema: {types: {ac: {role: 'ac', fields: {stage: {values: [settings.TASKER_IMPLEMENT_STAGE]}}}, task: {role: 'task', fields: {stage: {values: [settings.TASK_STAGE]}} , field_max_length: 4096}, test: {role: 'test', field_max_length: 4096}}},
    children: [{address: 'test:t', kind: 'test', current_revision: 9, document: {data: {title: 'Retain the decision', body: acceptance}}}], references: {}};
  const draft = {verdict: 'OK', reason: 'Implement the missing behavior', test_bindings: [structuredClone(binding)],
    tasks: [{id: 't1', title: 'Implement the case', repository: binding.repository,
      files: [{path: 'src/new.test.ts', change: 'new', lines: 20}], tests: ['test:t'], depends_on: [],
      body: 'Criterion: ac:a@4. Outcome\nRepository: example-fixture\nFiles: src/new.test.ts\nTests: test:t'}]};
  const trees = {[binding.repository]: {path: repo, sha: git('rev-parse', 'HEAD')}};
  const options = () => ({input, draft, trees, maxFiles: 8, maxLines: 300, forecast: () => null});
  const write = (name, value) => fs.writeFileSync(path.join(artifacts, name), JSON.stringify(value));
  const read = name => JSON.parse(fs.readFileSync(path.join(artifacts, name), 'utf8'));
  const runReview = ({dry = false, stale = false, approve = true} = {}) => {
    write('input.json', input); write('draft.json', draft); write('trees.json', trees);
    const digest = createHash('sha256').update(fs.readFileSync(path.join(artifacts, 'draft.json'))).digest('hex');
    const checks = Object.fromEntries(['gate', 'size', 'reporter_names', 'outside_files', 'already_in_develop', 'ac_test_consistency', 'ac_scope']
      .map(key => [key, {ok: approve, evidence: 'Fixed tree and planned Test file'}]));
    const review = {draft_digest: digest, verdict: approve ? 'APPROVE' : 'REWORK', checks,
      findings: approve ? [] : [{problem: 'Incomplete binding', advice: 'Correct it'}]};
    write('critic-codex.json', review); write('critic-second.json', {...review, draft_digest: stale ? 'old' : digest});
    const workflow = fs.readFileSync(path.join(here, 'workflow.yaml'), 'utf8');
    const shell = workflow.split('  review_join:\n')[1].split('    shell: |\n')[1].split('    on_signal:')[0];
    return execFileSync('bash', ['-c', shell], {encoding: 'utf8', env: {...env, MEDULLA_RUN_DIR: root, MEDULLA_WORKFLOW_DIR: here,
      FLOW_PUBLICATION: JSON.stringify({file: 'operations.json'}), TASK_STAGE: 'to_implement', DRY_RUN: String(dry), round: '4', REWORK_LIMIT: '3'}});
  };
  return {root, artifacts, repo, env, input, draft, trees, options, write, read, runReview};
}

test('the pure checker accepts a planned new Reporter file and preserves all acceptance bytes', t => {
  const f = fixture(t), before = structuredClone(f.input);
  assert.deepEqual(check(f.options()).problems, []);
  const result = bindingPlan(f.options());
  assert.deepEqual(result.problems, []);
  assert.equal(result.operations.length, 1);
  assert.deepEqual(result.operations[0].command, {op: 'save_object', kind: 'test', id: 't', revision: 9,
    data: {body: acceptance + `Repository: ${binding.repository}. Reporter name: ${binding.reporter_name}`, command: binding.command},
    reason: 'Save the Test binding from the Task plan that both critics approved.'});
  assert.deepEqual(f.input, before);
});

test('typed bindings refuse foreign, duplicate, undeclared and malformed targets', t => {
  const f = fixture(t), original = structuredClone(f.draft);
  const changes = [b => ({...b, test: 'test:foreign'}), b => ({...b, repository: 'example-other'}),
    b => ({...b, reporter_name: 'src/other.test.ts > case'}), b => ({...b, reporter_name: '../src/new.test.ts > case'}),
    b => ({...b, reporter_name: 'src/new.test.ts'}), b => ({...b, reporter_name: 'src/new.test.ts > '}),
    b => ({...b, command: ' \n '}), b => ({...b, command: 3}), b => ({...b, data: {stage: 'done'}})];
  for (const change of changes) {
    f.draft.test_bindings = [change(binding)]; assert.ok(check(f.options()).problems.length);
  }
  f.draft.test_bindings = [binding, binding]; assert.match(check(f.options()).problems.join(), /uniquely/);
  f.draft.test_bindings = {}; assert.match(check(f.options()).problems.join(), /must be an array/);
  delete f.draft.test_bindings; assert.match(check(f.options()).problems.join(), /supply typed/);
  Object.assign(f.draft, original); f.draft.tasks[0].tests = [];
  assert.match(check(f.options()).problems.join(), /planned Task/);
});

test('existing bindings stay immutable and a missing command can be completed without changing the body', t => {
  const f = fixture(t), data = f.input.children[0].document.data;
  data.body = acceptance + `Repository: ${binding.repository}. Reporter name: ${binding.reporter_name}`;
  const result = bindingPlan(f.options()); assert.deepEqual(result.problems, []);
  assert.deepEqual(result.operations[0].command.data, {command: binding.command});
  data.command = binding.command;
  delete f.draft.test_bindings; assert.deepEqual(check(f.options()).problems, []);
  f.draft.test_bindings = [binding]; assert.deepEqual(check(f.options()).problems, []);
  assert.deepEqual(bindingPlan(f.options()).operations, []);
  f.draft.test_bindings = [{...binding, command: 'another command'}]; assert.match(check(f.options()).problems.join(), /preserve the existing command/);
  delete data.command;
  f.draft.test_bindings = [{...binding, reporter_name: 'src/new.test.ts > another case'}];
  assert.match(check(f.options()).problems.join(), /preserve the existing Reporter/);
});

test('held Tests and mismatched consumers cannot receive a new binding', t => {
  const f = fixture(t), data = f.input.children[0].document.data;
  data.assignee = 'crew-planning:another-run';
  const held = bindingPlan(f.options()); assert.match(held.problems.join(), /held Test/); assert.deepEqual(held.operations, []);
  delete data.assignee;
  const first = f.draft.tasks[0], second = structuredClone(first); second.id = 't2';
  f.draft.tasks.push(second);
  second.repository = 'example-other';
  assert.match(bindingPlan(f.options()).problems.join(), /each Task repository and files/);
  second.repository = first.repository; second.files = [];
  assert.match(bindingPlan(f.options()).problems.join(), /each Task repository and files/);
  second.files = structuredClone(first.files);
  assert.deepEqual(bindingPlan(f.options()).problems, []);
});

test('a complete existing binding remains subject to path and consumer checks without a typed update', t => {
  const f = fixture(t), data = f.input.children[0].document.data;
  delete f.draft.test_bindings; data.command = binding.command;
  for (const name of ['broken-name', 'src/other.test.ts > case', '../src/new.test.ts > case']) {
    data.body = acceptance + `Repository: ${binding.repository}. Reporter name: ${name}`;
    assert.match(check(f.options()).problems.join(), /existing Reporter binding/);
  }
  data.body = acceptance + `Repository: example-other. Reporter name: ${binding.reporter_name}`;
  assert.match(check(f.options()).problems.join(), /existing Reporter binding/);
  data.body = acceptance + `Repository: ${binding.repository}. Reporter name: ${binding.reporter_name}`;
  assert.deepEqual(check(f.options()).problems, []);
  f.draft.tasks.push({...structuredClone(f.draft.tasks[0]), id: 'other', repository: 'example-other'});
  assert.match(bindingPlan(f.options()).problems.join(), /existing Reporter binding/);
});

test('typed bindings use the same configured JS runner paths as the CLI', t => {
  const f = fixture(t);
  for (const file of ['apps/app/e2e/send.spec.ts', 'packages/a/src/case.itest-cases.ts']) {
    f.draft.tasks[0].files[0].path = file;
    f.draft.test_bindings[0].reporter_name = file + ' > exact case';
    f.draft.test_bindings[0].command = 'test-runner ' + file;
    assert.deepEqual(bindingPlan(f.options()).problems, []);
  }
  for (const file of ['src/source.ts', 'apps/app/e2e/send.e2e.ts', 'modules/provider/whitebit-fee-sync.tftest.hcl']) {
    f.draft.tasks[0].files[0].path = file; f.draft.test_bindings[0].reporter_name = file + ' > case';
    assert.match(bindingPlan(f.options()).problems.join(), /Task repository and files/);
  }
});

test('the binding plan fits metadata, Tasks and the merged AC release in one native batch', t => {
  const f = fixture(t), original = structuredClone(f.input.children[0]);
  f.input.children = Array.from({length: 98}, (_, index) => ({...structuredClone(original), address: 'test:t' + index}));
  f.draft.tasks[0].tests = f.input.children.map(item => item.address);
  f.draft.test_bindings = f.input.children.map(item => ({...binding, test: item.address}));
  const boundary = bindingPlan(f.options()); assert.deepEqual(boundary.problems, []); assert.equal(boundary.operations.length, 98);
  f.input.children.push({...structuredClone(original), address: 'test:overflow'});
  f.draft.tasks[0].tests.push('test:overflow'); f.draft.test_bindings.push({...binding, test: 'test:overflow'});
  assert.match(bindingPlan(f.options()).problems.join(), /native batch limit of 100/);
});

test('binding updates respect Test schema, frozen revisions and DONE precedence', t => {
  const f = fixture(t);
  f.input.schema.types.test.field_max_length = acceptance.length;
  assert.match(check(f.options()).problems.join(), /schema limit.*preserve the acceptance/);
  f.input.schema.types.test.field_max_length = 4096;
  f.input.schema.types.test.fields = {command: {from: 'parent'}};
  assert.match(check(f.options()).problems.join(), /belong to the Test schema/);
  delete f.input.schema.types.test.fields;
  f.input.children[0].current_revision = null; assert.match(check(f.options()).problems.join(), /frozen Test revision/);
  const done = {verdict: 'DONE', reason: 'Already in develop', done_commit: f.trees[binding.repository].sha};
  Object.assign(f.draft, done); delete f.draft.test_bindings;
  assert.deepEqual(check(f.options()).problems, []);
  f.draft.test_bindings = [binding]; assert.match(check(f.options()).problems.join(), /only for an AC implementation plan/);
});

test('the actual review join publishes Test metadata and Tasks only for the current dual-approved digest', t => {
  const f = fixture(t);
  assert.match(f.runReview(), /<signal:APPROVED>/);
  const value = f.read('operations.json');
  assert.deepEqual(value.operations.map(row => [row.command.kind, row.command.revision]), [['ac', 5], ['test', 9], ['task', 0]]);
  assert.equal(value.operations[1].command.data.body.startsWith(acceptance), true);
  assert.equal(Object.hasOwn(value.operations[1].command.data, 'owner'), false);
  assert.equal(value.operations[2].command.data.owner, 'binding-owner');
  assert.match(f.runReview({dry: true}), /<signal:APPROVED>/);
  assert.deepEqual(f.read('operations.json').operations, []);
  assert.equal(f.read('operations.json').outcome.reason_code, 'DRY_RUN');
  assert.equal(f.read('would-publish.json').operations[1].command.kind, 'test');
  fs.unlinkSync(path.join(f.artifacts, 'operations.json'));
  assert.match(f.runReview({stale: true}), /<signal:REJECTED>/);
  assert.equal(fs.existsSync(path.join(f.artifacts, 'operations.json')), false);
  assert.match(f.runReview({approve: false}), /<signal:REJECTED>/);
  assert.equal(fs.existsSync(path.join(f.artifacts, 'operations.json')), false);
});

test('repair cannot publish parent Test metadata and missing bindings require a decision', t => {
  const f = fixture(t), criterion = f.input.selected, child = f.input.children[0];
  const selected = {kind: 'task', address: 'task:t1', current_revision: 6, document: {data: {title: f.draft.tasks[0].title, repository: binding.repository}}};
  const input = {...f.input, selected, claim_revision: 7, context: {parent: criterion, children: [child], references: {}, incoming: []}};
  const draft = {verdict: 'READY', reason: 'Same work', task: f.draft.tasks[0]};
  const options = {...f.options(), input, draft, repair: {ac_text_changed: false}, checkPlan: check};
  assert.match(checkRepair(options).problems.join(), /READY needs an existing complete binding/);
  child.document.data.body += `Repository: ${binding.repository}. Reporter name: ${binding.reporter_name}`;
  child.document.data.command = binding.command;
  assert.deepEqual(checkRepair(options).problems, []);
  draft.test_bindings = [binding];
  assert.match(checkRepair(options).problems.join(), /only for an AC implementation plan/);
  const refused = repairPublication({...options, run: 'repair'}).publication;
  assert.equal(refused.outcome.reason_code, 'DECISION_REQUIRED');
  assert.ok(refused.operations.every(row => row.command.kind !== 'test'));
  assert.deepEqual(repairPublication({...options, run: 'repair', dry: true}).publication.operations, []);
});

test('publication rechecks binding scope even when supplied an approved envelope', t => {
  const f = fixture(t);
  const review = {approved: true, would_publish: {operations: [{command: {kind: 'ac'}}]}, publication: {operations: []}};
  f.draft.test_bindings[0].test = 'test:outside';
  const value = bindingPublication({...f.options(), review});
  assert.equal(value.approved, false); assert.ok(value.critique.bindings.findings.length);
  assert.equal(value.publication, undefined);
});

test('the actual shape CLI accepts typed bindings and refuses an undeclared Reporter file', t => {
  const f = fixture(t);
  const run = () => {
    f.write('input.json', f.input); f.write('draft.json', f.draft); f.write('trees.json', f.trees);
    return spawnSync(process.execPath, [path.join(here, 'check.mjs'), f.artifacts], {encoding: 'utf8', env: {...f.env,
      CREW_WORKFLOW_DIR: path.join(here, '../workflow'), PLAN_MAX_FILES: '8', PLAN_MAX_LINES: '300'}});
  };
  const valid = run(); assert.equal(valid.status, 0, valid.stderr); assert.equal(f.read('check.json').ok, true);
  f.draft.test_bindings[0].reporter_name = 'src/other.test.ts > case';
  const invalid = run(); assert.equal(invalid.status, 1); assert.match(invalid.stderr, /Task repository and files/);
});

test('the actual prepare admits AC Test updates before author and preserves the repair policy', t => {
  const f = fixture(t), workflow = fs.readFileSync(path.join(here, 'workflow.yaml'), 'utf8');
  const shell = workflow.split('  prepare:\n')[1].split('    shell: |\n')[1].split('    on_signal:')[0];
  f.write('input.json', f.input); f.write('trees.json', f.trees);
  const stages = path.join(f.root, 'stages.mjs');
  fs.writeFileSync(stages, "console.log('<signal:PREPARED>Ready</signal:PREPARED>');");
  fs.writeFileSync(path.join(f.root, 'trees.sh'), 'exit 0\n');
  fs.writeFileSync(path.join(f.root, "completion.mjs"), "console.log(\"<signal:CONTINUE>Context fixture.</signal:CONTINUE>\");");
  const run = update_kinds => spawnSync('bash', ['-c', shell], {encoding: 'utf8', env: {...f.env,
    PLANNING_PYTHON: process.execPath, TASKER_BUN: process.execPath, CREW_FLOW_STAGES: stages, MEDULLA_RUN_DIR: f.root, MEDULLA_WORKFLOW_DIR: f.root,
    FLOW_PUBLICATION: JSON.stringify({file: 'operations.json', allowed_operations: ['save_object', 'note'], create_kinds: ['task'], update_kinds}),
    TASKER_REPOS: '{}', TASKER_TREE_ROOT: f.root, CREW_WORKFLOW_DIR: path.join(here, '../workflow'), CBM_BIN: 'unused',
    CBM_CACHE_DIR: f.root, CBM_ALLOWED_ROOT: f.root, REWORK_LIMIT: '3', PLAN_MAX_FILES: '8', PLAN_MAX_LINES: '300',
    DRY_RUN: 'false', CRITIC_SECOND_HARNESS: 'claude-code', CRITIC_SECOND_MODEL: 'second', CRITIC_CODEX_MODEL: 'first', AUTHOR_MODEL: 'author'}});
  const valid = run(['ac', 'test']); assert.equal(valid.status, 0, valid.stderr); assert.match(valid.stdout, /<signal:READY_TO_WRITE>/);
  const invalid = run(['ac']); assert.equal(invalid.status, 2); assert.match(invalid.stderr, /publication must match/);
  assert.match(shell, /\.create_kinds == \[\] and \(\.update_kinds \| sort\) == \["ac", "task"\]/);
});
