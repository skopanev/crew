import fs from 'node:fs';
import path from 'node:path';
import {readRun, alive, runDirectories} from './runtime.mjs';

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

export function createDashboard(config, paint) {
  const state = {containers: [], counts: null, message: 'Checking tickets', error: null};
  let runs = [];
  function refresh() {
    runs = runDirectories(config.stateDir).flatMap(dir => {
      const run = optional(path.join(dir, 'launch.json'));
      return run ? [{dir, ...run}] : [];
    }).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }
  function lines(left, stopped = false) {
    const width = Math.max(30, process.stdout.columns || 80);
    for (const run of runs) {
      if (!run.result) Object.assign(run, optional(path.join(run.dir, 'launch.json')));
    }
    const recent = runs.slice(0, 15);
    const statusWidth = Math.max(6, ...recent.map(run => statusFor(run).length));
    const stageWidth = 32;
    const ticketWidth = Math.min(Math.max(8, width - statusWidth - stageWidth - 25),
      Math.max(6, ...recent.map(run => Array.from(plain(run.ticket)).length)));
    const runWidth = Math.max(8, width - statusWidth - ticketWidth - stageWidth - 17);
    const folders = new Set(runs.map(run => run.runFolder));
    const active = runs.filter(run => !run.result).length +
      state.containers.filter(container => !folders.has(container.runFolder)).length;
    const {counts} = state;
    const header = `DOLBER ${config.id} · Running lanes `;
    const output = [header + paint(active >= config.limit ? 'yellow' : 'available', `${active} of ${config.limit}`),
      clip(`workspace: ${config.workspace} · tags: ${config.tags.join(', ') || '(any)'} · strict: ${config.strict}`, width),
      counts ? clip(`Tickets: ${counts.total} total · ${counts.open} open${counts.blocked ? ' (blocked)' : ''} · ready to work: ${counts.ready}`, width) : 'Tickets: checking',
      clip(`prefer: ${config.preferTags.join(' → ') || '(none)'}`, width),
      '─'.repeat(width),
      `${'STATUS'.padEnd(statusWidth)}  ${'TICKET'.padEnd(ticketWidth)}  ${'STAGE'.padEnd(stageWidth)}  ${'RUN ID'.padEnd(runWidth)}  TIME`];
    const footer = state.error ? wrap(state.error, width).map(line => paint('red', line)) : wrap(state.message, width);
    // Keep the table inside the terminal when its window is short.
    const visible = runs.slice(0, Math.min(15, Math.max(0, (process.stdout.rows || 24) - 8 - footer.length)));
    for (const run of visible) {
      const {result, worker} = run;
      const status = statusFor(run);
      const tone = status === 'READY' ? 'available' : result ? 'red' : 'yellow';
      const stage = result ? (run.stage ||= stageFor(run)) : stageFor(run);
      const runId = path.basename(run.dir).slice(0, 8);
      const details = `${clip(run.ticket, ticketWidth).padEnd(ticketWidth)}  ${clip(stage, stageWidth).padEnd(stageWidth)}  ${runId.padEnd(runWidth)}  ${duration(worker?.startedAt || run.createdAt, result?.finishedAt || Date.now())}`;
      output.push(`${paint(status === 'LOST' ? 'red' : tone, status.padEnd(statusWidth))}  ${result ? paint('finished', details) : details}`);
    }
    if (!runs.length) output.push('No lane runs yet');
    output.push(...footer);
    output.push(stopped ? 'Stopped' : left == null ? 'Checking tickets · Ctrl+C to stop' :
      `Next check in ${paint('accent', `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`)} · Ctrl+C to stop`);
    return output.join('\n');
  }
  refresh();
  const restore = () => process.stdout.write('\x1b[?25h\x1b[?1049l');
  state.fail = message => {
    if (state.error === message) return;
    state.error = message;
    // Keep full dispatcher errors in the normal terminal scrollback.
    restore();
    console.error(`${new Date().toISOString()} ${paint('red', message)}`);
    process.stdout.write('\x1b[?1049h\x1b[?25l');
  };
  process.once('exit', restore);
  process.stdout.write('\x1b[?1049h\x1b[?25l');
  return {
    state, refresh,
    draw(left) { process.stdout.write('\x1b[H\x1b[J' + lines(left)); },
    close() {
      restore();
      process.off('exit', restore);
      process.stdout.write(lines(null, true) + '\n');
    },
  };
}
