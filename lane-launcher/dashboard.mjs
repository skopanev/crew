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
    const ticketWidth = Math.max(8, width - 31);
    for (const run of runs) {
      if (!run.result) Object.assign(run, optional(path.join(run.dir, 'launch.json')));
    }
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
      `STATUS           ${'TICKET'.padEnd(ticketWidth)}  TIME`];
    const footer = state.error ? wrap(state.error, width).map(line => paint('red', line)) : wrap(state.message, width);
    // Keep the table inside the terminal when its window is short.
    const visible = runs.slice(0, Math.min(15, Math.max(0, (process.stdout.rows || 24) - 8 - footer.length)));
    for (const run of visible) {
      const {result, worker} = run;
      const status = result ? result.code === 0 && result.status === 'exited' ? 'READY' :
        result.blocked ? 'BLOCKED' : result.status === 'interrupted' ? 'INTERRUPTED' :
        result.error?.startsWith('CLAIM_REFUSED:') ? 'CLAIM_REFUSED' :
        result.error?.startsWith('CLAIM_UNCERTAIN:') ? 'CLAIM_UNCERTAIN' : 'FAILED' :
        worker ? alive(worker.pid) ? 'RUNNING' : 'LOST' : 'STARTING';
      const tone = status === 'READY' ? 'available' : result ? 'red' : 'yellow';
      output.push(`${paint(status === 'LOST' ? 'red' : tone, status.padEnd(15))}  ${clip(run.ticket, ticketWidth).padEnd(ticketWidth)}  ${duration(worker?.startedAt || run.createdAt, result?.finishedAt || Date.now())}`);
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
