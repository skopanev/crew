import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {claimTask, guardTaskClaims, finishTask} from '../joppa.mjs';
import {packageFixture, packageLanding} from '../test-support/launcher-joppa.fixture.mjs';

const exec = promisify(execFile);
async function fixture(t) {
  const f = await packageFixture(t);
  f.schema.types.evidence = {source: true, role: 'document'};
  f.schema.types.ac.references = {basis: {target: 'evidence', multiple: true}};
  for (const id of ['s1', 's2', 's3']) {
    const address = `evidence:${id}`;
    f.objects.set(address, {address, kind: 'evidence', historical: false, current_revision: 3,
      document: {present: true, parent: null, data: {title: id, body: `Exact decision ${id}`}, links: []},
      files: [{id: 'file1', name: 'decision.txt', hash: 'hash1', url: 'https://example.invalid/credential'}]});
  }
  for (const ac of ['ac:a1', 'ac:a2']) f.objects.get(ac).document.data.basis = ['s1', 'evidence:s2', 'evidence:s3'];
  return f;
}

test('the claim gives one copy of three Sources to the Task reader without signed file URLs', async t => {
  const f = await fixture(t);
  await claimTask(f.run, f.persist, f.runId);
  const ticket = f.run.claim.ticket;
  assert.equal(ticket.sources.length, 3);
  assert.deepEqual(ticket.sources.map(item => item.body), ['Exact decision s1', 'Exact decision s2', 'Exact decision s3']);
  assert.equal(ticket.tasks[0].sources, undefined);
  assert.deepEqual(ticket.sources[0].files, [{id: 'file1', name: 'decision.txt', hash: 'hash1'}]);
  assert.equal(ticket.sources[0].filesFetched, false);
  assert(!JSON.stringify(ticket).includes('/credential'));
  assert.equal(f.run.claim.contexts.filter(item => item.source).length, 3);
  const batches = f.calls.filter(call => call.name === 'joppa_objects' && call.args.address?.includes('evidence:s1,'));
  assert.equal(batches.length, 1);
  const artifacts = path.join(f.root, 'artifacts');
  fs.mkdirSync(artifacts);
  fs.writeFileSync(path.join(artifacts, 'claim.json'), JSON.stringify(f.run.claim));
  const script = fileURLToPath(new URL('../../lane/bin/ticket-input.mjs', import.meta.url));
  const env = {...process.env, MEDULLA_RUN_DIR: f.root};
  const result = await exec(process.execPath, [script, '--read', ticket.id, '--workspace', 'fixture'], {env});
  assert.deepEqual(JSON.parse(result.stdout).sources, ticket.sources);
  await assert.rejects(exec(process.execPath, [script, '--read', 'evidence:s1', '--workspace', 'fixture'], {env}),
    error => /only the claimed Task or package/.test(error.stderr) && /sources, parentContext and coveredContexts/.test(error.stderr));
});

test('an attachment-only Source change refuses startup, landing and completion', async t => {
  const f = await fixture(t);
  f.run.tasks = [f.run.tasks[0]];
  await claimTask(f.run, f.persist, f.runId);
  const artifacts = packageLanding(f);
  fs.writeFileSync(path.join(artifacts, 'claim.json'), JSON.stringify({...f.run.claim, joppa_url: f.run.config.joppa.url}));
  const script = fileURLToPath(new URL('../../lane/bin/requirement-current.mjs', import.meta.url));
  const env = {...process.env, MEDULLA_RUN_DIR: f.root, REQUIREMENT_READER_FILE: f.run.joppaWorker.tokenFile};
  assert.match((await exec(process.execPath, [script, '--tasks'], {env})).stdout, /are current/);
  // An attachment can change without a new document revision. Signed URL changes are immaterial.
  f.objects.get('evidence:s1').files[0].url = 'https://example.invalid/new-credential';
  await guardTaskClaims(f.run, f.persist);
  f.objects.get('evidence:s1').files[0].id = 'replacement';
  await assert.rejects(guardTaskClaims(f.run, f.persist), /Acceptance context changed.*evidence:s1/);
  await assert.rejects(exec(process.execPath, [script, '--tasks'], {env}),
    error => /Acceptance context changed after claim: evidence:s1/.test(error.stderr));
  const result = {code: 0, status: 'exited'};
  await assert.rejects(finishTask(f.run, f.stateFile, result, artifacts), /acceptance context changed.*evidence:s1/);
  assert.equal(result.completed, undefined);
});

test('a covered AC supplies its Sources without following Source references', async t => {
  const f = await fixture(t);
  f.run.tasks = [f.run.tasks[0]];
  f.run.config.joppa.coversReference = 'covers';
  f.schema.types.task.references = {covers: {target: 'ac', multiple: true}};
  f.objects.get('task:t1').document.data.covers = ['ac:a2'];
  f.objects.get('ac:a1').document.data.basis = ['s1'];
  f.objects.get('evidence:s1').document.data.basis = ['not-fetched'];
  await claimTask(f.run, f.persist, f.runId);
  assert.equal(f.run.claim.ticket.sources.length, 3);
  assert.equal(f.run.claim.ticket.coveredContexts[0].address, 'ac:a2');
  assert(!f.calls.some(call => call.args.address?.includes('not-fetched')));
});

for (const mode of ['missing', 'archived', 'wrong-kind']) test(`an invalid Source stops claim preparation: ${mode}`, async t => {
  const f = await fixture(t);
  if (mode === 'missing') f.objects.delete('evidence:s1');
  if (mode === 'archived') f.objects.get('evidence:s1').document.present = false;
  if (mode === 'wrong-kind') f.objects.get('ac:a1').document.data.basis = ['task:t2'];
  await assert.rejects(claimTask(f.run, f.persist, f.runId), /SOURCE_CONTEXT_INVALID/);
  assert.equal(f.run.claim.ticket, undefined);
});
