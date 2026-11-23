import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {validate, review as reconcile} from './reconcile.mjs';
import {dryOutput, policy} from './control.mjs';
import {input, draft, review, node, kind} from './test-support/reconcile.fixture.mjs';

const publish = (state, plan, reviews = [review(plan), review(plan)]) => reconcile(state, plan, reviews, 'exact', kind, 'run-1', 'source-gap-cto');

test('keep/update/archive/create retain IDs and evidence and put the claimed parent first', () => {
  const state = input(), plan = draft(), before = structuredClone(state);
  validate(state, plan, kind);
  const value = publish(state, plan), commands = value.operations.map(row => row.command);
  assert.deepEqual(commands.map(row => row.op), ['save_object', 'save_object', 'archive_object', 'save_object']);
  assert.deepEqual(commands[0].data, {stage: 'to_task'});
  assert.deepEqual([commands[0].id, commands[0].revision], ['a', 11]);
  assert.deepEqual([commands[1].id, commands[1].revision, commands[1].data], ['u', 7, {body: plan.tests[1].data.body}]);
  assert.deepEqual([commands[2].target, commands[2].revision], ['test:r', 7]);
  assert.match(commands[2].reason, /Evidence: Current AC explicitly removes r/);
  assert.equal(commands[3].revision, 0); assert.equal(commands[3].parent, 'ac:a');
  assert.equal(commands[3].data.owner, 'ac-owner');
  assert.equal(commands.some(row => row.id === 'k'), false);
  assert.deepEqual(state, before);
  assert.ok(commands.every(row => !('clean' in row) && !('results' in (row.data || {})) && !('relations' in row)));
});

test('a plan accounts for every captured Test and refuses replacement IDs or duplicate titles', () => {
  const cases = [plan => plan.tests.shift(), plan => plan.retire.splice(0),
    plan => plan.tests[1].id = 'replacement', plan => plan.tests[2].id = 'k',
    plan => plan.tests[2].title = node('r').document.data.title,
    plan => plan.tests.push({...plan.tests[0]}), plan => plan.retire[0].evidence = ''];
  for (const change of cases) {
    const plan = draft(); change(plan);
    assert.throws(() => validate(input(), plan, kind));
  }
});

test('rewrites preserve case/owner/results, and schema limits still apply', () => {
  for (const data of [{case: 'replacement'}, {owner: 'replacement'}, {results: []}, {metadata: {}}, {assignee: null}, {body: 'x'.repeat(1001)}]) {
    const plan = draft(); Object.assign(plan.tests[1].data, data);
    assert.throws(() => validate(input(), plan, kind), /schema|case/);
  }
  const changedKeep = draft(); changedKeep.tests[0].data = {body: 'different'};
  assert.throws(() => validate(input(), changedKeep, kind), /Keep preserves/);
  for (const id of ['u', 'r']) {
    const state = input(); state.children.find(row => row.address === 'test:' + id).document.data.assignee = 'another-run';
    assert.throws(() => validate(state, draft(), kind), /held|unheld/);
  }
});

test('large unchanged final sets do not consume native mutation slots', () => {
  const state = input(); state.children = Array.from({length: 120}, (_, index) => node('k' + index));
  const plan = {tests: state.children.map(row => ({id: row.address.slice(5), action: 'keep', title: row.document.data.title})), retire: [], coverage: 'All 120 remain required.'};
  assert.equal(publish(state, plan).operations.length, 1);
  for (const row of plan.tests) { row.action = 'update'; row.data = {body: 'Changed'}; }
  assert.throws(() => validate(state, plan, kind), /one native batch/);
});

test('both critics review the exact final set and every retirement', () => {
  const state = input(), plan = draft();
  for (const change of [value => value.draft_digest = 'old', value => value.tests.pop(),
    value => value.tests[0].score = 11111, value => value.tests[0].score = '01111',
    value => value.tests[0] = null, value => value.retirements = [],
    value => value.retirements[0].agree = false, value => value.retirements[0].evidence = '',
    value => value.retirements[0] = null]) {
    const second = review(plan); change(second);
    const value = publish(state, plan, [review(plan), second]);
    assert.equal(value.approved, false);
    assert.equal(value.operations, undefined);
  }
  assert.throws(() => publish(state, plan, [review(plan)]), /Exactly two/);
});

test('a reviewed Source gap and incomplete AC coverage never publish Test changes', () => {
  for (const plan of [draft(), {tests: [], retire: [], coverage: 'GAP. The Source gives no refusal outcome.'}]) {
    const critic = {...review(plan), coverage: 'incomplete', coverage_gap_kind: 'ac', missing: ['The refusal outcome needs an owner decision.']};
    const value = publish(input(), plan, [critic, critic]);
    assert.equal(value.decision_required, true);
    assert.deepEqual(value.operations.map(row => row.command.op), ['save_object', 'note']);
    assert.ok(value.operations.every(row => row.command.kind !== 'test'));
    assert.deepEqual(dryOutput(value, true).operations, []);
    assert.equal(dryOutput(value, true).outcome.reason_code, 'DRY_RUN');
  }
  const plan = {tests: [], retire: [], coverage: 'GAP. Need a Source.'};
  assert.equal(publish(input(), plan).approved, false);
});

test('dry output is empty for approved and rejected business outcomes', () => {
  for (const value of [publish(input(), draft()), {operations: [{command: {op: 'note'}}], outcome: {reason_code: 'REJECTED', reason: 'Rejected'}}]) {
    assert.deepEqual(dryOutput(value, true).operations, []);
    assert.equal(dryOutput(value, false), value);
  }
});

test('a dry run requires the frozen central release policy before any claim', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'writer-policy-'));
  try {
    const config = path.join(folder, 'config.json');
    const env = {PLANNING_JOPPA_CONFIG: config, CREW_FLOW_STAGES: '/fixture/flow.py', REWORK_LIMIT: '3', TEST_KIND: kind,
      TEST_OPERATION: 'reconcile', DRY_RUN: 'true', SOURCE_GAP_TAG: 'source-gap-cto',
      AUTHOR_MODEL: 'author', CRITIC_CODEX_MODEL: 'first', CRITIC_SECOND_MODEL: 'second', CRITIC_SECOND_HARNESS: 'claude-code',
      FLOW_PUBLICATION: JSON.stringify({create_kinds: [kind], update_kinds: ['ac', kind], allowed_operations: ['save_object', 'archive_object', 'note']})};
    fs.writeFileSync(config, JSON.stringify({selection: {kind: 'ac'}, failure_notes: false}));
    assert.doesNotThrow(() => policy(env));
    fs.writeFileSync(config, JSON.stringify({selection: {kind: 'ac'}, failure_notes: true}));
    assert.throws(() => policy(env), /frozen failure_notes/);
    assert.throws(() => policy({...env, DRY_RUN: 'yes'}), /DRY_RUN/);
  } finally { fs.rmSync(folder, {recursive: true, force: true}); }
});
