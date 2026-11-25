// Independent planner workers use the same process launcher as headless lanes.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {startDetached} from '../lane-launcher/detached-process.mjs';
import {save, read, alive} from '../lane-launcher/runtime.mjs';
import {plannerRows} from './run-rows.mjs';
import {freezeFlush} from './flush.mjs';

const worker = fileURLToPath(new URL('./detached-worker.mjs', import.meta.url));
export const dispatcherId = ({workspace, url, root}) =>
  createHash('sha256').update(JSON.stringify({workspace, url, root})).digest('hex');

export function detachedRuns(root, owner) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, {withFileTypes: true}).filter(entry => entry.isDirectory()).flatMap(entry => {
    const folder = path.join(root, entry.name), file = path.join(folder, 'launch.json');
    if (!fs.existsSync(file)) return [];
    const run = read(file);
    if (run.dispatcherId !== owner) return [];
    const pidFile = path.join(folder, '.worker.pid');
    const pid = fs.existsSync(pidFile) ? Number(fs.readFileSync(pidFile, 'utf8')) : run.worker?.pid || run.dispatcherPid;
    return [{...run, folder, file, pid, active: !run.result && alive(pid)}];
  });
}

export class DetachedPlannerRuns {
  constructor(root, owner, finished, scope) { Object.assign(this, {root, owner, finished, scope}); }
  get runs() { return detachedRuns(this.root, this.owner); }
  get size() { return plannerRows(this.root, null, Infinity, {...this.scope, dispatcherId: this.owner})
    .filter(run => run.active).length; }
  get current() { return this.runs.map(run => ({folder: run.folder, ended: !run.active,
    finishedAt: run.result?.finishedAt})); }
  owns(address) { return this.runs.some(run => run.active && run.address === address); }

  async start(address, args, env, attemptKey, configured, metadata = {}) {
    const input = Number(env.PLANNING_JOPPA_INPUT ?? 0);
    if (!Number.isSafeInteger(input) || input < 0) throw new Error('Invalid worker input index');
    const stamp = new Date().toLocaleString('sv-SE').replace(' ', '_').replaceAll(':', '-');
    const folder = path.join(this.root, `${stamp}-${randomUUID()}`), file = path.join(folder, 'launch.json');
    fs.mkdirSync(folder, {recursive: true, mode: 0o700});
    const configIndex = args.indexOf('--config') + 1;
    const raw = fs.readFileSync(args[configIndex]);
    if (createHash('sha256').update(raw).digest('hex') !== env.PLANNING_JOPPA_HANDOFF_DIGEST) {
      fs.rmdirSync(folder);
      const run = {address, attemptKey, code: 75, current: null, completion: Promise.resolve(75)};
      this.finished(run);
      return run;
    }
    const snapshot = path.join(folder, 'config.json');
    const frozen = freezeFlush(raw, input, metadata.flush);
    fs.writeFileSync(snapshot, frozen, {mode: 0o600});
    env = {...env, PLANNING_JOPPA_HANDOFF_DIGEST: createHash('sha256').update(frozen).digest('hex')};
    const command = [...args];
    command[configIndex] = snapshot;
    const run = {dispatcherId: this.owner, dispatcherPid: process.pid, address, input, attemptKey, workerScript: worker, slot: metadata.slot,
      args: command, createdAt: new Date().toISOString(), ...(metadata.flush ? {flush_request: metadata.flush} : {})};
    save(file, run);
    const log = fs.openSync(path.join(folder, 'output.log'), 'a', 0o600);
    let pid;
    try {
      pid = await startDetached(process.execPath, [worker, file], {env, stdio: ['ignore', log, log]});
    } catch (error) {
      save(file, {...run, result: {code: 2, error: error.message, finishedAt: new Date().toISOString()}});
      throw error;
    } finally { fs.closeSync(log); }
    fs.writeFileSync(path.join(folder, '.worker.pid'), String(pid), {mode: 0o600});
    const completion = (async () => {
      while (this.runs.find(run => run.file === file)?.active) {
        await new Promise(resolve => { const timer = setTimeout(resolve, 1000); timer.unref(); });
      }
      const saved = read(file);
      const result = {address, attemptKey, current: {folder}, code: saved.result?.code ?? 2,
        error: saved.result?.error};
      this.finished(result);
      return result.code;
    })();
    return {address, attemptKey, current: {folder}, completion};
  }

  async stop() {} // Closing a dashboard never stops detached work.
}

export function stopDetachedRun(root, owner, id) {
  const matches = detachedRuns(root, owner).filter(run => path.basename(run.folder) === id || run.folder.endsWith('-' + id));
  if (matches.length !== 1 || !matches[0].active) throw new Error('No unique live detached run matches this ID');
  const run = matches[0];
  const command = execFileSync('ps', ['-p', String(run.pid), '-o', 'command='], {encoding: 'utf8'});
  if (!command.includes(run.workerScript) || !command.includes(run.file)) throw new Error('Worker PID does not match this run');
  process.kill(run.pid, 'SIGTERM');
  return path.basename(run.folder);
}
