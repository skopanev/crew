import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {notify, notifyCompletion, completionEvent} from '../../notify.mjs';
import {formatLaneLine} from '../lane-log.mjs';

const config = {notify: {to: 'messenger', room: 'conv.test', from: 'crew-test'}};
test('notification queues one literal message without invoking a shell', () => {
  let call;
  notify(config, {event: 'READY', id: 'T1', summary: 'Ready\nwith | $(literal)'},
    (...args) => { call = args; });
  assert.equal(call[0], 'agentbus');
  assert.deepEqual(call[1].slice(0, 5), ['send', 'conv.test', '--to', 'messenger', '--fyi']);
  assert.equal(call[1][5], 'CREW READY | T1 | Ready with   $(literal) | -');
  assert.equal(call[2].env.AGENTBUS_FROM, 'crew-test');
  assert.equal(call[2].shell, undefined);
  assert.equal(call[2].timeout, 15000);
});
test('disabled notifications skip artifact reads; send errors are not swallowed', () => {
  assert.equal(notifyCompletion({config: {}}, {}, '/missing'), false);
  assert.throws(() => notify(config, {event: 'TIMEOUT', id: 'T1'}, () => {}), /node and model/);
  assert.throws(() => notify(config, {event: 'FAILED', id: 'T1'}, () => {
    throw new Error('bus unavailable');
  }), /bus unavailable/);
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
