import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createScreen, renderRunTable} from '../lane-launcher/dashboard.mjs';
import {tail} from '../planning-ntk/dashboard.mjs';
import {api} from '../lane-launcher/joppa.mjs';
import {dependencyCheck} from '../lane-launcher/dependencies.mjs';
import {lock as dispatcherLock} from '../planning-ntk/dispatch.mjs';

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

export function plannerRows(root, current = null, limit = 30, scope = null) {
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
      const subject = input?.joppa?.scope === 'requirement' ? input.requirement : input?.ac;
      const ac = subject?.id || /^PLANNING_JOPPA_(?:REQ|AC):\s*["']?([^\n"']+)/m.exec(vars)?.[1]?.trim();
      if (!ac) return [];
      const title = item => {
        if (!item) return '';
        const data = input?.joppa?.objects?.[item.id]?.document?.data;
        if (data?.title) return data.title;
        try { return JSON.parse(item.text).data?.title || item.id; } catch { return item.id; }
      };
      const label = input ? title(subject) : ac;
      try { pid = Number(fs.readFileSync(path.join(folder, '.lock'), 'utf8').trim()); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const journal = tail(path.join(folder, 'journal.jsonl')).split('\n').flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
      });
      const last = journal.at(-1);
      const active = !result && (current?.folder === folder ? !current.ended : alive(pid));
      const released = json(path.join(artifacts, 'release.json'));
      const claim = json(path.join(artifacts, 'claim.json'));
      if (scope && (input?.workspace && input.workspace !== scope.workspace ||
          claim?.server && claim.server !== scope.url)) return [];
      const publication = json(path.join(artifacts, 'publication.json'));
      const recovery = result?.needs_recovery || !result && (
        [claim, publication, released].some(receipt => ['pending', 'uncertain'].includes(receipt?.status)) ||
        released?.skipped_claims?.some(item => item.unknown === true) ||
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
      return [{ticket: label, acTitle: input ? title(subject) : '', ac,
        runId: match?.[5] || entry.name, start, end, active, status, stage}];
    }).sort((a, b) => Number(b.active) - Number(a.active) || Date.parse(b.start) - Date.parse(a.start)).slice(0, limit);
}

export function titleCell(row, width) {
  const clip = (text, size) => {
    const chars = Array.from(text.replace(/[\x00-\x1f\x7f]/g, ' '));
    return chars.length > size ? chars.slice(0, size - 1).join('') + '…' : chars.join('');
  };
  return clip(row.acTitle || row.ticket, width);
}

function criterionIds(config) {
  const ids = config.ac_ids;
  if (ids === undefined) return null;
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id.includes(':')) ||
      new Set(ids).size !== ids.length) throw new Error('ac_ids must contain distinct full criterion addresses');
  return ids;
}

export async function readyCriteria(config, tokenFile, signal) {
  const ids = criterionIds(config);
  const rows = [];
  const blocked = new Map(), active = new Set(), pending = new Map();
  const service = {joppa: {url: config.url, mcpCommand: config.mcp_command}};
  const dependencies = dependencyCheck((tool, args) => api(service, {tokenFile}, tool,
    {workspace: config.workspace, ...args}, {signal}));
  let cursor;
  do {
    const page = await api(service, {tokenFile}, 'joppa_tasks', {
      workspace: config.workspace, view: 'all', limit: 100, ...(cursor ? {cursor} : {}),
    }, {signal});
    for (const task of page.tasks) {
      if (['done', 'retired'].includes(task.status) || ids && !ids.includes(task.ac)) continue;
      if (typeof task.ac !== 'string' || typeof task.address !== 'string' || !Number.isSafeInteger(task.revision)) {
        throw new Error('Unfinished Task is missing its criterion, address or revision');
      }
      if (task.assignee || task.claim || task.claimable === true) active.add(task.ac);
      if (task.waiting_reason !== 'Task is blocked for planning' || task.assignee || task.claim) continue;
      const tasks = blocked.get(task.ac) || [];
      tasks.push(`${task.address}:${task.revision}`);
      blocked.set(task.ac, tasks);
    }
    cursor = page.next_cursor;
  } while (cursor);
  do {
    const page = await api(service, {tokenFile}, 'joppa_objects', {
      workspace: config.workspace, parent: '*', work_filter: 'unstarted', limit: 25,
      fields: ['title', 'kind', 'revision', 'contract_revision', 'work_ready', 'review_required', 'process', 'work_summary'],
      ...(cursor ? {cursor} : {}),
    }, {signal});
    for (const row of page.items) {
      const work = row.work_summary;
      if ((!ids || ids.includes(row.address)) && row.work_ready === true && !row.review_required &&
          !row.process?.planning_claim && (work?.active === 0 || blocked.has(row.address)) && !active.has(row.address) &&
          (work?.done === 0 || blocked.has(row.address))) pending.set(row.address, row);
    }
    cursor = page.next_cursor;
  } while (cursor);
  for (const ac of blocked.keys()) {
    if (pending.has(ac) || active.has(ac)) continue;
    const object = await api(service, {tokenFile}, 'joppa_objects', {
      workspace: config.workspace, address: ac,
    }, {signal});
    if (object.document?.present === true && object.historical === false &&
        object.work_ready === true && !object.review_required && !object.process?.planning_claim &&
        object.process?.assessment?.state === 'ready' && !object.process?.readiness_blocker) {
      pending.set(ac, {...object, revision: object.current_revision, title: object.document.data.title});
    }
  }
  const candidates = [...pending.values()];
  for (let offset = 0; offset < candidates.length; offset += 100) {
    const batch = candidates.slice(offset, offset + 100);
    const checks = await api(service, {tokenFile}, 'joppa_tests', {
      workspace: config.workspace, ac: batch.map(row => row.address).join(','), summary: true,
    }, {signal});
    const statuses = new Map((checks.items || [checks]).map(row => [row.address, row.status]));
    for (const row of batch) {
      if (!statuses.has(row.address)) throw new Error(`Test status missing for ${row.address}`);
      const status = statuses.get(row.address);
      if (!['green', 'red', 'grey'].includes(status)) throw new Error(`Invalid test status for ${row.address}`);
      const failures = (blocked.get(row.address) || []).sort();
      if (status !== 'green' && (await dependencies(row.address)).ready) {
        rows.push({...row, testStatus: status, failedTaskCount: failures.length,
          attemptKey: JSON.stringify([row.address, row.contract_revision ?? row.revision, failures])});
      }
    }
  }
  return rows.sort((a, b) => Number(b.failedTaskCount > 0) - Number(a.failedTaskCount > 0) ||
    Number(b.testStatus === 'red') - Number(a.testStatus === 'red') ||
    (ids ? ids.indexOf(a.address) - ids.indexOf(b.address) : 0));
}

export async function groupRequirements(candidates, read) {
  const schema = (await read('joppa_tree', {})).schema.types;
  const objects = new Map(), groups = new Map();
  const object = async address => {
    if (!objects.has(address)) objects.set(address, read('joppa_objects', {address}));
    const result = await objects.get(address);
    if (result.address !== address || result.document?.present !== true || result.historical !== false ||
        !Number.isSafeInteger(result.current_revision)) throw new Error('Requirement selection needs current full object reads');
    return result;
  };
  for (const candidate of candidates) {
    let current = await object(candidate.address);
    const seen = new Set();
    while (schema[current.kind]?.role !== 'requirement') {
      if (seen.has(current.address)) throw new Error('Requirement parent chain contains a cycle');
      seen.add(current.address);
      if (!current.document.parent) throw new Error('Criterion has no schema Requirement ancestor');
      current = await object(current.document.parent);
    }
    const group = groups.get(current.address) || {address: current.address, revision: current.current_revision,
      title: current.document.data.title || current.address, members: []};
    group.members.push(candidate.attemptKey);
    groups.set(current.address, group);
  }
  return [...groups.values()].map(({members, ...item}) => ({...item,
    attemptKey: JSON.stringify([item.address, item.revision, members.sort()])}));
}

export async function readyRequirements(config, tokenFile, signal) {
  const candidates = await readyCriteria(config, tokenFile, signal);
  if (!candidates.length) return [];
  return groupRequirements(candidates, (tool, args) => api({joppa: {url: config.url, mcpCommand: config.mcp_command}}, {tokenFile}, tool,
    {workspace: config.workspace, ...args}, {signal}));
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
