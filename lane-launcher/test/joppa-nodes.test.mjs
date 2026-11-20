import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {saveNode, nodeAssignee, nodeStage, nodeFailed, validateFailedTaskStage, nodePages, roleKinds} from '../joppa-nodes.mjs';
import {contractDigest, sameContract, mutateTasks} from '../joppa-common.mjs';
import {fixture} from './fixtures/joppa-stdio.mjs';

const object = () => ({address: 'work:one', historical: false, current_revision: 7,
  document: {present: true, parent: 'criterion:a', links: [{target: 'work:before', relation: 'depends_on', blocking: true}],
    data: {title: 'Implement one change', body: 'Keep the approved scope.', owner: 'owner', custom: {keep: true}}}});

test('assignment saves send only the changed fields and require a current revision', () => {
  const node = object(), before = structuredClone(node);
  const command = saveNode(node, {assignee: 'crew-lane:host:run'}, 'Claim');
  // Joppa merges data and keeps the parent and relations, so a save sends no document echo.
  assert.deepEqual(command, {op: 'save_object', kind: 'work', id: 'one', revision: 7,
    data: {assignee: 'crew-lane:host:run'}, reason: 'Claim'});
  assert.deepEqual(node, before);
  node.document.data.assignee = 'crew-lane:host:run';
  assert.deepEqual(saveNode(node, {assignee: undefined, stage: 'review'}, 'Release').data, {assignee: null, stage: 'review'});
  node.document.present = false;
  assert.throws(() => saveNode(node, {}, 'Claim'), /current, present/);
});

test('execution metadata does not alter authored content checks', () => {
  const node = object(), original = contractDigest(node);
  node.current_revision++;
  node.document.data.assignee = 'crew-lane:host:run';
  node.document.data.commit = 'a'.repeat(40);
  assert.equal(contractDigest(node), original);
  for (const stage of ['to_implement', 'in_progress', 'done']) {
    node.document.data.stage = stage;
    assert.equal(contractDigest(node), original);
  }
  delete node.document.data.stage;
  assert.equal(contractDigest(node), original);
  node.document.data.body = 'Changed scope';
  assert.notEqual(contractDigest(node), original);

  const legacy = object();
  legacy.document.data.stage = 'to_implement';
  const snapshot = {revision: legacy.current_revision,
    digest: '1eae184d0d6c16a08d5eb17541cafc8a2e80d533fe0f027dbbd5fe0bc3306ae0'};
  const claim = {ticket: {parentContext: {address: legacy.address, data: structuredClone(legacy.document.data)}}};
  assert.equal(sameContract(legacy, snapshot), true);
  legacy.document.data.stage = 'in_progress';
  assert.equal(sameContract(legacy, snapshot), false);
  assert.equal(sameContract(legacy, snapshot, claim), true);
  legacy.document.data.body = 'Changed scope';
  assert.equal(sameContract(legacy, snapshot, claim), false);
  legacy.document.data.body = 'Keep the approved scope.';
  legacy.remote_links_revision = 1;
  assert.equal(sameContract(legacy, snapshot, claim), false);
});

test('native fields work in detail reads and named list fields', async () => {
  assert.equal(nodeAssignee({'data.assignee': 'worker'}), 'worker');
  assert.equal(nodeStage({'data.stage': 'review'}), 'review');
  assert.equal(nodeFailed({document: {data: {stage: 'review'}}}, 'review'), true);
  assert.equal(nodeFailed({'data.stage': 'ready'}, 'review'), false);
  assert.equal(nodeFailed({'data.stage': 'review'}, undefined), false);
  const calls = [];
  const read = async (tool, args) => {
    calls.push([tool, args]);
    if (tool === 'joppa_tree') return {schema: {types: {work: {role: 'task'}, criterion: {role: 'ac'}}}};
    return args.cursor ? {items: [{address: 'work:two'}]} : {items: [{address: 'work:one'}], next_cursor: 'work:one'};
  };
  const kinds = await roleKinds(read, 'task'), rows = [];
  for await (const page of nodePages(read, {kind: kinds, ready: true})) rows.push(...page.items);
  assert.deepEqual(rows.map(row => row.address), ['work:one', 'work:two']);
  assert(calls.slice(1).every(([tool, args]) => tool === 'joppa_objects' && args.limit === 25 && args.ready === true));
  await assert.rejects(async () => {
    for await (const _ of nodePages(async () => ({items: [], next_cursor: 'same'}), {})) {}
  }, /pagination did not advance/);
});

test('the failure stage must be an editable nonterminal stage of the native Task type', () => {
  const types = {work: {role: 'task', fields: {stage: {values: ['ready', 'review', 'done']}}}};
  assert.doesNotThrow(() => validateFailedTaskStage({FAILED_TASK_STAGE: 'review'}, types));
  for (const stage of [undefined, '', ' review', 'unknown', 'done']) {
    assert.throws(() => validateFailedTaskStage({FAILED_TASK_STAGE: stage}, types), /FAILED_TASK_STAGE/);
  }
  types.work.fields.stage.from = 'children';
  assert.throws(() => validateFailedTaskStage({FAILED_TASK_STAGE: 'review'}, types), /FAILED_TASK_STAGE/);
});

test('mixed mutation receipts validate saves and non-save commands without invented objects', async t => {
  const f = fixture(t), stateFile = path.join(f.root, 'native.json');
  const save = saveNode(object(), {assignee: undefined, commit: 'a'.repeat(40)}, 'Done');
  const archive = {op: 'archive_object', target: 'work:one', revision: 8, reason: 'Done'};
  const result = {results: [{command: {op: 'save_object'}, object: {address: 'work:one', revision: 8}},
    {command: archive}]};
  const run = {config: {joppa: {url: 'https://service.invalid/mcp', mcpCommand: [...f.command, stateFile]}}, joppaWorker: {}};
  const request = {operations: [{command: save}, {command: archive}]};
  const write = () => fs.writeFileSync(stateFile, JSON.stringify({responses: {joppa_batch: result}}));
  write();
  await mutateTasks(run, request);
  result.results[1].command = {...archive, target: 'work:other'};
  write();
  await assert.rejects(mutateTasks(run, request), /does not map/);
});
