import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createScreen, renderRunTable} from '../lane-launcher/dashboard.mjs';
import {lock as dispatcherLock} from './run-files.mjs';
import {plannerRows, titleCell} from './run-rows.mjs';
import {criterionIds, readyRequirements} from './queue.mjs';
export {plannerRows, titleCell} from './run-rows.mjs';
export {readyCriteria, groupRequirements, readyRequirements} from './queue.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tones = {blue: '1;34', yellow: '1;33', red: '1;31', ready: '1;38;2;70;230;90', finished: '37'};
const paint = (tone, value) => process.stdout.isTTY && !process.env.NO_COLOR ?
  `\x1b[${tones[tone]}m${value}\x1b[0m` : String(value);

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
  const requirement = option('--req-id');
  const once = argv.includes('--once');
  const monitor = argv.includes('--monitor');
  const dryRun = argv.includes('--dry-run');
  if (!file || argv.some(value => !['--once', '--dry-run', '--monitor'].includes(value)) ||
      Number(Boolean(ac)) + Number(Boolean(requirement)) + Number(monitor) > 1) {
    throw new Error('Usage: sh lane-launcher/planner-joppa.sh CONFIG [--req-id REQ | --ac-id AC | --monitor] [--once] [--dry-run]');
  }
  if (dryRun && !ac && !requirement) throw new Error('--dry-run needs --req-id or --ac-id');
  const configFile = path.resolve(file);
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const ids = criterionIds(config);
  if (ac && ids && !ids.includes(ac)) throw new Error('Selected AC is outside config.ac_ids');
  if (typeof config.workspace !== 'string' || typeof config.runs_folder !== 'string') throw new Error('Config needs workspace and runs_folder');
  const expand = value => value.startsWith('~/') ? path.join(process.env.HOME, value.slice(2)) : value;
  const configuredRoot = path.resolve(path.dirname(configFile), expand(config.runs_folder));
  const root = fs.existsSync(configuredRoot) ? fs.realpathSync(configuredRoot) : configuredRoot;
  const interval = config.interval_seconds ?? 60;
  if (!Number.isInteger(interval) || interval < 1 || interval > 3600) throw new Error('interval_seconds must be 1 to 3600');
  const tokenFile = config.token_file ? path.resolve(path.dirname(configFile), expand(config.token_file)) : null;
  if (!ac && !requirement && !monitor && !tokenFile && !config.mcp_command) {
    throw new Error('Config needs mcp_command or token_file for automatic selection');
  }
  const args = [path.join(here, 'run.sh'), '--config', configFile, ...(ac ? ['--ac-id', ac] : []),
    ...(requirement ? ['--req-id', requirement] : []), ...(dryRun ? ['--dry-run'] : [])];
  if (dryRun) {
    const child = spawn('sh', args, {stdio: 'inherit'});
    process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    return;
  }
  const state = {message: ac || requirement ? `Planning ${ac || requirement}` :
    monitor ? 'Monitoring existing runs' : 'Checking ready Requirements', error: null};
  let current = null, screen, child, stopped = false, wake, termination, selection, nextCheck;
  const render = (_left, closed = false) => {
    const width = Math.max(30, process.stdout.columns || 80);
    const rows = plannerRows(root, current);
    const table = renderRunTable(rows.map(row => ({...row, title: titleCell(row, 60), ticket: row.ac})),
      paint, 6, {identityLabel: 'REQ / AC', titleLabel: 'TEXT'});
    const left = nextCheck == null ? null : Math.max(0, Math.ceil((nextCheck - performance.now()) / 1000));
    const footer = left == null ? 'Ctrl+C to stop' :
      `Next check in ${paint('blue', `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`)} · Ctrl+C to stop`;
    return ['PLANNING JOPPA', `workspace: ${config.workspace} · ${rows.filter(row => row.active).length} running · last 30 runs`,
      '─'.repeat(width), ...table,
      String(state.error || state.message).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, width),
      closed ? (stopped ? 'Stopped' : 'Completed') : footer].join('\n');
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
    selection?.abort();
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
  let ticker, lock;
  const attempted = new Set();
  const pause = () => new Promise(resolve => {
    nextCheck = performance.now() + interval * 1000;
    draw();
    const finish = () => { nextCheck = null; wake = null; resolve(); };
    const timer = setTimeout(finish, interval * 1000);
    wake = () => { clearTimeout(timer); finish(); };
    if (stopped) wake();
  });
  try {
    if (!ac && !requirement && !monitor) {
      lock = dispatcherLock(root);
    }
    if (process.stdout.isTTY) screen = createScreen(state, paint, render);
    draw();
    ticker = setInterval(() => { if (screen) draw(); }, 5000);
    do {
      let selected = requirement;
      if (!ac && !requirement && !monitor) {
        current = null;
        state.error = null;
        try {
          if (plannerRows(root, null, Infinity, config).some(row => row.status === 'HELD')) {
            state.error = 'RECOVERY_REQUIRED: resolve the held planning run before another claim';
          } else {
            selection = new AbortController();
            const candidates = await readyRequirements(config, tokenFile, selection.signal);
            selection = null;
            const next = candidates.find(row => !attempted.has(row.attemptKey));
            if (next) {
              selected = next.address;
              attempted.add(next.attemptKey);
              state.message = `Planning ${next.address} · ${next.title}`;
            } else state.message = `Requirements: ${candidates.length} ready · no unattempted Requirements · next check in ${interval}s`;
          }
        } catch (error) { state.error = `Selection failed: ${error.message}`; }
        if (state.error && once && !stopped) process.exitCode = 2;
        draw();
      }
      if (stopped) break;
      if (ac || selected) {
        const runArgs = ac || requirement ? args : [...args, '--req-id', selected];
        child = spawn('sh', runArgs, {stdio: ['ignore', 'pipe', 'pipe'], detached: true});
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
              const canonicalRoot = fs.existsSync(root) ? fs.realpathSync(root) : root;
              if ((folder.startsWith(root + path.sep) || folder.startsWith(canonicalRoot + path.sep)) && fs.existsSync(folder)) {
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
        if (!stopped && (once || ac || requirement)) process.exitCode = code ?? 2;
        draw();
      }
      if (once || stopped || ac || requirement || monitor) break;
      await pause();
    } while (!stopped);
    if (!once && !stopped && (ac || requirement || monitor)) await new Promise(resolve => { wake = resolve; });
  } finally {
    clearInterval(ticker);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    if (lock && fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock);
    screen?.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(`planning-joppa: ${error.message}`); process.exitCode = 2; });
}
