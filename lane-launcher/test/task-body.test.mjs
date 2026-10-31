import test from 'node:test';
import assert from 'node:assert/strict';
import {taskContract} from '../task-contract.mjs';
import {contractDigest} from '../joppa.mjs';

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
