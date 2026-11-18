import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createScreen, renderRunTable} from '../lane-launcher/dashboard.mjs';
import {lock as dispatcherLock} from './run-files.mjs';
import {plannerRows, titleCell} from './run-rows.mjs';
import {readyRequirements, nextConfiguredItem} from './queue.mjs';
import {HANDOFF_CHANGED, plannerConfig, plannerIdentity} from './planner-config.mjs';
import {configReloader} from '../lane-launcher/config-reload.mjs';
import {PlannerRuns} from './planner-runs.mjs';
export {plannerRows, titleCell} from './run-rows.mjs';
export {readyCriteria, groupRequirements, readyRequirements, nextConfiguredItem} from './queue.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const tones = {blue: '1;34', yellow: '1;33', orange: '38;5;208', gray: '90', red: '1;31', ready: '1;38;2;70;230;90', finished: '37'};
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
  const item = option('--item-id');
  const fixed = ac || requirement || item;
  const once = argv.includes('--once');
  const monitor = argv.includes('--monitor');
  const dryRun = argv.includes('--dry-run');
  if (!file || argv.some(value => !['--once', '--dry-run', '--monitor'].includes(value)) ||
      Number(Boolean(ac)) + Number(Boolean(requirement)) + Number(Boolean(item)) + Number(monitor) > 1) {
    throw new Error('Usage: sh lane-launcher/planner-joppa.sh CONFIG [--req-id REQ | --ac-id AC | --item-id ITEM | --monitor] [--once] [--dry-run]');
  }
  if (dryRun && !fixed) throw new Error('--dry-run needs --req-id, --ac-id or --item-id');
  const configFile = path.resolve(file);
  const automatic = !fixed && !monitor;
  const bytes = fs.readFileSync(configFile);
  let {config, root, interval, concurrency, tokenFile, digest} = plannerConfig(configFile, {ac, automatic}, bytes);
  // launch.py compares the bytes it parses with this digest before it claims or starts Medulla.
  const handoff = () => ({...process.env, PLANNING_JOPPA_HANDOFF_DIGEST: digest});
  const args = [path.join(here, 'run.sh'), '--config', configFile, ...(ac ? ['--ac-id', ac] : []),
    ...(requirement ? ['--req-id', requirement] : []), ...(item ? ['--item-id', item] : []), ...(dryRun ? ['--dry-run'] : [])];
  if (dryRun) {
    const child = spawn('sh', args, {stdio: 'inherit', env: handoff()});
    process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    return;
  }
  const state = {message: fixed ? `Planning ${fixed}` :
    monitor ? 'Monitoring existing runs' : config.workflow ? 'Checking configured items' : 'Checking ready Requirements', error: null};
  let screen, stopped = false, changed = false, wake, termination, selection, nextCheck;
  const attempted = new Set(), cooldowns = new Map();
  const pool = new PlannerRuns(root, run => {
    // A refused handoff started nothing. Only this unstarted selection may be tried again.
    if (run.code === HANDOFF_CHANGED && run.attemptKey && !run.current) attempted.delete(run.attemptKey);
    if (run.code !== 0) state.error = run.error || `Planning exited ${run.code}`;
    cooldowns.set(run.address, Date.now() + interval * 1000);
    changed = true;
    draw();
    wake?.();
  });
  const render = (_left, closed = false) => {
    const width = Math.max(30, process.stdout.columns || 80);
    const rows = plannerRows(root, pool.current);
    const table = renderRunTable(rows.map(row => ({...row, title: titleCell(row, 60), ticket: row.ac})),
      paint, 6, {identityLabel: config.workflow ? 'ITEM' : 'REQ / AC', titleLabel: 'TEXT'});
    const left = nextCheck == null ? null : Math.max(0, Math.ceil((nextCheck - performance.now()) / 1000));
    const footer = left == null ? 'Ctrl+C to stop' :
      `Next check in ${paint('blue', `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`)} · Ctrl+C to stop`;
    return [config.workflow ? path.basename(path.dirname(config.workflow)).toUpperCase() : 'PLANNING JOPPA',
      `workspace: ${config.workspace} · ${Math.max(pool.size, rows.filter(row => row.active).length)} running · concurrency ${concurrency} · last 30 runs`,
      '─'.repeat(width), ...table,
      String(state.error || state.message).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, width),
      closed ? (stopped ? 'Stopped' : 'Completed') : footer].join('\n');
  };
  const draw = () => {
    try { if (screen) screen.draw(); else process.stdout.write(render() + '\n'); }
    catch (error) { state.error = `Display error: ${error.message}`; }
  };
  const stop = signal => {
    stopped = true;
    selection?.abort();
    process.exitCode = signal === 'SIGTERM' ? 143 : 130;
    termination ??= pool.stop(signal);
    wake?.();
  };
  const interrupt = () => stop('SIGINT');
  const terminate = () => stop('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  let ticker, lock, reload;
  const pause = () => new Promise(resolve => {
    if (changed) { changed = false; resolve(); return; }
    nextCheck = performance.now() + interval * 1000;
    draw();
    const finish = () => { nextCheck = null; wake = null; changed = false; resolve(); };
    const timer = setTimeout(finish, interval * 1000);
    wake = () => { clearTimeout(timer); finish(); };
    if (stopped) wake();
  });
  try {
    if (automatic) {
      lock = dispatcherLock(root);
      const parse = raw => plannerConfig(configFile, {automatic}, raw);
      reload = configReloader(configFile, parse, plannerIdentity, {config, root, interval, concurrency, tokenFile, digest}, bytes);
    }
    if (process.stdout.isTTY) screen = createScreen(state, paint, render);
    draw();
    ticker = setInterval(() => { if (screen) draw(); }, 5000);
    do {
      let selected = requirement, attemptKey = null, scope = '--req-id';
      if (automatic && pool.size >= concurrency) { await pause(); continue; }
      if (automatic) {
        if (pool.size) {
          try {
            if (createHash('sha256').update(fs.readFileSync(configFile)).digest('hex') !== digest) {
              state.error = 'Config changed; waiting for active passes to end';
              await pause(); continue;
            }
          } catch (error) { state.error = `Config read failed: ${error.message}`; await pause(); continue; }
        }
        state.error = null;
        // Active passes keep their handoff. Accept new config only when the pool is empty.
        const loaded = pool.size ? {config: {config, interval, concurrency, tokenFile, digest}} : reload();
        ({config, interval, concurrency, tokenFile, digest} = loaded.config);
        const notice = loaded.reloaded ? 'config reloaded · ' : '';
        try {
          const rows = plannerRows(root, pool.current, Infinity, config);
          const busy = address => pool.owns(address) || rows.some(row => row.active && row.ac === address);
          if (loaded.error) state.error = loaded.error;
          else if (rows.some(row => row.status === 'HELD')) {
            state.error = 'RECOVERY_REQUIRED: resolve the held planning run before another claim';
          } else if (config.workflow) {
            // The configured flow selects one item. A run folder of the same item revision is not repeated.
            selection = new AbortController();
            const started = new Set(rows
              .flatMap(row => row.attemptKeys || [row.attemptKey]).filter(Boolean));
            const {count, next} = await nextConfiguredItem(config, tokenFile, selection.signal,
              row => busy(row.address) || (config.repeat ? (cooldowns.get(row.address) || 0) > Date.now() :
                attempted.has(row.attemptKey) || started.has(row.attemptKey)));
            selection = null;
            if (next) {
              ({address: selected, attemptKey} = next);
              scope = '--item-id';
              attempted.add(attemptKey);
              state.message = `${notice}Planning ITEM ${next.address} · ${next.title}`;
            } else state.message = `${notice}Items: ${count} selected · no unattempted items · next check in ${interval}s`;
          } else {
            selection = new AbortController();
            const candidates = await readyRequirements(config, tokenFile, selection.signal);
            selection = null;
            const next = candidates.find(row => !busy(row.address) && !attempted.has(row.attemptKey));
            if (next) {
              selected = next.address;
              attemptKey = next.attemptKey;
              attempted.add(attemptKey);
              state.message = `${notice}Planning ${next.address} · ${next.title}`;
            } else state.message = `${notice}Requirements: ${candidates.length} ready · no unattempted Requirements · next check in ${interval}s`;
          }
        } catch (error) { state.error = `Selection failed: ${error.message}`; }
        if (state.error && once && !stopped) process.exitCode = 2;
        draw();
      }
      if (stopped) break;
      if (ac || item || selected) {
        const runArgs = fixed ? args : [...args, scope, selected];
        const run = pool.start(ac || item || selected, runArgs, handoff(), attemptKey);
        if (once || fixed) {
          const code = await run.completion;
          await termination;
          if (!stopped) process.exitCode = code;
        }
        draw();
        if (automatic && !once && !stopped) continue;
      }
      if (once || stopped || fixed || monitor) break;
      await pause();
    } while (!stopped);
    if (!once && !stopped && (fixed || monitor)) await new Promise(resolve => { wake = resolve; });
  } finally {
    if (pool.size && !termination) termination = pool.stop('SIGTERM');
    await termination;
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
