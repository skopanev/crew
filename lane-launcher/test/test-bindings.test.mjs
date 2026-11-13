// Lane test bindings: claim budget, required report evidence and completion with missing test nodes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {claimTask, finishTask} from '../joppa.mjs';
import {packageBudget, frozenBindings, parseBindings} from '../test-bindings.mjs';
import {packageFixture, packageLanding} from '../test-support/launcher-joppa.fixture.mjs';

const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const testReport = {path: 'junit/report.xml', format: 'junit', identity: '{file} > {name}'};
const ONE = 'tests/a.test.js > one', TWO = 'tests/a.test.js > two';
const batches = f => f.calls.filter(call => call.name === 'joppa_batch');

// Write the reviewed receipt, the coder file and the lane record that binds both.
function freeze(artifacts, rows, {outcomes = {[ONE]: 'pass', [TWO]: 'pass'}, status = 'bound'} = {}) {
  const folder = path.join(artifacts, 'gates', 'f1');
  fs.mkdirSync(folder, {recursive: true});
  const receipt = path.join(folder, 'receipt.json');
  fs.writeFileSync(receipt, JSON.stringify({passed: true, tree: 'b'.repeat(40), candidate_sha: 'c'.repeat(40),
    test_report: {...testReport, results: Object.entries(outcomes).map(([name, outcome]) => ({test: name, outcome}))}}));
  const file = path.join(artifacts, 'test-bindings.json');
  fs.writeFileSync(file, JSON.stringify(rows));
  fs.writeFileSync(path.join(artifacts, 'test-bindings-receipt.json'), JSON.stringify({schema: 1, status,
    receipt: '/workspace/runs/x/artifacts/gates/f1/receipt.json', receipt_sha256: digest(receipt),
    tree: 'b'.repeat(40), candidate_sha: 'c'.repeat(40), bindings_sha256: digest(file), rows: parseBindings(rows)}));
  fs.writeFileSync(path.join(artifacts, 'gates', 'current.json'),
    JSON.stringify({receipt: '/workspace/runs/x/artifacts/gates/f1/receipt.json', sha256: digest(receipt)}));
}

async function bound(t) {
  const f = await packageFixture(t);
  Object.assign(f.run.config.repositories[0], {testReport, gateCommands: ['bun test']});
  f.schema.types.check = {role: 'test', parents: ['ac'], question: 'Which test?', title_max_length: 200};
  f.schema.test_results = {max_tests: 10, name: {separator: ' > ', min_parts: 2, max_length: 200}};
  f.objects.get('ac:a1').document.data.owner = 'owner';
  f.objects.get('ac:a2').document.data.owner = 'owner';
  Object.assign(f.objects.get('task:t1').document.data, {checks: ['Run one => ok', 'Lint => clean'],
    acceptance_checks: [{ac: 'ac:a1', check: 'Run one => ok'}]});
  f.objects.get('task:t2').document.data.checks = ['Run two => ok'];
  // A bare criterion ID reads as an address of the parent type.
  f.objects.get('task:t2').document.data.acceptance_checks = [{ac: 'a2', check: 'Run two => ok'}];
  // A same-named node under another criterion does not bind this criterion.
  f.objects.set('check:old', {address: 'check:old', kind: 'check', historical: false, current_revision: 1,
    document: {present: true, parent: 'ac:a1', data: {title: ONE}, links: []}, process: {}, annotations: {}});
  return f;
}

const ROWS = [{task: 'task:t1', ac: 'ac:a1', check: 'Run one => ok', test: ONE},
  {task: 'task:t2', ac: 'ac:a2', check: 'Run two => ok', test: ONE},
  {task: 'task:t2', ac: 'ac:a2', check: 'Run two => ok', test: TWO},
  {task: 'task:t2', ac: 'ac:a2', check: 'Run two => ok', test: TWO}];

test('completion saves the bound names and creates only the missing criterion test nodes', async t => {
  const f = await bound(t);
  await claimTask(f.run, f.persist, f.runId);
  assert.equal(f.run.claim.ticket.bindingNodeLimit, 96);
  assert.deepEqual(f.run.claim.ticket.tasks[1].testAcceptance, [{ac: 'ac:a2', check: 'Run two => ok'}]);
  const artifacts = packageLanding(f), result = {code: 0, status: 'exited'};
  f.run.repository.testReport = testReport;
  freeze(artifacts, ROWS);
  await finishTask(f.run, f.stateFile, result, artifacts);
  assert.equal(result.completed, true);
  const operations = f.run.completionRequest.operations.map(({command}) => command);
  assert.deepEqual(operations.map(command => command.op), ['save_object', 'archive_object', 'save_object', 'archive_object',
    'save_object', 'save_object']);
  assert.deepEqual(operations[0].data.test_bindings, [{ac: 'ac:a1', check: 'Run one => ok', test: ONE}]);
  assert.equal(operations[2].data.test_bindings.length, 2);
  assert.deepEqual(operations.slice(4).map(command => [command.kind, command.revision, command.parent, command.data.title,
    command.data.owner, Object.hasOwn(command, 'question_checked'), command.id]),
  [['check', 0, 'ac:a2', ONE, 'owner', false, undefined], ['check', 0, 'ac:a2', TWO, 'owner', false, undefined]]);
  assert.deepEqual(result.testBindings, {status: 'bound', gaps: [], nodes: 2});
  assert.equal(f.objects.get('task:t1').document.data.test_bindings[0].test, ONE);
});

test('a binding file changed after review refuses completion without a write', async t => {
  const f = await bound(t);
  await claimTask(f.run, f.persist, f.runId);
  const artifacts = packageLanding(f);
  f.run.repository.testReport = testReport;
  freeze(artifacts, ROWS);
  fs.writeFileSync(path.join(artifacts, 'test-bindings.json'), JSON.stringify(ROWS.slice(0, 2)));
  await assert.rejects(finishTask(f.run, f.stateFile, {code: 0, status: 'exited'}, artifacts), /BINDING_FROZEN_MISMATCH/);
  fs.rmSync(path.join(artifacts, 'test-bindings-receipt.json'));
  await assert.rejects(finishTask(f.run, f.stateFile, {code: 0, status: 'exited'}, artifacts), /BINDING_MISSING/);
  assert.equal(batches(f).length, 1);
});

test('host recomputation refuses unknown, failing and incomplete bindings', () => {
  const run = {repository: {id: 'app', testReport}};
  const objects = [{address: 'task:t1', document: {parent: 'ac:a1', data: {checks: ['c'], acceptance_checks: [{ac: 'ac:a1', check: 'c'}]}}}];
  const row = {task: 'task:t1', ac: 'ac:a1', check: 'c', test: ONE};
  for (const [rows, outcomes, code] of [
    [[row], {[TWO]: 'pass'}, /BINDING_NOT_IN_REPORT/],
    [[row], {[ONE]: 'fail'}, /BINDING_NOT_PASSED/],
    [[{...row, check: 'other'}], {[ONE]: 'pass'}, /BINDING_INVALID: bindings differ/],
    [[{...row, extra: 1}], {[ONE]: 'pass'}, /BINDING_INVALID: each binding/],
  ]) {
    const artifacts = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'crew-bindings-'));
    try {
      if (code.source.includes('each binding')) {
        fs.mkdirSync(path.join(artifacts, 'gates'));
        assert.throws(() => parseBindings(rows), code);
        continue;
      }
      freeze(artifacts, rows, {outcomes});
      assert.throws(() => frozenBindings(run, artifacts, objects), code);
    } finally { fs.rmSync(artifacts, {recursive: true, force: true}); }
  }
});

test('legacy Tasks and repositories without testReport keep completion with an evidence gap', () => {
  const legacy = [{address: 'task:t1', document: {parent: 'ac:a1', data: {}}}];
  const result = frozenBindings({repository: {id: 'app', testReport}}, null, legacy);
  assert.equal(result.status, 'legacy');
  assert.match(result.gaps[0], /^BINDING_MISSING: task:t1 has no data.acceptance_checks/);
  const current = [{address: 'task:t1', document: {parent: 'ac:a1', data: {checks: ['c'], acceptance_checks: [{ac: 'ac:a1', check: 'c'}]}}}];
  assert.match(frozenBindings({repository: {id: 'app'}}, null, current).gaps[0], /^BINDING_NO_REPORT/);
});

test('package budget counts the larger of the failure and completion batches', async t => {
  assert.equal(packageBudget(30, 40), 40);
  assert.throws(() => packageBudget(30, 41), /PACKAGE_BUDGET: 30 Tasks and 41 test node saves/);
  assert.throws(() => packageBudget(34, 0), /PACKAGE_BUDGET/);
  const f = await bound(t);
  const checks = Array.from({length: 96}, (_, index) => `c${index}`);
  Object.assign(f.objects.get('task:t1').document.data, {checks, acceptance_checks: checks.map(check => ({ac: 'ac:a1', check}))});
  await assert.rejects(claimTask(f.run, f.persist, f.runId), /PACKAGE_BUDGET: .*no write was sent/);
  assert.equal(batches(f).length, 0);
});

test('an acceptance row outside the Task parent, covers or checks claims nothing and never binds', async t => {
  const f = await bound(t);
  const task = f.objects.get('task:t1');
  task.document.data.acceptance_checks = [{ac: 'ac:unrelated', check: 'Run one => ok'}];
  await assert.rejects(claimTask(f.run, f.persist, f.runId), /BINDING_INVALID: task:t1 acceptance names ac:unrelated/);
  task.document.data.acceptance_checks = [{ac: 'ac:a1', check: 'invented check'}];
  await assert.rejects(claimTask(f.run, f.persist, f.runId), /BINDING_INVALID: task:t1 acceptance check is not a Task check/);
  assert.equal(batches(f).length, 0);
  // The host recomputes at completion. The reproduction returned bound before this check.
  const own = {address: 'task:x', document: {parent: 'ac:own', data: {checks: ['real check'],
    acceptance_checks: [{ac: 'ac:unrelated', check: 'invented check'}]}}};
  const artifacts = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'crew-bindings-'));
  t.after(() => fs.rmSync(artifacts, {recursive: true, force: true}));
  freeze(artifacts, [{task: 'task:x', ac: 'ac:unrelated', check: 'invented check', test: ONE}]);
  assert.throws(() => frozenBindings({repository: {id: 'app', testReport}}, artifacts, [own]), /BINDING_INVALID/);
});

test('a binding record of an earlier receipt does not survive a newer current receipt', async t => {
  const artifacts = fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'crew-bindings-'));
  t.after(() => fs.rmSync(artifacts, {recursive: true, force: true}));
  const objects = [{address: 'task:t1', document: {parent: 'ac:a1', data: {checks: ['c'], acceptance_checks: [{ac: 'ac:a1', check: 'c'}]}}}];
  const run = {repository: {id: 'app', testReport}};
  freeze(artifacts, [{task: 'task:t1', ac: 'ac:a1', check: 'c', test: ONE}]);
  assert.equal(frozenBindings(run, artifacts, objects).status, 'bound');
  // A later passing gate run for another tree and head becomes current. The old record and receipt stay valid alone.
  const newer = path.join(artifacts, 'gates', 'f2', 'receipt.json');
  fs.mkdirSync(path.dirname(newer));
  fs.writeFileSync(newer, JSON.stringify({passed: true, tree: 'd'.repeat(40), candidate_sha: 'e'.repeat(40)}));
  fs.writeFileSync(path.join(artifacts, 'gates', 'current.json'),
    JSON.stringify({receipt: '/workspace/runs/x/artifacts/gates/f2/receipt.json', sha256: digest(newer)}));
  assert.throws(() => frozenBindings(run, artifacts, objects), /BINDING_FROZEN_MISMATCH: the binding record does not name the current/);
});
