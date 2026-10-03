#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const events = new Set(['READY', 'FAILED', 'BLOCKED', 'TIMEOUT']);
const clean = value => String(value ?? '').replace(/[\r\n|\x00-\x1f\x7f]/g, ' ').trim();

export async function notify(config, event) {
  const route = config.notify;
  if (!route) return false;
  if (!route.chatId) throw new Error('notify needs chatId in config');
  if (route.threadId !== undefined && (!Number.isSafeInteger(route.threadId) || route.threadId < 1)) {
    throw new Error('notify threadId must be a positive integer');
  }
  if (!events.has(event.event) || !event.id) throw new Error('notify needs a valid event and ticket ID');
  if (event.event === 'TIMEOUT' && (!event.node || !event.model)) {
    throw new Error('TIMEOUT needs node and model');
  }
  const stage = [event.node, event.signal, event.event === 'TIMEOUT' ? event.model : undefined]
    .filter(Boolean).map(clean).join(' · ');
  const summary = String(event.summary ?? '')
    .replace(/[\r\x00-\x09\x0b-\x1f\x7f]/g, '')
    .replace(/;?\s*full output:[^\n]*/gi, '')
    .replace(/^Lane exited [^\n]*$/gm, '')
    .replace(/(^|[\s('"])\/[^\s;,'")]+/g, '$1')
    .replace(/:\s*;/g, ';').replace(/ {2,}/g, ' ').trim();
  const header = `${event.event === 'READY' ? '🟢' : '🔴'} ${event.event}`;
  const ticketId = clean(event.id);
  const ticketLine = `Ticket: ${ticketId}`;
  const reason = summary || (event.event === 'READY' ? '' : clean(event.signal) || 'Failure details are unavailable');
  const message = [header, ticketLine, stage, reason && `Reason: ${reason}`]
    .filter(Boolean).join('\n');
  const token = process.env.TELEGRAM_BOT_TOKEN || (route.envFile &&
    fs.readFileSync(route.envFile, 'utf8').match(/^\s*(?:export\s+)?TELEGRAM_BOT_TOKEN\s*=\s*(.*?)\s*$/m)?.[1]
      .replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1'));
  if (!token) throw new Error('Telegram bot token missing: set TELEGRAM_BOT_TOKEN or notify.envFile');
  try {
    const destination = {chat_id: route.chatId,
      ...(route.threadId === undefined ? {} : {message_thread_id: route.threadId})};
    // Telegram limits each message; preserve every character across messages.
    for (let start = 0; start < message.length;) {
      let end = Math.min(start + 4000, message.length);
      if (end < message.length && /[\uD800-\uDBFF]/.test(message[end - 1])) end--;
      await send('sendMessage', JSON.stringify({...destination, text: message.slice(start, end),
        ...(start === 0 ? {entities: [
          {type: 'bold', offset: 0, length: header.length},
          {type: 'bold', offset: header.length + 1 + 'Ticket: '.length, length: ticketId.length},
        ]} : {})}));
      start = end;
    }
    async function send(method, body) {
      const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST', signal: AbortSignal.timeout(15_000),
        headers: {'Content-Type': 'application/json'}, body,
      });
      const reply = await response.json();
      if (!response.ok || reply.ok !== true) {
        throw new Error(`Telegram refused notification: ${reply.description || response.status}`);
      }
    }
  } catch (error) {
    throw new Error(String(error.message).replaceAll(token, '[redacted]'));
  }
  return true;
}

export function completionEvent(run, result, artifacts) {
  const event = {event: result.code === 0 ? 'READY' : 'FAILED', id: run.ticket,
    runId: path.basename(path.dirname(run.runFolder)),
    summary: result.code === 0 ? '' : result.error || '',
    exit: result.code ?? '?', log: path.join(path.dirname(run.runFolder), 'output.log')};
  if (result.blocked) return {...event, event: 'BLOCKED', summary: result.error};
  if (result.code === 0) return event;
  if (!artifacts) {
    // Startup refusals have no Medulla journal. Keep the complete refusal lines.
    if (fs.existsSync(event.log)) {
      const reasons = fs.readFileSync(event.log, 'utf8').split('\n')
        .filter(line => /^run\.sh: /.test(line) && !/^run\.sh: (sources RO:|worktree RW:|shared |memory on|removed )/.test(line));
      if (reasons.length) return {...event, node: 'startup', summary: reasons.join('\n')};
    }
    return event;
  }
  const failure = path.join(artifacts, 'failure.txt');
  const detail = fs.existsSync(failure) ? fs.readFileSync(failure, 'utf8') : '';
  const originFile = path.join(artifacts, 'origin.json');
  const legacy = /^lane stopped on (\S+) \(([^)]+)\) for \S+\. ([\s\S]*)$/.exec(detail);
  const origin = fs.existsSync(originFile) ? JSON.parse(fs.readFileSync(originFile, 'utf8'))
    : {node: legacy?.[1], signal: legacy?.[2], message: legacy?.[3] || detail};
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
  return {...event, node: origin.node, signal: origin.signal,
    summary: origin.message || event.summary};
}

export async function notifyCompletion(run, result, artifacts) {
  if (!run.config.notify) return false;
  return notify(run.config, completionEvent(run, result, artifacts));
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    const [configFile, event, id, summary, node, model] = process.argv.slice(2);
    if (!configFile || !event || !id || !summary) {
      throw new Error('Usage: node notify.mjs config.json READY|FAILED|BLOCKED|TIMEOUT ticket-id "summary" [node model]');
    }
    const sent = await notify(JSON.parse(fs.readFileSync(configFile, 'utf8')), {event, id, summary, node, model});
    if (!sent) throw new Error('Notifications are not configured');
    console.log('Notification sent to channel');
  } catch (error) {
    console.error(`notify: ${error.message}`);
    process.exitCode = 1;
  }
}
