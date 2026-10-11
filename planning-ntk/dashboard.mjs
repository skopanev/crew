import fs from 'node:fs';
import path from 'node:path';
import {createScreen, renderRunTable} from '../lane-launcher/dashboard.mjs';

// Read only the end of an existing log. Do not create a history store.
export function tail(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, 65536));
    const length = fs.readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    return buffer.subarray(0, length).toString('utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

const json = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
};

export function plannerRows(config, current = null) {
  const logs = path.join(config.stateDir, 'dispatch-logs');
  let files;
  try { files = fs.readdirSync(logs); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const recent = files.filter(file => /^dispatch-.+-\d+\.log$/.test(file))
    .sort((a, b) => Number(/-(\d+)\.log$/.exec(b)[1]) - Number(/-(\d+)\.log$/.exec(a)[1])).slice(0, 30);
  return recent.flatMap(file => {
    const match = /^dispatch-(.+)-(\d+)\.log$/.exec(file);
    if (!match) return [];
    const runId = file.slice(0, -4);
    const folder = path.join(config.stateDir, 'runs', runId);
    const log = path.join(logs, file);
    const text = tail(log);
    const finish = text.split('\n').reverse().find(line => line.startsWith('[planner] FINISH '));
    let ended;
    if (finish) { try { ended = JSON.parse(finish.slice('[planner] FINISH '.length)); } catch {} }
    const result = json(path.join(folder, 'artifacts/result.json'));
    const active = current?.runId === runId;
    const exits = [...text.matchAll(/-> (__exit_ok__|__exit_fail__)\b/g)];
    const confirmed = result?.verdict && result.ticket_unchanged !== true && result.publication_uncertain !== true;
    const status = active ? 'RUNNING' : ended?.status || (confirmed ? result.verdict :
      result?.source_drift || result?.code_drift ? 'DEFERRED' : exits.length ? 'FAILED' : 'UNKNOWN');
    const journal = tail(path.join(folder, 'journal.jsonl')).split('\n').slice(0, -1).reverse();
    let stage = active ? current.stage : '';
    if (active) {
      for (const line of journal) {
        try {
          const row = JSON.parse(line);
          if (row.node) { stage = row.next && !row.next.startsWith('__') ? row.next : row.node; break; }
        } catch {}
      }
      const steps = [...text.matchAll(/step \d+ \| (\w+)(?: -> (\S+) -> (\w+))?/g)];
      if (!journal.some(line => line.trim()) && steps.length) {
        const step = steps.at(-1);
        stage = step[3] && !step[3].startsWith('__') ? step[3] : step[1];
      }
    } else if (!['READY', 'DECOMPOSED'].includes(status)) {
      stage = ended?.reasonCode || result?.failure_class ||
        (status === 'NEEDS_HUMAN' ? 'HUMAN' : status === 'DEFERRED' ? 'INPUT_CHANGED' : status === 'NOT_READY' ? 'NOT_READY' : status);
    }
    return [{ticket: match[1], runId, status, stage, active,
      start: active ? current.start : new Date(Number(match[2])).toISOString(),
      end: active ? undefined : ended?.finishedAt || fs.statSync(log).mtime.toISOString()}];
  });
}

export function createPlannerDashboard(config, paint) {
  const state = {counts: null, current: null, message: 'Checking tickets', error: null};
  function render(left, stopped = false) {
    const width = Math.max(30, process.stdout.columns || 80);
    const output = ['PLANNER',
      `workspace: ${config.workspace} · tags: ${config.filterTags.join(config.tagMatch === 'any' ? ' OR ' : ' AND ')} · strict: ${config.strict}`.slice(0, width),
      state.counts ? `Tickets: ${paint('green', `${state.counts.ready} ready to plan`)} · ${paint('yellow', `${state.counts.held} held`)}` : 'Tickets: —',
      '─'.repeat(width),
      ...renderRunTable(plannerRows(config, state.current), paint, 7)];
    const message = String(state.message || '').replace(/\x1b\[[0-9;]*m/g, '').replace(/[\x00-\x1f\x7f]/g, ' ');
    output.push(state.error ? paint('red', String(state.error).slice(0, width)) : message.slice(0, width));
    output.push(stopped ? 'Stopped' : left == null ? 'Planning · Ctrl+C to stop' :
      `Next check in ${paint('accent', `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`)} · Ctrl+C to stop`);
    return output.join('\n');
  }
  return {state, ...createScreen(state, paint, render)};
}
