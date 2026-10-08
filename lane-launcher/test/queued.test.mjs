import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {notify, completionEvent} from '../../notify.mjs';
import {queuedOutcome} from '../runtime.mjs';
import {statusFor, queuedStage} from '../dashboard.mjs';

function laneRun(t, outcome) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-queued-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const runFolder = path.join(root, 'launch/lane');
  const artifacts = path.join(runFolder, 'run-1/artifacts');
  fs.mkdirSync(artifacts, {recursive: true});
  if (outcome) fs.writeFileSync(path.join(artifacts, 'outcome.json'), JSON.stringify(outcome));
  return {runFolder, artifacts};
}

test('a queued lane is found as pending; landed and ordinary runs are not', t => {
  const queued = laneRun(t, {status: 'queued'});
  assert.equal(queuedOutcome(queued.runFolder).artifacts, queued.artifacts);
  assert.equal(queuedOutcome(queued.runFolder).train, null);
  assert.equal(queuedOutcome(laneRun(t, null).runFolder), null);
  assert.equal(queuedOutcome(laneRun(t, {status: 'landed'}).runFolder), null);
  assert.equal(queuedOutcome('/nonexistent/crew-queued'), null);
});

test('a queued lane is not reported READY by notification or dashboard', async t => {
  const {runFolder, artifacts} = laneRun(t, {status: 'queued'});
  const run = {ticket: 'T1', runFolder, config: {}};
  const queued = {code: 0, status: 'exited', outcome: 'queued'};
  const event = completionEvent(run, queued, null);
  assert.equal(event.event, 'QUEUED');
  assert.notEqual(event.event, 'READY');
  assert.equal(statusFor({result: queued}), 'QUEUED');
  assert.equal(queuedStage(run), 'pending landing');
  fs.writeFileSync(path.join(artifacts, 'train-result.json'), JSON.stringify({status: 'landed'}));
  assert.equal(queuedStage(run), 'train: landed');
  // An ordinary exit stays READY.
  assert.equal(completionEvent(run, {code: 0, status: 'exited'}, null).event, 'READY');
  assert.equal(statusFor({result: {code: 0, status: 'exited'}}), 'READY');
  const sent = [];
  const fetch = globalThis.fetch;
  process.env.TELEGRAM_BOT_TOKEN = 'fixture-token';
  globalThis.fetch = async (url, options) => {
    sent.push(JSON.parse(options.body).text);
    return {ok: true, json: async () => ({ok: true})};
  };
  t.after(() => { globalThis.fetch = fetch; delete process.env.TELEGRAM_BOT_TOKEN; });
  assert.equal(await notify({notify: {chatId: 1}}, event), true);
  assert.match(sent[0], /QUEUED \(pending landing\)/);
  assert.doesNotMatch(sent[0], /READY|landed/i);
  assert.doesNotMatch(sent[0], /Reason:/);
});
