import test from 'node:test';
import assert from 'node:assert/strict';
import {authorize} from './structure-permissions.mjs';

const node = (address, parent) => ({address, kind: address.split(':')[0], current_revision: 3, historical: false,
  document: {present: true, parent, data: {}}});
const nodes = new Map([['domain:d', node('domain:d', null)], ['capability:c', node('capability:c', 'domain:d')],
  ['requirement:r', node('requirement:r', 'capability:c')], ['requirement:x', node('requirement:x', 'capability:c')]]);
const read = async address => structuredClone(nodes.get(address));
const config = {selection: {kind: 'ac', parent: 'domain:d'}, exclude_tags: [], publication: {
  create_kinds: ['source', 'ac', 'requirement', 'test'], update_kinds: ['ac'],
  structure: {create: {ac: ['context_parent', 'fresh_parent', 'created'], requirement: ['fresh_parent'], test: ['created']},
    move: {ac: ['fresh_parent', 'created'], test: ['created']}, note_created: true}}};
const assignment = () => ({selected: {address: 'ac:a', kind: 'ac', document: {parent: 'requirement:r', present: true, data: {}}},
  children: [], context: {parent: nodes.get('requirement:r')}, schema: {types: {ac: {parents: ['requirement']},
    requirement: {parents: ['capability']}, test: {parents: ['ac', 'test']}, source: {root: true}}}});
const create = (ref, kind, parent, data = {}) => ({ref, command: {op: 'save_object', kind, revision: 0, parent, data}});

test('structural creates run before the releases unless they use a create under a claimed parent', async () => {
  const rows = [create('s', 'source', null), create('part', 'ac', 'requirement:r', {sources: [{$ref: 's/address'}]}),
    create('part_test', 'test', {$ref: 'part/address'}), create('own', 'test', 'ac:a'),
    create('child', 'test', {$ref: 'own/address'}), create('chain', 'test', {$ref: 'child/address'}),
    {command: {op: 'note', target: {$ref: 'part/address'}, id: 'n', text: 'Part.'}}];
  const result = await authorize({config, assignment: assignment(), rows}, read);
  assert.deepEqual(result.early, [0, 1, 2]);
  assert.deepEqual(result.creates, [1, 2, 4, 5]); assert.deepEqual(result.notes, [6]);
});

test('the selected object cannot move under a create that runs after its release', async () => {
  const rows = [create('own', 'test', 'ac:a'),
    {command: {op: 'save_object', kind: 'ac', id: 'a', revision: 4, parent: 'requirement:x', data: {note: {$ref: 'own/address'}}}}];
  await assert.rejects(authorize({config, assignment: assignment(), rows}, read), /after its release/);
  // The same save without a parent change also becomes the release (verify2 case on ed5608b).
  for (const save of [{op: 'save_object', kind: 'ac', id: 'a', revision: 4, data: {note: {$ref: 'child/address'}}},
    {op: 'save_object', kind: 'ac', id: 'a', revision: 4, data: {note: {$ref: 'own/address'}}}])
    await assert.rejects(authorize({config, assignment: assignment(), rows: [create('own', 'test', 'ac:a'),
      create('child', 'test', {$ref: 'own/address'}), {command: save}]}, read), /after its release/);
  const fine = await authorize({config, assignment: assignment(), rows: [create('own', 'test', 'ac:a'),
    {command: {op: 'save_object', kind: 'ac', id: 'a', revision: 4, data: {stage: 's'}}}]}, read);
  assert.deepEqual(fine.early, []);
  const moved = await authorize({config, assignment: assignment(), rows: [create('req', 'requirement', 'capability:c'),
    {command: {op: 'save_object', kind: 'ac', id: 'a', revision: 4, parent: {$ref: 'req/address'}, data: {}}}]}, read);
  assert.deepEqual(moved, {creates: [0], moves: [1], notes: [], early: [0]});
});
