import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {save} from '../runtime.mjs';
import {configFrom} from '../launcher-config.mjs';
import {prepareDiscardCheckout, removeEmptyDiscardCheckout, discardFailedCheckout} from '../failed-checkout.mjs';
import {recordRetained, prepareReuse} from '../retained-checkout.mjs';
import {claimTask, finishTask, contractDigest} from '../joppa.mjs';
import {formatContexts, formatRecoveryNote, taskInput} from '../joppa-input.mjs';
import {packageFixture} from '../test-support/launcher-joppa.fixture.mjs';
import {setup} from '../test-support/launcher.fixture.mjs';
import {fakeDocker, stoppedPgid} from '../test-support/retained-checkout.fixture.mjs';

async function fixture(t) {
  const f = await packageFixture(t);
  t.after(fakeDocker(f.root));
  Object.assign(f.run.config, {discardFailedWorktree: true, worktreeRoot: path.join(f.root, 'worktrees')});
  f.run.tasks = [f.run.tasks[0]];
  await claimTask(f.run, f.persist, f.runId);
  const identity = prepareDiscardCheckout(f.run, f.persist), checkout = f.run.discardCheckout.path;
  f.run.launchPgid = stoppedPgid();
  const lines = [], announce = line => lines.push(line);
  return {...f, identity, checkout, lines, announce};
}

test('discard is opt-in and validates its config value', async t => {
  const f = await setup(t, {launchLanes: false});
  assert.equal(configFrom(f.configFile, f.env).discardFailedWorktree, false);
  save(f.configFile, {...f.config, discardFailedWorktree: true});
  assert.equal(configFrom(f.configFile, f.env).discardFailedWorktree, true);
  save(f.configFile, {...f.config, discardFailedWorktree: 'true'});
  assert.throws(() => configFrom(f.configFile, f.env), /discardFailedWorktree must be true or false/);
  assert.equal(prepareDiscardCheckout({config: {discardFailedWorktree: false}}, () => {}), '');
});

test('the host owns only a directory it creates, and removes an unused one before outcome writes', async t => {
  const f = await fixture(t), record = f.run.discardCheckout;
  assert.equal(f.identity, `${record.dev}:${record.ino}`);
  const other = {...f.run}; delete other.discardCheckout;
  assert.equal(prepareDiscardCheckout(other, () => {}), '');
  assert.equal(other.discardCheckout, undefined);
  removeEmptyDiscardCheckout(f.run, f.announce);
  assert.equal(fs.existsSync(f.checkout), false);
  assert.equal(f.run.discardCheckout.removed, true);
  assert.match(f.lines[0], /^run.sh: removed unused worktree:/);
  f.run.result = {status: 'failed', code: 2};
  discardFailedCheckout(f.run, f.stateFile, f.announce);
  assert.equal(f.lines.length, 1, 'an already absent checkout is a silent no-op');
});

test('uncertain, active, pre-existing and replaced checkouts are preserved', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.checkout, 'work.txt'), 'implementation');
  for (const result of [{status: 'failed', code: 2, held: true}, {status: 'failed', code: 73, blockConfirmed: true},
    {status: 'exited', code: 0, completed: true}]) {
    f.run.result = result;
    discardFailedCheckout(f.run, f.stateFile, f.announce);
    assert.equal(fs.readFileSync(path.join(f.checkout, 'work.txt'), 'utf8'), 'implementation');
  }
  f.run.result = {status: 'failed', code: 2, blockConfirmed: true};
  process.env.DOCKER_ROWS = JSON.stringify([{Mounts: [{Source: f.checkout}], Config: {Labels: {}}}]);
  discardFailedCheckout(f.run, f.stateFile, f.announce);
  assert.equal(fs.existsSync(f.checkout), true);
  process.env.DOCKER_ROWS = '[]';
  fs.renameSync(f.checkout, f.checkout + '-original');
  fs.mkdirSync(f.checkout);
  fs.writeFileSync(path.join(f.checkout, 'foreign.txt'), 'another run');
  discardFailedCheckout(f.run, f.stateFile, f.announce);
  assert.equal(fs.readFileSync(path.join(f.checkout, 'foreign.txt'), 'utf8'), 'another run');
  assert.match(f.run.discardCheckout.error, /identity changed/);
});

test('a confirmed timeout keeps findings in Joppa and discards its private branch without checkpointing', async t => {
  const f = await fixture(t);
  fs.mkdirSync(path.join(f.checkout, '.git/refs/heads'), {recursive: true});
  fs.writeFileSync(path.join(f.checkout, '.git/refs/heads/ticket-test'), 'local commit');
  fs.writeFileSync(path.join(f.checkout, 'work.txt'), 'implementation');
  const artifacts = path.join(f.run.runFolder, 'm1/artifacts');
  fs.mkdirSync(artifacts, {recursive: true});
  fs.writeFileSync(path.join(artifacts, 'failure.txt'), 'Coder exceeded the node deadline.\n');
  fs.writeFileSync(path.join(artifacts, 'origin.json'), JSON.stringify({node: 'implement_code', signal: '__timeout__'}));
  fs.writeFileSync(path.join(path.dirname(artifacts), 'journal.jsonl'), JSON.stringify({node: 'implement_code',
    signal: '__timeout__', timed_out: true, next: 'notify_failure'}) + '\n');
  fs.writeFileSync(path.join(artifacts, 'panel-findings.txt'), '- HIGH - Historical finding\n' + 'old'.repeat(10000) +
    '\n---\n- HIGH - Missing authorization - FIX: validate the actor\n' + '界'.repeat(10000) + '\n---\n');
  const result = {status: 'failed', code: 2};
  await finishTask(f.run, f.stateFile, result, artifacts);
  assert.equal(result.blockConfirmed, true);
  assert.equal(result.checkpointed, undefined);
  assert.equal(f.run.recovery, undefined);
  const notes = Object.values(f.objects.get('task:t1').annotations.comments);
  assert.ok(notes.some(note => note.text.includes('Missing authorization')));
  const note = notes.find(note => note.text.startsWith('CREW_FAILURE'));
  assert.ok(Buffer.byteLength(note.text, 'utf8') < 4096);
  assert.equal(note.text.includes('Historical finding'), false);
  assert.equal(note.text.includes('\uFFFD'), false);
  assert.ok(note.text.includes(`Full review: ${artifacts}/panel-findings.txt`));
  f.run.result = result; f.persist();
  discardFailedCheckout(f.run, f.stateFile, f.announce);
  assert.equal(fs.existsSync(f.checkout), false);
  assert.equal(fs.existsSync(f.run.discardCheckout.discardedPath), false);
  assert.equal(f.run.discardCheckout.removed, true);
  assert.equal(fs.existsSync(path.join(artifacts, 'panel-findings.txt')), true);
  assert.ok(prepareDiscardCheckout({...f.run, discardCheckout: undefined}, () => {}));
});

test('discard mode restores neither a retained checkout nor a prior recovery checkpoint', async t => {
  const f = await fixture(t), object = f.objects.get('task:t1'), contexts = f.run.claim.contexts;
  const recovery = {task: object.address, digest: contractDigest(object), contexts: formatContexts(contexts),
    ref: 'refs/heads/recovery/prior', sha: '1'.repeat(40), tree: '2'.repeat(40), base: '3'.repeat(40), runId: f.runId};
  object.annotations.comments.checkpoint = {actor: 'lane-1', text: formatRecoveryNote(recovery)};
  assert.ok(taskInput({...f.run.config, discardFailedWorktree: false}, object, contexts).ticket.recovery);
  assert.equal(taskInput(f.run.config, object, contexts).ticket.recovery, undefined);
  assert.equal(await prepareReuse(f.run, f.root, f.announce, f.persist), '');
  assert.equal(recordRetained(f.run, null), null);
});

test('a failed removal frees the ticket path and preserves the remaining files', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.checkout, 'work.txt'), 'implementation');
  f.run.result = {status: 'failed', code: 2, blockConfirmed: true};
  const remove = t.mock.method(fs, 'rmSync', () => { throw Object.assign(new Error('permission denied'), {code: 'EACCES'}); });
  try { discardFailedCheckout(f.run, f.stateFile, f.announce); }
  finally { remove.mock.restore(); }
  assert.equal(fs.existsSync(f.checkout), false);
  assert.equal(fs.readFileSync(path.join(f.run.discardCheckout.discardedPath, 'work.txt'), 'utf8'), 'implementation');
  assert.match(f.run.discardCheckout.error, /permission denied/);
  assert.ok(prepareDiscardCheckout({...f.run, discardCheckout: undefined}, () => {}));
});
