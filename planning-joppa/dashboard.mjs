import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createScreen, renderRunTable} from '../lane-launcher/dashboard.mjs';
import {tail} from '../planning-ntk/dashboard.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tones = {blue: '1;34', yellow: '1;33', red: '1;31', ready: '1;38;2;70;230;90', finished: '37'};
const paint = (tone, value) => process.stdout.isTTY && !process.env.NO_COLOR ?
  `\x1b[${tones[tone]}m${value}\x1b[0m` : String(value);
const json = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
};
const alive = pid => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
};
const modified = file => {
  try { return fs.statSync(file).mtime.toISOString(); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
};

export function plannerRows(root, current = null) {
  let folders;
  try { folders = fs.readdirSync(root, {withFileTypes: true}); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return folders.filter(entry => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}_/.test(entry.name))
    .sort((a, b) => b.name.localeCompare(a.name)).flatMap(entry => {
      const folder = path.join(root, entry.name);
      const artifacts = path.join(folder, 'artifacts');
      const input = json(path.join(artifacts, 'input.json'));
      const result = json(path.join(artifacts, 'result.json'));
      let vars = '', pid;
      try { vars = fs.readFileSync(path.join(folder, 'vars.yaml'), 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const ac = input?.ac?.id || /^PLANNING_JOPPA_AC:\s*["']?([^\n"']+)/m.exec(vars)?.[1]?.trim();
      if (!ac) return [];
      const title = item => {
        if (!item) return '';
        const data = input?.joppa?.objects?.[item.id]?.document?.data;
        if (data?.title) return data.title;
        try { return JSON.parse(item.text).data?.title || item.id; } catch { return item.id; }
      };
      const label = input ? `${title(input.requirement)} : ${title(input.ac)}` : ac;
      try { pid = Number(fs.readFileSync(path.join(folder, '.lock'), 'utf8').trim()); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const journal = tail(path.join(folder, 'journal.jsonl')).split('\n').flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
      const last = journal.at(-1);
      const active = !result && (current?.folder === folder ? !current.ended : alive(pid));
      const released = json(path.join(artifacts, 'release.json'));
      const claim = json(path.join(artifacts, 'claim.json'));
      const publication = json(path.join(artifacts, 'publication.json'));
      const recovery = result?.needs_recovery || !result && (
        [claim, publication, released].some(receipt => ['pending', 'uncertain'].includes(receipt?.status)) ||
        claim?.status === 'confirmed' && released?.status !== 'confirmed');
      const status = active ? 'RUNNING' : ['published', 'unchanged'].includes(result?.status) ? 'READY' :
        recovery ? 'HELD' : result?.reason?.startsWith('Required owner decision:') ? 'HUMAN' :
        result?.status === 'blocked' ? 'BLOCKED' : last?.next === '__exit_fail__' ? 'FAILED' : 'STOPPED';
      let stage = '';
      if (active) {
        stage = last?.next && !last.next.startsWith('__') ? last.next : last?.node || 'prepare';
        try {
          const step = fs.readdirSync(path.join(folder, 'steps')).sort().at(-1);
          if (step) stage = step.replace(/^\d+-/, '');
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
      } else if (status !== 'READY') {
        const failure = [...journal].reverse().find(row => ['failed', 'needs_human', '__exit_fail__'].includes(row.next)
          && !['failed', 'needs_human'].includes(row.node));
        stage = recovery ? 'RECOVERY_REQUIRED' : status === 'HUMAN' ? 'HUMAN' :
          failure?.signal || (released?.status === 'confirmed' && !result ? 'INTERRUPTED' : status);
      }
      const match = /^(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})-(.+)$/.exec(entry.name);
      const start = match ? new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}`).toISOString() : modified(folder);
      const end = active ? undefined : current?.folder === folder && current.finishedAt ||
        modified(path.join(artifacts, 'result.json')) || modified(path.join(artifacts, 'release.json')) ||
        modified(path.join(folder, 'journal.jsonl')) || start;
      return [{ticket: label, requirementTitle: input ? title(input.requirement) : '',
        acTitle: input ? title(input.ac) : '', ac,
        runId: match?.[5] || entry.name, start, end, active, status, stage}];
    }).sort((a, b) => Number(b.active) - Number(a.active) || Date.parse(b.start) - Date.parse(a.start)).slice(0, 30);
}

export function titleCell(row, width) {
  if (!row.requirementTitle || !row.acTitle) return row.ticket;
  const clip = (text, size) => {
    const chars = Array.from(text.replace(/[\x00-\x1f\x7f]/g, ' '));
    return chars.length > size ? chars.slice(0, size - 1).join('') + '…' : chars.join('');
  };
  const budget = width - 3;
  const requirementWidth = Math.min(Array.from(row.requirementTitle).length,
    Math.max(Math.floor(budget / 2), budget - Array.from(row.acTitle).length));
  return `${clip(row.requirementTitle, requirementWidth)} : ${clip(row.acTitle, budget - requirementWidth)}`;
}

export async function main(argv) {
  const positional = argv[0] && !argv[0].startsWith('--') ? argv.shift() : null;
  const option = name => {
    const index = argv.indexOf(name);
    if (index < 0) return null;
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
    argv.splice(index, 2);
    return value;
  };
  const file = option('--config') || positional;
  const ac = option('--ac-id');
  const once = argv.includes('--once');
  const dryRun = argv.includes('--dry-run');
  if (!file || argv.some(value => !['--once', '--dry-run'].includes(value))) {
    throw new Error('Usage: sh lane-launcher/planner-joppa.sh CONFIG [--ac-id AC] [--once] [--dry-run]');
  }
  if (dryRun && !ac) throw new Error('--dry-run needs --ac-id');
  const configFile = path.resolve(file);
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  if (typeof config.workspace !== 'string' || typeof config.runs_folder !== 'string') throw new Error('Config needs workspace and runs_folder');
  const expand = value => value.startsWith('~/') ? path.join(process.env.HOME, value.slice(2)) : value;
  const root = path.resolve(path.dirname(configFile), expand(config.runs_folder));
  const args = [path.join(here, 'run.sh'), '--config', configFile, ...(ac ? ['--ac-id', ac] : []), ...(dryRun ? ['--dry-run'] : [])];
  if (dryRun) {
    const child = spawn('sh', args, {stdio: 'inherit'});
    process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    return;
  }
  const state = {message: ac ? `Planning ${ac}` : 'Monitoring existing runs', error: null};
  let current = null, screen, child, stopped = false, wake, termination;
  const render = (_left, closed = false) => {
    const width = Math.max(30, process.stdout.columns || 80);
    const rows = plannerRows(root, current);
    const identityWidth = Math.max(20, Math.min(Math.floor(width * 0.55), width - 106));
    const table = renderRunTable(rows.map(row => ({...row, ticket: titleCell(row, identityWidth)})),
      paint, 6, {identityLabel: 'REQ : AC', identityWidth});
    return ['PLANNING JOPPA', `workspace: ${config.workspace} · ${rows.filter(row => row.active).length} running · last 30 runs`,
      '─'.repeat(width), ...table,
      String(state.error || state.message).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, width),
      closed ? (stopped ? 'Stopped' : 'Completed') : 'Refresh 5s · Ctrl+C to stop'].join('\n');
  };
  const draw = () => {
    try { if (screen) screen.draw(); else process.stdout.write(render() + '\n'); }
    catch (error) { state.error = `Display error: ${error.message}`; }
  };
  const groupSignal = signal => {
    if (!child?.pid) return false;
    try { process.kill(-child.pid, signal); return true; }
    catch (error) { if (error.code !== 'ESRCH') throw error; return false; }
  };
  const stop = signal => {
    stopped = true;
    process.exitCode = signal === 'SIGTERM' ? 143 : 130;
    termination ??= (async () => {
      if (!groupSignal(signal)) return;
      const deadline = Date.now() + 5000;
      while (groupSignal(0) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
      groupSignal('SIGKILL');
    })();
    wake?.();
  };
  const interrupt = () => stop('SIGINT');
  const terminate = () => stop('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  let ticker;
  try {
    if (process.stdout.isTTY) screen = createScreen(state, paint, render);
    draw();
    ticker = setInterval(() => { if (screen) draw(); }, 5000);
    if (ac) {
      child = spawn('sh', args, {stdio: ['ignore', 'pipe', 'pipe'], detached: true});
      let pending = '', buffered = '';
      const output = data => {
        const text = data.toString();
        if (current?.folder) fs.appendFileSync(path.join(current.folder, 'output.log'), text);
        else {
          buffered = (buffered + text).slice(-65536);
          pending += text;
          const lines = pending.split('\n');
          pending = lines.pop();
          for (const line of lines) {
            const folder = line.trim();
            if (folder.startsWith(root + path.sep) && fs.existsSync(folder)) {
              current = {folder, ended: false};
              fs.appendFileSync(path.join(folder, 'output.log'), buffered);
              buffered = '';
              state.message = '';
              break;
            }
            if (line.startsWith('planning-joppa:')) state.error = line.trim();
          }
        }
      };
      child.stdout.on('data', output);
      child.stderr.on('data', output);
      const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
      await termination;
      if (current) Object.assign(current, {ended: true, finishedAt: new Date().toISOString()});
      if (code !== 0 && !state.error) state.error = `Planning exited ${code ?? 'by signal'}`;
      if (!stopped) process.exitCode = code ?? 2;
      draw();
    }
    if (!once && !stopped) await new Promise(resolve => { wake = resolve; });
  } finally {
    clearInterval(ticker);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    screen?.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(`planning-joppa: ${error.message}`); process.exitCode = 2; });
}
