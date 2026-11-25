#!/usr/bin/env node
// Read existing Lander evidence. This monitor never claims work or writes run state.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {createScreen, renderRunTable} from '../lane-launcher/dashboard.mjs';
import {alive} from '../lane-launcher/runtime.mjs';
import {tail} from '../planning-joppa/run-files.mjs';

const json = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
};
const entries = root => {
  try { return fs.readdirSync(root, {withFileTypes: true}).filter(item => item.isDirectory()).map(item => path.join(root, item.name)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};
const modified = file => {
  try { return fs.statSync(file).mtime.toISOString(); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const records = text => text.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
const unique = values => [...new Set(values.filter(Boolean))];
function stage(folder, journal) {
  const last = journal.at(-1);
  let node = last?.next && !last.next.startsWith('__') ? last.next : last?.node || 'prepare';
  const latest = entries(path.join(folder, 'steps')).sort().at(-1);
  if (latest) node = path.basename(latest).replace(/^\d+-/, '');
  if (['clean_success', 'clean_failure'].includes(node)) return 'cleanup';
  if (node === 'build') {
    const attempt = entries(path.join(folder, 'artifacts/checks'))
      .sort((a, b) => Number(path.basename(a)) - Number(path.basename(b))).at(-1);
    if (attempt && entries(path.join(attempt, 'artifacts/gates')).length) return 'full check';
  }
  return node;
}

export function landerRows(root, statsFile = null) {
  const cached = new Map();
  if (statsFile && fs.existsSync(statsFile)) {
    for (const row of records(fs.readFileSync(statsFile, 'utf8'))) if (row.source === 'lander') cached.set(row.run_id, row);
  }
  const folders = entries(root).filter(folder => /^\d{4}-\d{2}-\d{2}_/.test(path.basename(folder)));
  const names = unique([...folders.map(folder => path.basename(folder)), ...cached.keys()]);
  return names.map(name => {
    const folder = path.join(root, name), art = path.join(folder, 'artifacts'), old = cached.get(name);
    const input = json(path.join(art, 'input.json')), state = json(path.join(art, 'lander.json'));
    const result = json(path.join(art, 'result.json')), outcome = json(path.join(folder, 'outcome.json'));
    const journal = records(tail(path.join(folder, 'journal.jsonl')));
    let pid;
    try { pid = Number(fs.readFileSync(path.join(folder, '.lock'), 'utf8').trim()); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const active = !outcome && !old && alive(pid);
    const items = input?.items || (input?.selected ? [input.selected] : []);
    const tasks = unique(items.map(item => item.address).concat(old?.tasks || []));
    const branches = unique(items.map(item => item.document?.data?.delivery?.branch));
    const published = result?.claim_released === true && !result?.needs_recovery || old?.publication_confirmed === true;
    const pushed = state?.landed || old?.delivery?.head;
    const code = outcome?.error?.code === 'E_DEADLINE' ? 'TIMEOUT' : result?.reason_code || state?.pending ||
      old?.reason_code || (/^Owner stopped/.test(result?.reason || '') ? 'OWNER_STOPPED' : outcome?.error?.code);
    const status = active ? 'RUNNING' : code === 'LANDED' && published && pushed ? 'LANDED' :
      pushed && published ? 'PARTIAL' : result?.needs_recovery ? 'HELD' : pushed ? 'PUSHED' :
      code === 'LANDED' ? 'UNCONFIRMED' : code || (outcome ? 'FAILED' : 'STOPPED');
    const claimTime = modified(path.join(art, 'claim.json'));
    const end = active ? undefined : old?.ended_at || modified(path.join(folder, 'outcome.json')) ||
      modified(path.join(art, 'result.json')) || modified(path.join(folder, 'journal.jsonl'));
    const start = claimTime || old?.started_at || (outcome && Number.isFinite(outcome.duration_s) && end
      ? new Date(Date.parse(end) - outcome.duration_s * 1000).toISOString() : modified(folder));
    return {ticket: tasks.length ? `${tasks.length} Tasks: ${tasks.map(address => address.split(':').slice(1).join(':') || address).join(', ')}` : '—',
      branches: branches.length || old?.batch_size || 0,
      runId: outcome?.run_id || name.replace(/^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-/, ''),
      start, end, active, status, stage: active ? stage(folder, journal) : code || stage(folder, journal)};
  }).sort((a, b) => Number(b.active) - Number(a.active) || Date.parse(b.start) - Date.parse(a.start)).slice(0, 30);
}

export async function main(argv) {
  const once = argv.includes('--once'), args = argv.filter(arg => arg !== '--once');
  if (!args.length || args.length > 2 || args.some(arg => arg.startsWith('--'))) {
    throw new Error('Usage: sh lane-launcher/lander-status.sh LANDER.json [RUN_STATS.jsonl] [--once]');
  }
  const config = json(path.resolve(args[0]));
  if (!config || !path.isAbsolute(config.runs_folder || '')) throw new Error('Config needs an absolute runs_folder');
  const stats = args[1] && path.resolve(args[1]);
  const tones = {blue: '1;34', yellow: '1;33', orange: '38;5;208', gray: 90, red: '1;31', ready: '1;38;2;70;230;90', finished: 37};
  const color = !process.env.NO_COLOR && (process.stdout.isTTY || process.env.FORCE_COLOR === '1');
  const paint = (tone, value) => color ? `\x1b[${tones[tone]}m${value}\x1b[0m` : String(value);
  const render = (_left, closed = false) => {
    const rows = landerRows(config.runs_folder, stats), width = Math.max(1, process.stdout.columns || 120);
    return ['LANDER', `${rows.filter(row => row.active).length} running · last 30 runs`, '─'.repeat(width),
      ...renderRunTable(rows, paint, 5, {identityLabel: 'TASKS', statusWidth: 14}),
      closed ? 'Stopped' : 'Next refresh in 00:05 · Ctrl+C to close'].join('\n');
  };
  if (once || !process.stdout.isTTY) { console.log(render()); return; }
  const state = {}, screen = createScreen(state, paint, render);
  let timer, stop;
  try {
    const draw = () => { try { screen.draw(); } catch (error) { state.fail(error.message); } };
    draw(); timer = setInterval(draw, 5000);
    await new Promise(resolve => { stop = resolve; process.once('SIGINT', stop); process.once('SIGTERM', stop); });
  } finally {
    clearInterval(timer); process.off('SIGINT', stop); process.off('SIGTERM', stop); screen.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error('lander-status: ' + error.message); process.exitCode = 2; });
}
