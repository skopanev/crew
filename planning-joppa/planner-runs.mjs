// Each planner process owns its output buffer, run folder and process group.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

const signalGroup = (run, signal) => {
  if (!run.child?.pid) return false;
  try { process.kill(-run.child.pid, signal); return true; }
  catch (error) { if (error.code !== 'ESRCH') throw error; return false; }
};

export class PlannerRuns {
  constructor(root, finished) {
    this.root = root;
    this.finished = finished;
    this.active = new Map();
    this.completed = [];
  }
  get size() { return this.active.size; }
  get current() { return [...this.completed, ...this.active.values()].map(run => run.current).filter(Boolean); }
  owns(address) { return this.active.has(address); }

  start(address, args, env, attemptKey = null, configured = false) {
    if (this.stopping || this.owns(address)) throw new Error(`Planner already reserves ${address} or is stopping`);
    const run = {address, attemptKey, configured, current: null, child: null, error: null};
    // Reserve the address before spawn. The claim can change its revision while the child runs.
    this.active.set(address, run);
    let pending = '', buffered = '', ended = false, resolve;
    run.completion = new Promise(done => { resolve = done; });
    const finish = code => {
      if (ended) return;
      ended = true;
      run.code = code ?? 2;
      if (run.current) Object.assign(run.current, {ended: true, finishedAt: new Date().toISOString()});
      this.active.delete(address);
      this.completed.push(run);
      this.completed = this.completed.slice(-30);
      this.finished(run);
      resolve(run.code);
    };
    const output = data => {
      const text = data.toString();
      if (run.current) fs.appendFileSync(path.join(run.current.folder, 'output.log'), text);
      else {
        buffered = (buffered + text).slice(-65536);
        pending += text;
        const lines = pending.split('\n');
        pending = lines.pop();
        for (const line of lines) {
          const folder = line.trim();
          const canonicalRoot = fs.existsSync(this.root) ? fs.realpathSync(this.root) : this.root;
          if ((folder.startsWith(this.root + path.sep) || folder.startsWith(canonicalRoot + path.sep)) && fs.existsSync(folder)) {
            run.current = {folder, ended: false};
            fs.appendFileSync(path.join(folder, 'output.log'), buffered);
            buffered = '';
            break;
          }
          if (line.startsWith('planning-joppa:')) run.error = line.trim();
        }
      }
    };
    try {
      run.child = spawn('sh', args, {stdio: ['ignore', 'pipe', 'pipe'], detached: true, env});
      run.child.stdout.on('data', output);
      run.child.stderr.on('data', output);
      run.child.once('error', error => { run.error = error.message; finish(2); });
      run.child.once('close', finish);
    } catch (error) { run.error = error.message; finish(2); }
    return run;
  }

  stop(signal) {
    return this.stopping ??= Promise.all([...this.active.values()].map(async run => {
      let sent = false;
      if (run.configured && run.child?.pid) {
        // The flow launcher stops Medulla before it releases its claim.
        try { process.kill(run.child.pid, signal); sent = true; }
        catch (error) { if (error.code !== 'ESRCH') throw error; }
      } else sent = signalGroup(run, signal);
      if (sent) {
        // Allow 10 s for Medulla shutdown and 30 s for the guarded release.
        const deadline = Date.now() + (run.configured ? 45000 : 5000);
        while (signalGroup(run, 0) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        signalGroup(run, 'SIGKILL');
      }
      await run.completion;
    }));
  }
}
