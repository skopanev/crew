import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './fixtures/joppa-stdio.mjs';
import {callJoppa} from '../joppa-api.mjs';
import {contractDigest} from '../joppa.mjs';

test('flat reads preserve authored links and native test evidence', async t => {
  const f = fixture(t), stateFile = path.join(f.root, 'state.json');
  const object = {address: 'work:one', kind: 'work', current_revision: 3,
    work_ready: true, remote_links_revision: 0,
    document: {revision: 3, parent: 'criterion:a', present: true,
      data: {body: 'Goal: Example', note: null, projects: [], title: 'Example'},
      links: [{blocking: true, relation: 'depends_on', revision: 2, target: 'work:before'}]},
    process: {}, annotations: {comments: {}}};
  const testNode = {...structuredClone(object), address: 'check:bound', kind: 'check',
    status: {tone: 'green'}, result: {address: 'example.test.js > passes', status: 'pass', commit: 'a'.repeat(40)}};
  testNode.document.data = {title: testNode.result.address};
  const state = {flat: true, compact: true, objects: {[object.address]: object, [testNode.address]: testNode}};
  const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
  save();
  const call = (tool, args) => callJoppa('https://service.invalid/mcp', undefined, tool,
    {workspace: 'sample', ...args}, {mcpCommand: [...f.command, stateFile]});
  const detail = await call('joppa_objects', {address: object.address});
  assert.equal(contractDigest(detail), contractDigest(object));
  assert.deepEqual(detail.document, object.document);
  assert.equal(detail.review_required, undefined);
  assert.equal(detail.work_ready, true);
  assert.equal(detail.process.assignee, undefined);
  assert.equal(detail.contract_revision, undefined);
  const testDetail = await call('joppa_objects', {address: testNode.address});
  assert.equal(testDetail.document.parent, 'criterion:a');
  assert.equal(testDetail.document.data.title, 'example.test.js > passes');
  assert.deepEqual(testDetail.result, testNode.result);
  assert.equal(testDetail.status.tone, 'green');
  object.document.present = false;
  object.document.links[0].revision = 3;
  save();
  const changed = await call('joppa_objects', {address: object.address});
  assert.equal(changed.document.present, false);
  assert.notEqual(contractDigest(changed), contractDigest(detail));
});
