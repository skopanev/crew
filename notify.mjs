#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const events = new Set(['READY', 'FAILED', 'BLOCKED', 'TIMEOUT']);
const clean = value => String(value ?? '').replace(/[\r\n|\x00-\x1f\x7f]/g, ' ').trim();

export function notify(config, event, send = execFileSync) {
  const route = config.notify;
  if (!route) return false;
  if (!route.to || !route.room) throw new Error('notify needs to and room in config');
  if (!events.has(event.event) || !event.id) throw new Error('notify needs a valid event and ticket ID');
  if (event.event === 'TIMEOUT' && (!event.node || !event.model)) {
    throw new Error('TIMEOUT needs node and model');
  }
  const details = ['node', 'model', 'exit', 'log']
    .filter(key => event[key] !== undefined)
    .map(key => `${key}=${clean(event[key])}`).join(' ') || '-';
  const message = `CREW ${event.event} | ${clean(event.id)} | ${clean(event.summary)} | ${details}`;
  send('agentbus', ['send', route.room, '--to', route.to, '--fyi', message], {
    encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'],
    env: {...process.env, ...(route.from ? {AGENTBUS_FROM: route.from} : {})},
  });
  return true;
}

export function completionEvent(run, result, artifacts) {
  const event = {event: result.code === 0 ? 'READY' : 'FAILED', id: run.ticket,
    summary: result.code === 0 ? 'Ticket ready for test' : 'Lane failed; inspect the report',
    exit: result.code ?? '?', log: path.join(path.dirname(run.runFolder), 'output.log')};
  if (result.code === 0 || !artifacts) return event;
  const failure = path.join(artifacts, 'failure.txt');
  const detail = fs.existsSync(failure) ? fs.readFileSync(failure, 'utf8') : '';
  const runDir = path.dirname(artifacts);
  const journalFile = path.join(runDir, 'journal.jsonl');
  const journal = fs.existsSync(journalFile) ? fs.readFileSync(journalFile, 'utf8')
    .trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  const timeout = [...journal].reverse().find(row => row.node !== 'notify_failure');
  if (timeout?.timed_out) {
    return {...event, event: 'TIMEOUT', summary: 'Lane stopped after a timeout',
      node: timeout.node, model: timeout.model || 'shell'};
  }
  if (timeout?.signal === 'TOO_MANY_ROUNDS' || /TIMEOUT|no verdict|нет вердикта/.test(detail)) {
    const steps = path.join(runDir, 'steps');
    const manifests = fs.existsSync(steps) ? fs.readdirSync(steps).sort().reverse()
      .map(name => ({name, file: path.join(steps, name, 'manifest.jsonl')}))
      .filter(item => fs.existsSync(item.file)) : [];
    const latest = manifests[0];
    if (latest) {
      const row = fs.readFileSync(latest.file, 'utf8').trim().split('\n').filter(Boolean)
        .map(JSON.parse).find(item => item.timed_out);
      if (row) return {...event, event: 'TIMEOUT', summary: 'Reviewer timed out; lane stopped',
        node: latest.name.replace(/^\d+-/, ''), model: row.model || row.input?.model || row.harness || 'unknown'};
    }
  }
  return {...event, summary: detail.split('\n')[0].slice(0, 300) || event.summary};
}

export function notifyCompletion(run, result, artifacts, send = execFileSync) {
  if (!run.config.notify) return false;
  return notify(run.config, completionEvent(run, result, artifacts), send);
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    const [configFile, event, id, summary, node, model] = process.argv.slice(2);
    if (!configFile || !event || !id || !summary) {
      throw new Error('Usage: node notify.mjs config.json READY|FAILED|BLOCKED|TIMEOUT ticket-id "summary" [node model]');
    }
    const sent = notify(JSON.parse(fs.readFileSync(configFile, 'utf8')), {event, id, summary, node, model});
    if (!sent) throw new Error('Notifications are not configured');
    console.log('Notification queued for messenger');
  } catch (error) {
    console.error(`notify: ${error.message}`);
    process.exitCode = 1;
  }
}
