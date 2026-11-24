import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {reservationReleased} from '../reservation-release.mjs';
import {nextTask, runHoldsTasks} from '../joppa.mjs';
import {packageFixture} from '../test-support/launcher-joppa.fixture.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-reservation-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const inner = path.join(root, 'run/2026-11-18_10-00-00-example');
  fs.mkdirSync(path.join(inner, 'artifacts'), {recursive: true});
  const journal = path.join(inner, 'journal.jsonl');
  fs.writeFileSync(journal, JSON.stringify({node: 'implement_code', next: 'prepare_review'}) + '\n');
  const run = {task: 'task:one', config: {worktreeRoot: path.join(root, 'worktrees')}, executionId: 'joppa-example',
    runFolder: path.dirname(inner), launchPgid: 2147483646, worker: {pid: 2147483646},
    result: {status: 'failed', held: true, finishedAt: new Date().toISOString()},
    claim: {assignee: 'crew-lane:host:old', tasks: [{address: 'task:one', revision: 3}]}};
  const object = {address: 'task:one', historical: false, current_revision: 4,
    document: {present: true, data: {stage: 'to_implement'}}};
  return {root, inner, journal, run, object};
}

test('a fresh operator release supersedes only the dead pre-landing reservation and preserves evidence', async t => {
  const f = fixture(t), original = structuredClone(f.run);
  assert.equal(runHoldsTasks(f.run), true);
  assert.equal(await reservationReleased(f.run, async () => f.object, () => true), true);
  assert.deepEqual(f.run, original);
  for (const edit of [o => o.current_revision = 3, o => o.historical = true,
    o => o.document.present = false, o => o.document.data.assignee = 'another-worker',
    o => o.address = 'task:other']) {
    const object = structuredClone(f.object); edit(object);
    assert.equal(await reservationReleased(f.run, async () => object, () => true), false);
  }
  assert.equal(await reservationReleased(f.run, async () => { throw Error('offline'); }, () => true), false);
  assert.equal(await reservationReleased(f.run, async () => f.object, () => false), false);
  assert.equal(await reservationReleased(f.run, async () => f.object, () => { throw Error('Docker offline'); }), false);
});

test('live workers, unknown claims and pending outcome or recovery operations keep the reservation', async t => {
  const f = fixture(t);
  for (const change of [r => r.worker.pid = process.pid, r => delete r.claim,
    r => delete r.result.finishedAt, r => r.result.publicationUncertain = true,
    ...['completionRequest', 'blockRequest', 'releaseRequest', 'recoveryNoteRequest'].map(key => r => r[key] = {}),
    r => r.recovery = {sha: 'a'.repeat(40)}]) {
    const run = structuredClone(f.run); change(run);
    assert.equal(await reservationReleased(run, async () => f.object, () => true), false);
  }
});

test('existing checkouts, malformed journals and any landing evidence require explicit recovery', async t => {
  const f = fixture(t), checkout = path.join(f.run.config.worktreeRoot, f.run.executionId);
  fs.mkdirSync(checkout, {recursive: true});
  assert.equal(await reservationReleased(f.run, async () => f.object, () => true), false);
  fs.rmdirSync(checkout);
  for (const rows of ['invalid\n', '{}\n', '', JSON.stringify({node: 'expert_review_synthesis', next: 'git_landing'})]) {
    fs.writeFileSync(f.journal, rows);
    assert.equal(await reservationReleased(f.run, async () => f.object, () => true), false);
  }
  fs.writeFileSync(f.journal, JSON.stringify({node: 'implement_code', next: 'prepare_review'}));
  for (const [name, content] of [['artifacts/landing.txt', 'published'], ['artifacts/verification.txt', 'verified'],
    ['artifacts/landing-log.json', '{}'], ['artifacts/origin.json', '{"signal":"PUBLICATION_UNCERTAIN"}'],
    ['outcome.json', '{"error":{"node":"cleanup"}}']]) {
    const file = path.join(f.inner, name); fs.writeFileSync(file, content);
    assert.equal(await reservationReleased(f.run, async () => f.object, () => true), false, name);
    fs.unlinkSync(file);
  }
  fs.unlinkSync(f.journal);
  assert.equal(await reservationReleased(f.run, async () => f.object, () => true), false);
});

test('nextTask reads a newer Joppa release before it excludes a finished held run', async t => {
  const f = await packageFixture(t), proof = fixture(t);
  f.run.config.worktreeRoot = proof.run.config.worktreeRoot;
  const run = {...proof.run, config: f.run.config, workspace: f.run.workspace, task: 'task:t1',
    claim: {assignee: 'crew-lane:host:old', tasks: [{address: 'task:t1', revision: 3}]}};
  const folder = path.join(f.root, 'runs/old'); fs.mkdirSync(folder, {recursive: true});
  const file = path.join(folder, 'launch.json'), raw = JSON.stringify(run);
  fs.writeFileSync(file, raw);
  const bins = path.join(proof.root, 'bin'); fs.mkdirSync(bins);
  fs.writeFileSync(path.join(bins, 'docker'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  const before = process.env.PATH; process.env.PATH = bins + ':' + before;
  t.after(() => { process.env.PATH = before; });
  assert.equal((await nextTask(f.run.config)).candidate.id, 'task:t2');
  f.objects.get('task:t1').current_revision = 4;
  assert.equal((await nextTask(f.run.config)).candidate.id, 'task:t1');
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
});

test('confirmed outcomes and current archived Tasks do not hold their former AC',()=>{
  const held={claim:{},result:{held:true,finishedAt:'2026-11-14T00:00:00Z'},completionRequest:{}};
  assert.equal(runHoldsTasks(held),true);
  assert.equal(runHoldsTasks(held,[{document:{present:false}}]),false);
  assert.equal(runHoldsTasks(held,[{document:{present:true}}]),true);
  for(const result of [{completed:true},{blockConfirmed:true}])assert.equal(runHoldsTasks({...held,result}),false);
});
