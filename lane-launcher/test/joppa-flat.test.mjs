import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './fixtures/joppa-stdio.mjs';
import {callJoppa} from '../joppa-api.mjs';
import {contractDigest} from '../joppa.mjs';

test('flat reads preserve authored pins, queue identity and recorded test evidence', async t => {
  const f = fixture(t), stateFile = path.join(f.root, 'state.json');
  const object = {address: 'work:one', kind: 'work', current_revision: 3, contract_revision: 3,
    work_ready: true, review_required: false, remote_links_revision: 0,
    document: {revision: 3, parent: 'criterion:a', present: true,
      data: {body: 'Goal: Example', note: null, projects: [], title: 'Example'},
      links: [{blocking: true, relation: 'depends_on', revision: 2, target: 'work:before'}]},
    process: {status: 'open'}, annotations: {comments: {}}};
  const row = {status: 'green', tests_revision: 3,
    values: {asset: {server: {status: 'green'}}},
    tests: [{address: 'example.test.js > passes', status: 'pass', commit: 'a'.repeat(40)}]};
  const state = {flat: true, compact: true, objects: {[object.address]: object}, responses: {
    joppa_tasks: {items: [{address: object.address, parent: 'criterion:a', revision: 3, status: 'open'}], total: 1},
    joppa_tests: row}};
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
  save();
  const call = (tool, args) => callJoppa('https://service.invalid/mcp', undefined, tool,
    {workspace: 'sample', ...args}, {mcpCommand: [...f.command, stateFile]});
  const detail = await call('joppa_objects', {address: object.address});
  assert.equal(contractDigest(detail), contractDigest(object));
  assert.deepEqual(detail.document, object.document);
  assert.equal(detail.review_required, false);
  assert.equal(detail.work_ready, true);
  assert.equal(detail.process.assignee, null);
  const queue = await call('joppa_tasks', {view: 'all'});
  assert.equal(queue.tasks[0].ac, 'criterion:a');
  assert.equal(queue.tasks[0].claimable, false);
  const tests = await call('joppa_tests', {ac: 'criterion:a'});
  assert.equal(tests.address, 'criterion:a');
  assert.equal(tests.tests_draft, false);
  assert.deepEqual(tests.tests, row.tests);
  state.responses.joppa_tests = {items: [{...row, address: 'criterion:a'}, {address: 'criterion:b', status: 'grey'}]};
  save();
  const batch = await call('joppa_tests', {ac: 'criterion:a,criterion:b'});
  assert.deepEqual(batch.items.map(item => item.address), ['criterion:a', 'criterion:b']);
  assert.deepEqual(batch.items[0].tests, row.tests);
  assert.deepEqual(batch.items[1].tests, []);
  object.document.present = false;
  object.document.links[0].revision = 3;
  save();
  const changed = await call('joppa_objects', {address: object.address});
  assert.equal(changed.document.present, false);
  assert.notEqual(contractDigest(changed), contractDigest(detail));
});
