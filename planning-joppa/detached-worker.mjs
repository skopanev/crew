// This worker owns one pass. The dashboard can stop without closing its streams.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {read, save} from '../lane-launcher/runtime.mjs';

const file = path.resolve(process.argv[2]), folder = path.dirname(file), run = read(file);
run.worker = {pid: process.pid, startedAt: new Date().toISOString()};
save(file, run);
let child, stopTimer, pending = '', stopped;
const stop = signal => {
  if (stopped) return;
  stopped = signal;
  if (child?.pid) {
    // The configured Python launcher stops Medulla and releases its own claim.
    child.kill('SIGTERM');
    stopTimer = setTimeout(() => {
      try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }, 45000);
  }
};
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => stop(signal));
try {
  child = spawn('sh', run.args, {env: process.env, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
  child.stdout.on('data', data => {
    process.stdout.write(data);
    if (run.medullaRun) return;
    pending += data;
    const lines = pending.split('\n'); pending = lines.pop();
    const configuredRoot = JSON.parse(fs.readFileSync(run.args[run.args.indexOf('--config') + 1])).runs_folder;
    const roots = [path.resolve(configuredRoot), fs.realpathSync(configuredRoot)];
    for (const line of lines) {
      const candidate = line.trim();
      if (path.isAbsolute(candidate) && roots.includes(path.dirname(candidate))) {
        run.medullaRun = candidate; save(file, run); break;
      }
    }
  });
  child.stderr.on('data', data => process.stderr.write(data));
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  run.result = {code: code ?? 2, finishedAt: new Date().toISOString()};
} catch (error) {
  run.result = {code: 2, error: error.message, finishedAt: new Date().toISOString()};
  console.error(`planning-joppa: ${error.message}`);
} finally {
  clearTimeout(stopTimer);
  save(file, run);
}
