import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createScreen, renderRunTable} from '../lane-launcher/dashboard.mjs';
import {lock as dispatcherLock} from './run-files.mjs';
import {plannerRows, titleCell} from './run-rows.mjs';
import {readyRequirements} from './queue.mjs';
import {HANDOFF_CHANGED, plannerConfig, plannerIdentity} from './planner-config.mjs';
import {configReloader} from '../lane-launcher/config-reload.mjs';
import {PlannerRuns} from './planner-runs.mjs';
import {DetachedPlannerRuns, dispatcherId, stopDetachedRun} from './detached-runs.mjs';
import {queueLabel} from './flow-batch.mjs';
import {hasSlots} from './slots.mjs';
import {admissionForItem} from './configured-admission.mjs';
import {landingQueue} from './queue-display.mjs';
import {availableCounts, availabilityLabel} from './availability.mjs';
import {pendingFlush, consumeFlush} from './flush.mjs';
import {configuredSelection} from './configured-selection.mjs';
import {avgPace} from '../lane-launcher/avg-pace.mjs';
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
  const stopRun = option('--stop-run');
  const fixed = ac || requirement || item;
  const once = argv.includes('--once');
  const monitor = argv.includes('--monitor');
  const dryRun = argv.includes('--dry-run');
  if (!file || argv.some(value => !['--once', '--dry-run', '--monitor'].includes(value)) ||
      Number(Boolean(ac)) + Number(Boolean(requirement)) + Number(Boolean(item)) + Number(monitor) > 1) {
    throw new Error('Usage: sh lane-launcher/planner-joppa.sh CONFIG [--req-id REQ | --ac-id AC | --item-id ITEM | --monitor | --stop-run RUN_ID] [--once] [--dry-run]');
  }
  if (dryRun && !fixed) throw new Error('--dry-run needs --req-id, --ac-id or --item-id');
  const configFile = path.resolve(file);
  const automatic = !fixed && !monitor;
  const bytes = fs.readFileSync(configFile);
  let {config, root, interval, concurrency, tokenFile, digest} = plannerConfig(configFile, {ac, automatic}, bytes);
  const detached = config.execution === 'detached';
  const owner = dispatcherId(plannerIdentity({config, root}));
  if (fixed && hasSlots(config) && !dryRun) throw new Error('Configured slots require automatic selection');
  if (stopRun) {
    if (!detached || fixed || monitor || dryRun) throw new Error('--stop-run requires a detached configured flow');
    console.log(`Stopping ${stopDetachedRun(root, owner, stopRun)}`);
    return;
  }
  // launch.py compares the bytes it parses with this digest before it claims or starts Medulla.
  const handoff = () => ({...process.env, PLANNING_JOPPA_HANDOFF_DIGEST: digest});
  const args = [path.join(here, 'run.sh'), '--config', configFile, ...(ac ? ['--ac-id', ac] : []),
    ...(requirement ? ['--req-id', requirement] : []), ...(item ? ['--item-id', item] : []), ...(dryRun ? ['--dry-run'] : [])];
  if (dryRun) {
    const child = spawn('sh', args, {stdio: 'inherit', env: handoff()});
    process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
    return;
  }
  if (fixed && config.workflow && !await admissionForItem(config, tokenFile, ac || item,
      Number(process.env.PLANNING_JOPPA_INPUT ?? 0))) {
    console.log('Skipped by configured admission: ' + (ac || item));
    return;
  }
  const state = {message: fixed ? `Planning ${fixed}` :
    monitor ? 'Monitoring existing runs' : config.workflow ? 'Checking configured items' : 'Checking ready Requirements', error: null};
  let screen, stopped = false, changed = false, wake, termination, selection, nextCheck;
  let resolveStop;
  const dashboardStopped = new Promise(resolve => { resolveStop = resolve; });
  const attempted = new Set(), cooldowns = new Map();
  const Runs = detached ? DetachedPlannerRuns : PlannerRuns;
  const finished = run => {
    // A refused handoff started nothing. Only this unstarted selection may be tried again.
    if (run.code === HANDOFF_CHANGED && run.attemptKey && !run.current) attempted.delete(run.attemptKey);
    if (run.code !== 0) state.error = run.error || `Planning exited ${run.code}`;
    cooldowns.set(run.address, Date.now() + interval * 1000);
    changed = true;
    draw();
    wake?.();
  };
  const pool = detached ? new Runs(root, owner, finished, config) : new Runs(root, finished);
  const render = (_left, closed = false) => {
    const width = Math.max(30, process.stdout.columns || 80);
    const rows = plannerRows(root, pool.current, Infinity, {...config, dispatcherId: owner});
    const active = detached ? pool.runs.filter(run => run.active) : [...pool.active.values()];
    const flushes = config.workflow ? pendingFlush(config, root) : [];
    const table = renderRunTable(rows.map(row => ({...row, status: row.displayStatus, title: titleCell(row, 60),
      ticket: row.batchLabel || (row.slot ? `[${row.slot}] ${row.ac}` : row.ac)})),
      paint, (state.queue === undefined ? 7 : 8) + Number(flushes.length > 0),
      {identityLabel: config.workflow ? 'ITEM' : 'REQ / AC', titleLabel: 'TEXT', statusWidth: Infinity});
    return [config.workflow ? path.basename(path.dirname(config.workflow)).toUpperCase() : 'PLANNING JOPPA',
      `workspace: ${config.workspace} · ${Math.max(pool.size, rows.filter(row => row.active).length)} running · concurrency ${concurrency}` +
        (config.workflow ? ` · ${availabilityLabel(state)}` : '') + ` · ${avgPace(rows)} · last 30 runs`,
      ...(state.queue === undefined ? [] : [queueLabel(state.queue, state.occupied, landingQueue(rows, config, active)).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, width)]),
      ...(flushes.length ? [('flush requested: ' + [...new Set(flushes.map(request => request.slot))].join(' · ')).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, width)] : []),
      '─'.repeat(width), ...table,
      ...(state.error ? [String(state.error).replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, width)] : []),
      '', closed ? (stopped ? 'Stopped' : 'Completed') : 'Ctrl+C to stop'].join('\n');
  };
  const draw = () => {
    try { if (screen) screen.draw(); else process.stdout.write(render() + '\n'); }
    catch (error) { state.error = `Display error: ${error.message}`; }
  };
  const stop = signal => {
    stopped = true;
    selection?.abort();
    process.exitCode = signal === 'SIGTERM' ? 143 : 130;
    resolveStop(process.exitCode);
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
      let selected = requirement, attemptKey = null, inputIndex, slot, flush = null, scope = '--req-id';
      if (automatic) {
        // A configured inline pass runs on its own config copy (planner-runs.mjs), so only the planner flow waits.
        const frozen = pool.size && !detached && !config.workflow;
        if (frozen) {
          try {
            if (createHash('sha256').update(fs.readFileSync(configFile)).digest('hex') !== digest) {
              state.error = 'Config changed; waiting for active passes to end';
              await pause(); continue;
            }
          } catch (error) { state.error = `Config read failed: ${error.message}`; await pause(); continue; }
        }
        state.error = null;
        // Detached and configured inline passes keep their snapshots. Planner passes finish before config reload.
        const loaded = frozen ? {config: {config, interval, concurrency, tokenFile, digest}} : reload();
        ({config, interval, concurrency, tokenFile, digest} = loaded.config);
        const notice = loaded.reloaded ? 'config reloaded · ' : '';
        if (config.workflow) state.available = undefined;
        try {
          const rows = plannerRows(root, pool.current, Infinity, {...config, dispatcherId: owner});
          if (config.workflow) {
            selection = new AbortController();
            const active = rows.filter(row => row.active);
            state.available = (await availableCounts(config, tokenFile, selection.signal,
              active.every(row => row.claimHeld) && active.length >= pool.size)).text;
            selection = null;
            if (loaded.reloaded) state.skipped = undefined;
          }
          if (pool.size >= concurrency && !(config.workflow && (config.batch?.by || hasSlots(config) || pendingFlush(config, root).length))) {
            state.error = loaded.error || null;
            if (once) { draw(); break; }
            await pause(); continue;
          }
          const busy = address => !detached && pool.owns(address) || rows.some(row => row.active && row.ac === address);
          if (loaded.error) state.error = loaded.error;
          else if (rows.some(row => row.status === 'HELD')) {
            state.error = 'RECOVERY_REQUIRED: resolve the held planning run before another claim';
          } else if (config.workflow) {
            // Retry policy affects selection only. Busy and held runs remain excluded.
            selection = new AbortController();
            const {count, next, filtered, queue, occupied, stats, flush: requested} = await configuredSelection({
              config, root, tokenFile, signal: selection.signal, rows, pool, detached, concurrency, attempted, cooldowns});
            state.occupied = occupied;
            if (stats.checked) state.skipped = stats.skipped || 0;
            state.queue = config.batch?.by || hasSlots(config) ? queue : undefined;
            selection = null;
            if (next) {
              ({address: selected, attemptKey} = next);
              inputIndex = next.input;
              slot = next.slot;
              flush = requested;
              scope = '--item-id';
              attempted.add(attemptKey);
              state.message = notice.trim();
            } else state.message = `${notice}Items: ${count} selected · ${filtered ? `${filtered} excluded by filters` : 'no unattempted items'} · next check in ${interval}s`;
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
        const env = {...handoff(), ...(inputIndex === undefined ? {} : {PLANNING_JOPPA_INPUT: String(inputIndex)})};
        const run = await pool.start(ac || item || selected, runArgs, env, attemptKey || JSON.stringify([ac || item || selected, 0]), Boolean(config.workflow), {slot, flush, owner, config});
        if (flush && run.code !== HANDOFF_CHANGED) consumeFlush(flush);
        if (once || fixed) {
          const code = await (detached ? Promise.race([run.completion, dashboardStopped]) : run.completion);
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
    let stoppedCleanly = false;
    try {
      if (pool.size && !termination) termination = pool.stop('SIGTERM');
      await termination;
      stoppedCleanly = detached || pool.size === 0;
    } finally {
      clearInterval(ticker);
      process.off('SIGINT', interrupt);
      process.off('SIGTERM', terminate);
      if (stoppedCleanly && lock && fs.readFileSync(lock, 'utf8') === String(process.pid)) fs.unlinkSync(lock);
      screen?.close();
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(`planning-joppa: ${error.message}`); process.exitCode = 2; });
}
