import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {notify, notifyCompletion, completionEvent} from '../../notify.mjs';
import {formatLaneLine} from '../lane-log.mjs';

const config = {notify: {chatId: '-100123', threadId: 7}};
function telegram(t, send) {
  const previous = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = 'fixture-token';
  t.after(() => {
    if (previous === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previous;
  });
  t.mock.method(globalThis, 'fetch', send);
}
test('notification sends one literal ticket and reason code directly to Telegram', async t => {
  let call;
  telegram(t, async (...args) => {
    call = args;
    return {ok: true, json: async () => ({ok: true})};
  });
  assert.equal(await notify(config, {event: 'FAILED', id: 'T1$(literal)', signal: 'GATE_FAIL',
    summary: 'private details', runId: 'private-run', log: '/private/output.log'}), true);
  assert.equal(call[0], 'https://api.telegram.org/botfixture-token/sendMessage');
  assert.equal(call[1].method, 'POST');
  const body = JSON.parse(call[1].body);
  assert.equal(body.chat_id, '-100123');
  assert.equal(body.message_thread_id, 7);
  assert.equal(body.text, '🔴 FAILED\nTicket: T1$(literal)\nReason: GATE_FAIL');
  assert.deepEqual(body.entities.map(e => body.text.slice(e.offset, e.offset + e.length)), ['🔴 FAILED', 'T1$(literal)']);
  assert.equal(call[1].signal.aborted, false);
});
test('disabled notifications skip artifact reads; send errors redact credentials and remain errors', async t => {
  assert.equal(await notifyCompletion({config: {}}, {}, '/missing'), false);
  await assert.rejects(notify(config, {event: 'TIMEOUT', id: 'T1'}), /node and model/);
  telegram(t, async () => { throw new Error('delivery failed for fixture-token'); });
  await assert.rejects(notify(config, {event: 'FAILED', id: 'T1'}), /delivery failed for \[redacted\]/);
});
test('preflight blocker notification includes the worktree reason without workflow artifacts', () => {
  const event = completionEvent({ticket: 'T1', runFolder: '/fixture/lane'},
    {code: 73, blocked: true, error: 'WORKTREE PREEXISTED: /fixture/.worktrees/T1'}, null);
  assert.equal(event.event, 'BLOCKED');
  assert.equal(event.summary, 'WORKTREE PREEXISTED: /fixture/.worktrees/T1');
});
test('completion distinguishes terminal timeouts from recovered ones', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'crew-notify-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const artifacts = path.join(root, 'lane/run/artifacts');
  fs.mkdirSync(artifacts, {recursive: true});
  fs.writeFileSync(path.join(artifacts, 'failure.txt'), 'Implementation failed');
  const run = {ticket: 'T1', runFolder: path.join(root, 'lane')};
  const journal = path.join(root, 'lane/run/journal.jsonl');
  const write = rows => fs.writeFileSync(journal, rows.map(JSON.stringify).join('\n'));
  write([{node: 'implement_code', model: 'coder', timed_out: true}, {node: 'notify_failure'}]);
  let event = completionEvent(run, {code: 2}, artifacts);
  assert.equal(event.event, 'TIMEOUT');
  assert.equal(event.node, 'implement_code');
  assert.equal(event.model, 'coder');
  write([{node: 'implement_code', timed_out: true}, {node: 'prepare_review', timed_out: false},
    {node: 'notify_failure'}]);
  assert.equal(completionEvent(run, {code: 2}, artifacts).event, 'FAILED');
  const steps = path.join(root, 'lane/run/steps/016-expert_review');
  fs.mkdirSync(steps, {recursive: true});
  fs.writeFileSync(path.join(steps, 'manifest.jsonl'), JSON.stringify({timed_out: true, model: 'reviewer'}));
  write([{node: 'reject_gate', signal: 'TOO_MANY_ROUNDS'}, {node: 'notify_failure'}]);
  event = completionEvent(run, {code: 2}, artifacts);
  assert.equal(event.event, 'TIMEOUT');
  assert.equal(event.node, 'expert_review');
  assert.equal(event.model, 'reviewer');
  assert.equal(completionEvent(run, {code: 0}, artifacts).event, 'READY');
});
test('timeout is bold red in the tab and plain in uncolored logs', () => {
  const line = '[lane] claude-code: TIMEOUT (reviewer, rc=124)';
  assert.equal(formatLaneLine(line, true), `\x1b[1;31m${line}\x1b[0m`);
  assert.equal(formatLaneLine(line, false), line);
});
