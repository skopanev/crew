import fs from 'node:fs';
import path from 'node:path';
import {readRun, alive, runDirectories} from './runtime.mjs';
import {completionEvent, reasonCode} from '../notify.mjs';

export function duration(start, end = Date.now()) {
  const seconds = Math.max(0, Math.floor((new Date(end) - new Date(start)) / 1000)) || 0;
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map(value => String(value).padStart(2, '0')).join(':');
}

const optional = file => {
  try { return readRun(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const plain = value => String(value).replace(/\x1b\[[0-9;]*m/g, '').replace(/[\x00-\x1f\x7f]/g, ' ');
const startFormat = new Intl.DateTimeFormat('sv-SE', {
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
const clip = (value, width) => {
  const text = Array.from(plain(value));
  return text.length > width ? text.slice(0, Math.max(0, width - 1)).join('') + '…' : text.join('');
};
const wrap = (value, width) => String(value).split(/\r?\n/).flatMap(line => {
  const text = Array.from(plain(line));
  const lines = [];
  do { lines.push(text.splice(0, width).join('')); } while (text.length);
  return lines;
});

function stageFor(run) {
  try {
    const dirs = fs.readdirSync(run.runFolder).sort().reverse();
    const dir = dirs.map(name => path.join(run.runFolder, name))
      .find(folder => fs.existsSync(path.join(folder, 'journal.jsonl')));
    if (!dir) return 'startup';
    const text = fs.readFileSync(path.join(dir, 'journal.jsonl'), 'utf8');
    const lines = text.split('\n').slice(0, -1).filter(Boolean);
    const row = lines.length ? JSON.parse(lines.at(-1)) : null;
    if (row) {
      if (run.result) {
        const origin = path.join(dir, 'artifacts/origin.json');
        if (run.result.code !== 0) {
          if (fs.existsSync(origin)) return JSON.parse(fs.readFileSync(origin, 'utf8')).node || row.node;
          return [...lines].reverse().map(line => JSON.parse(line))
            .find(entry => entry.node && entry.node !== 'notify_failure')?.node || row.node;
        }
        return row.node;
      }
      return row.next && !row.next.startsWith('__') ? row.next : row.node;
    }
    return fs.readdirSync(path.join(dir, 'steps')).sort().at(-1)?.replace(/^\d+-/, '') || 'startup';
  } catch (error) {
    if (error.code === 'ENOENT') return 'startup';
    throw error;
  }
}

function statusFor({result, worker}) {
  return result ? result.code === 0 && result.status === 'exited' ? 'READY' :
    result.blocked ? 'BLOCKED' : result.status === 'interrupted' ? 'INTERRUPTED' :
    result.error?.startsWith('CLAIM_REFUSED:') ? 'CLAIM_REFUSED' :
    result.error?.startsWith('CLAIM_UNCERTAIN:') ? 'CLAIM_UNCERTAIN' : 'FAILED' :
    worker ? alive(worker.pid) ? 'RUNNING' : 'LOST' : 'STARTING';
}

function reasonFor(run) {
  let artifacts;
  try {
    artifacts = fs.readdirSync(run.runFolder).sort().reverse()
      .map(name => path.join(run.runFolder, name, 'artifacts'))
      .find(folder => fs.existsSync(path.join(folder, 'failure.txt')));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return reasonCode(completionEvent(run, run.result, artifacts));
}

export function renderRunTable(rows, paint, reserved = 7, {identityLabel = 'TICKET', identityWidth} = {}) {
  const width = Math.max(30, process.stdout.columns || 80);
  const recent = [...rows].sort((a, b) => Number(b.active) - Number(a.active) ||
    Date.parse(b.start) - Date.parse(a.start)).slice(0, 30);
  const statusWidth = Math.min(8, Math.max(6, ...recent.map(row => row.status.length)));
  const ticketWidth = identityWidth || Math.max(6, ...recent.map(row => Array.from(plain(row.ticket)).length));
  const stageWidth = 24;
  const runWidth = Math.max(36, ...recent.map(row => row.runId.length));
  const rowHeight = Math.ceil((statusWidth + ticketWidth + stageWidth + runWidth + 37) / width);
  const visible = recent.slice(0, Math.max(0,
    Math.floor(((process.stdout.rows || 24) - reserved - rowHeight) / rowHeight)));
  const output = [`${'STARTED'.padEnd(19)}  ${identityLabel.padEnd(ticketWidth)}  ${'STATUS'.padEnd(statusWidth)}  ${'STAGE / REASON CODE'.padEnd(stageWidth)}  ${'RUN ID'.padEnd(runWidth)}  TIME`];
  for (const row of visible) {
    const date = new Date(row.start);
    const started = Number.isFinite(date.valueOf()) ? startFormat.format(date) : '—';
    const identity = `${started.padEnd(19)}  ${clip(row.ticket, ticketWidth).padEnd(ticketWidth)}`;
    const label = clip(row.status, statusWidth).padEnd(statusWidth);
    const details = `${clip(row.stage || '', stageWidth).padEnd(stageWidth)}  ${row.runId.padEnd(runWidth)}  ${duration(row.start, row.end || Date.now())}`;
    const success = ['READY', 'DECOMPOSED'].includes(row.status);
    const tone = row.active ? 'blue' : ['BLOCKED', 'NOT_READY', 'NEEDS_HUMAN', 'DEFERRED', 'HELD'].includes(row.status) ? 'yellow' : 'red';
    output.push(success ? paint('ready', `${identity}  ${label}  ${details}`) :
      `${row.active ? identity : paint('finished', identity)}  ${paint(tone, label)}  ${row.active ? details : paint('finished', details)}`);
  }
  if (!rows.length) output.push('No runs yet');
  return output;
}

export function createScreen(state, paint, render) {
  const restore = () => process.stdout.write('\x1b[?25h\x1b[?1049l');
  state.fail = message => {
    if (state.error === message) return;
    state.error = message;
    restore();
    console.error(`${new Date().toISOString()} ${paint('red', message)}`);
    process.stdout.write('\x1b[?1049h\x1b[?25l');
  };
  process.once('exit', restore);
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  return {
    draw(left) { process.stdout.write('\x1b[H\x1b[J' + render(left)); },
    close() {
      restore();
      process.off('exit', restore);
      process.stdout.write(render(null, true) + '\n');
    },
  };
}

export function createDashboard(config, paint) {
  const state = {containers: [], counts: null, message: 'Checking tickets', error: null};
  let runs = [];
  function refresh() {
    runs = runDirectories(config.stateDir).flatMap(dir => {
      const run = optional(path.join(dir, 'launch.json'));
      return run ? [{dir, ...run}] : [];
    });
  }
  function lines(left, stopped = false) {
    const width = Math.max(30, process.stdout.columns || 80);
    for (const run of runs) {
      if (!run.result) Object.assign(run, optional(path.join(run.dir, 'launch.json')));
    }
    runs.sort((a, b) => Number(Boolean(a.result)) - Number(Boolean(b.result)) ||
      Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const folders = new Set(runs.map(run => run.runFolder));
    const active = runs.filter(run => !run.result).length +
      state.containers.filter(container => !folders.has(container.runFolder)).length;
    const {counts} = state;
    const header = `DOLBER ${config.id} · Running lanes `;
    const output = [header + paint(active >= config.limit ? 'yellow' : 'available', `${active} of ${config.limit}`),
      clip(config.source === 'joppa' ? `workspace: ${config.workspace} · project: ${config.joppa.project} · purpose: implementation` :
        `workspace: ${config.workspace} · tags: ${config.tags.join(', ') || '(any)'} · strict: ${config.strict}`, width),
      counts ? clip(config.source === 'joppa' ? `Tasks: ${counts.ready} available · ${counts.held} held workers` :
        `Tickets: ${counts.open} open${counts.blocked ? ' (blocked)' : ''} · ready to work: ${counts.ready}`, width) : 'Tickets: —',
      clip(config.source === 'joppa' ? `Source: Joppa · delivery: ${config.delivery}` : `prefer: ${config.preferTags.join(' → ') || '(none)'}`, width),
      '─'.repeat(width)];
    const footer = state.error ? wrap(state.error, width).map(line => paint('red', line)) : wrap(state.message, width);
    const rows = runs.slice(0, 30).map(run => {
      const {result, worker} = run;
      const status = statusFor(run);
      const stage = result ? (status === 'READY' ? '' : (run.reason ||= reasonFor(run))) : stageFor(run);
      return {ticket: run.ticket, status, stage, runId: path.basename(run.dir),
        start: worker?.startedAt || run.createdAt, end: result?.finishedAt, active: !result && status !== 'LOST'};
    });
    output.push(...renderRunTable(rows, paint, 7 + footer.length));
    output.push(...footer);
    output.push(stopped ? 'Stopped' : left == null ? 'Checking tickets · Ctrl+C to stop' :
      `Next check in ${paint('accent', `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`)} · Ctrl+C to stop`);
    return output.join('\n');
  }
  refresh();
  return {
    state, refresh,
    ...createScreen(state, paint, lines),
  };
}
