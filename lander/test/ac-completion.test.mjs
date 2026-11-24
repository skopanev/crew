import test from 'node:test';
import assert from 'node:assert/strict';
import {completeACs, completionPolicy} from '../ac-completion.mjs';

const clone = value => structuredClone(value), commit = 'a'.repeat(40);
function fixture() {
  const schema = {types: {
    criterion: {role: 'ac', fields: {stage: {values: ['review', 'complete']}}},
    work: {role: 'task', parents: ['criterion'], fields: {stage: {values: ['queued', 'finished']}}},
    check: {role: 'test', parents: ['criterion']},
  }};
  const node = (address, stage, live = true) => ({address, kind: address.split(':')[0], current_revision: 3,
    historical: false, status: {tone: 'green'}, document: {present: live, parent: 'criterion:c', data: {stage}}});
  const ac = node('criterion:c', 'review'); ac.document.parent = null;
  const task = node('work:landed', 'finished', false); task.document.data.commit = commit;
  const check = node('check:one'); check.result = {status: 'pass', commit};
  const objects = new Map([ac, task, check].map(row => [row.address, row]));
  const config = {workspace: 'fixture', DONE_TASK_STAGE: 'finished',
    publication: {allowed_operations: ['save_object'], update_kinds: ['work', 'criterion']}, ac_completion: {
    kind: 'criterion', task_kinds: ['work'], test_kinds: ['check'], relation: 'parent', done_stage: 'complete'}};
  const input = {items: [clone(task)]}, state = {landed: commit, checked: {commit}, accepted: [{address: task.address}]};
  const result = {claim_released: true}, writes = [], receipts = new Map();
  let onWrite = () => {}, onMany = () => {};
  const read = async (tool, args) => {
    if (tool === 'joppa_tree') return {schema};
    if (args.address) return clone(objects.get(args.address));
    return {items: [...objects.values()].filter(row => row.document.present && args.kind.includes(row.kind) &&
      (!args.status || args.status.includes(row.status?.tone ?? row.status)) &&
      (args.relations_of ? row.relations?.[args.relation]?.edges?.some(edge => edge.to === args.relations_of)
        : row.document.parent === args.parent)).map(row =>
      ({address: row.address, revision: row.current_revision, parent: row.document.parent})), next_cursor: null};
  };
  const many = async addresses => { onMany(addresses); return addresses.map(address => clone(objects.get(address))); };
  const write = async request => {
    if (receipts.has(request.request_id)) return clone(receipts.get(request.request_id));
    for (const {command} of request.operations) assert.equal(objects.get(command.kind + ':' + command.id).current_revision,
      command.revision, 'stale object revision');
    writes.push(clone(request));
    const results = request.operations.map(({command}) => {
      const row = objects.get(command.kind + ':' + command.id);
      if (command.data) { Object.assign(row.document.data, command.data); row.current_revision++; }
      return {command, object: {address: row.address, revision: row.current_revision}};
    });
    receipts.set(request.request_id, clone({results}));
    if (writes.length === 1) onWrite();
    return {results};
  };
  return {schema, config, input, state, result, ac, task, check, objects, writes, node,
    run: () => {
      const attempt = {outcomes: []};
      state.ac_completion ??= []; state.ac_completion.push(attempt);
      return completeACs(config, input, state, result, {read, many, write,
        persist: outcomes => { attempt.outcomes = clone(outcomes); }});
    },
    onWrite: callback => { onWrite = callback; }, onMany: callback => { onMany = callback; }};
}

test('confirmed landing closes the configured AC and preserves archived Tasks and Test evidence', async () => {
  const f = fixture(), evidence = clone(f.check);
  const [outcome] = await f.run();
  assert.equal(outcome.status, 'done');
  assert.equal(f.ac.document.data.stage, 'complete');
  assert.equal(f.task.document.present, false);
  assert.deepEqual(f.check, evidence);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].operations[0].command.data, undefined, 'The Test CAS is an empty save');
  assert.ok(f.writes.flatMap(row => row.operations).every(row => row.command.op === 'save_object'));
});

for (const state of ['fail', 'skip', 'todo', 'missing', 'missing-commit', 'live-task', 'assigned-task', 'no-tests']) {
  test(`${state} leaves the AC open`, async () => {
    const f = fixture();
    if (['fail', 'skip', 'todo'].includes(state)) f.check.result.status = state;
    if (state === 'missing') delete f.check.result;
    if (state === 'missing-commit') delete f.check.result.commit;
    if (state === 'no-tests') f.objects.delete(f.check.address);
    if (['live-task', 'assigned-task'].includes(state)) {
      const task = f.node('work:other', state === 'live-task' ? 'queued' : 'finished');
      if (state === 'assigned-task') task.document.data.assignee = 'other-worker';
      f.objects.set(task.address, task);
    }
    const [outcome] = await f.run();
    assert.equal(outcome.status, 'waiting');
    assert.equal(f.ac.document.data.stage, 'review');
    assert.equal(f.writes.length, 0);
  });
}

for (const race of ['new-task', 'failed-result', 'changed-child']) {
  test(`${race} after publication restores the previous AC stage`, async () => {
    const f = fixture();
    f.onWrite(() => {
      if (race === 'new-task') f.objects.set('work:new', f.node('work:new', 'queued'));
      else if (race === 'failed-result') { f.check.result.status = 'fail'; f.ac.status.tone = 'red'; }
      else f.onMany(addresses => { if (addresses.includes(f.check.address)) f.check.current_revision++; });
    });
    const [outcome] = await f.run();
    assert.equal(outcome.status, 'reopened');
    assert.equal(f.ac.document.data.stage, 'review');
    assert.equal(f.writes.length, 2);
    if (race === 'failed-result') assert.equal(f.check.result.status, 'fail');
  });
}

test('an owner edit after publication is preserved', async () => {
  const f = fixture();
  f.onWrite(() => { f.ac.current_revision++; f.ac.document.data.stage = 'review'; f.ac.document.data.body = 'Owner update';
    f.objects.set('work:new', f.node('work:new', 'queued')); });
  const [outcome] = await f.run();
  assert.equal(outcome.status, 'owner_changed');
  assert.equal(f.ac.document.data.body, 'Owner update');
  assert.equal(f.writes.length, 1);
});

for (const kind of ['work', 'check']) for (const status of [undefined, 'gray']) {
  test(`${kind} with ${status} status remains an AC completion input`, async () => {
    const f = fixture(), child = f.node(kind + ':unknown', 'queued');
    child.status = status; f.objects.set(child.address, child);
    assert.equal((await f.run())[0].status, 'waiting');
    assert.equal(f.writes.length, 0);
  });
}

test('a lost response replays the saved request before restoring an incomplete AC', async () => {
  const f = fixture();
  f.onWrite(() => {
    f.objects.set('work:new', f.node('work:new', 'queued'));
    throw new Error('Response lost after commit');
  });
  const [first] = await f.run();
  assert.equal(first.status, 'unresolved'); assert.equal(first.needs_recovery, true);
  assert.equal(f.ac.document.data.stage, 'complete');
  const [second] = await f.run();
  assert.equal(second.status, 'reopened'); assert.equal(second.needs_recovery, false);
  assert.equal(second.request.request_id, first.request.request_id);
  assert.equal(f.ac.document.data.stage, 'review'); assert.equal(f.writes.length, 2);
  assert.equal((await f.run())[0].status, 'waiting');
});

test('an owner stage edit cannot produce a done report even when all inputs pass', async () => {
  const f = fixture();
  f.onWrite(() => { f.ac.document.data.stage = 'review'; f.ac.current_revision++; });
  assert.equal((await f.run())[0].status, 'owner_changed');
  assert.equal(f.writes.length, 1); assert.equal(f.ac.document.data.stage, 'review');
});

test('no confirmed publication or disabled policy produces no AC writes', async () => {
  for (const mode of ['disabled', 'not-landed', 'unreleased', 'recovery']) {
    const f = fixture();
    if (mode === 'disabled') delete f.config.ac_completion;
    if (mode === 'not-landed') delete f.state.landed;
    if (mode === 'unreleased') f.result.claim_released = false;
    if (mode === 'recovery') f.result.needs_recovery = true;
    assert.deepEqual(await f.run(), []);
    assert.equal(f.writes.length, 0);
  }
});

test('configuration must cover every native Task and Test kind and use editable stages', () => {
  const f = fixture();
  assert.ok(completionPolicy(f.config, f.schema));
  f.schema.types.otherWork = {...f.schema.types.work};
  assert.throws(() => completionPolicy(f.config, f.schema), /omits a native child type/);
  delete f.schema.types.otherWork;
  f.schema.types.criterion.fields.stage.from = 'children';
  assert.throws(() => completionPolicy(f.config, f.schema), /editable AC completion stage/);
});

test('configured relations work without a containment parent', async () => {
  const f = fixture();
  f.schema.relations = {implements: {title: 'Implements'}};
  f.config.ac_completion.relation = 'implements';
  for (const node of [f.task, f.check]) {
    node.document.parent = null;
    node.relations = {implements: {edges: [{to: f.ac.address}]}};
  }
  f.input.items = [clone(f.task)];
  assert.equal((await f.run())[0].status, 'done');
});

test('a changed Task commit or contract cannot close the original AC', async () => {
  for (const field of ['commit', 'body']) {
    const f = fixture();
    f.task.document.data[field] = field === 'commit' ? 'b'.repeat(40) : 'Another contract';
    assert.deepEqual(await f.run(), []);
    assert.equal(f.writes.length, 0);
  }
});
