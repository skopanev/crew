import test from 'node:test';
import assert from 'node:assert/strict';
import {taskContract} from '../task-contract.mjs';
import {contractDigest} from '../joppa.mjs';
import {dependencyCheck, remoteDependencyBlocker} from '../dependencies.mjs';
import {fixture} from '../test-support/requirement-delivery.fixture.mjs';

test('Task rendering reads full body and keeps historical contracts readable', () => {
  const body = 'Goal: output\n\nRepository: service\nModule: core\n\nHow:\n1. Reuse the mechanism.\n\nChecks:\nRequired output';
  assert.equal(taskContract({body}), body);
  assert.equal(taskContract({contract: body}), body);
  const structured = {body: 'Goal: output', repository: 'service', module: 'core',
    steps: ['Reuse the mechanism.'], checks: ['Required output']};
  const before = structuredClone(structured);
  assert.equal(taskContract(structured), body);
  assert.deepEqual(structured, before);
  assert.throws(() => taskContract({body: '', contract: body}), /implementation contract/);
  assert.throws(() => taskContract({body: null, contract: body}), /implementation contract/);
});

test('body migration changes the raw digest and does not conceal later edits', () => {
  const object = {current_revision: 3, contract_revision: 3,
    document: {parent: 'criterion:a', data: {contract: 'Required output'}, links: []}};
  const before = contractDigest(object);
  object.document.data = {body: 'Required output'};
  assert.notEqual(contractDigest(object), before);
  const migrated = contractDigest(object);
  object.document.data.body += ' Changed output.';
  assert.notEqual(contractDigest(object), migrated);
});

test('a local dependency without a revision still needs its current target to finish', async () => {
  const f = fixture(), target = f.objects.get('work:two');
  target.review_required = false;
  f.objects.get('work:one').document.links = [{target: target.address, relation: 'depends_on', blocking: true}];
  assert.equal((await dependencyCheck(f.read)('work:one')).ready, true);
  delete target.process.done;
  target.process.status = 'open';
  assert.deepEqual(await dependencyCheck(f.read)('work:one'), {ready: false, blocker: target.address});
  target.process.done = 'Completed';
  target.process.status = 'done';
  f.objects.get('work:one').document.links[0].revision = 0;
  assert.equal((await dependencyCheck(f.read)('work:one')).ready, false);
  const remote = {remote_links: [{workspace: 'other', target: 'work:remote', relation: 'depends_on', blocking: true,
    status: {access: true, present: true, satisfied: true, review_required: false, current_revision: 1}}]};
  assert.equal(remoteDependencyBlocker(remote), '@other/work:remote');
});
