// Run an optional host command before the worker claims a Task or starts a lane.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

export function validatePreLaunch(config) {
  const args = config.preLaunch;
  if (args != null && (!Array.isArray(args) || !args.length ||
      args.some(arg => typeof arg !== 'string' || arg.includes('\0')) || !args[0].trim())) {
    throw new Error('preLaunch must be a command argument array');
  }
  const seconds = config.preLaunchTimeoutSeconds ?? 60;
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 2147483) {
    throw new Error('preLaunchTimeoutSeconds must be 1 to 2147483');
  }
}

const refusal = (code, message) => Object.assign(new Error(`${code}: ${message}`), {code});

export async function runPreLaunch(run, dir, {signal, announce = () => {}} = {}) {
  if (run.config.preLaunch == null) return;
  const logFile = path.join(dir, 'pre-launch.log');
  let fd, timer, child, failure;
  const stop = (code, message) => {
    failure ||= refusal(code, message);
    if (child?.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  const abort = () => stop('PRE_LAUNCH_ABORTED', 'host command interrupted');
  try {
    validatePreLaunch(run.config);
    if (signal?.aborted) throw refusal('PRE_LAUNCH_ABORTED', 'host command interrupted');
    const seconds = run.config.preLaunchTimeoutSeconds ?? 60;
    fd = fs.openSync(logFile, 'a', 0o600);
    fs.writeSync(fd, `[pre-launch] ${new Date().toISOString()} · timeout ${seconds}s\n`);
    announce(`[lane] PRE_LAUNCH · timeout ${seconds}s · log: ${logFile}`);
    const started = performance.now();
    const [command, ...args] = run.config.preLaunch;
    child = spawn(command, args, {cwd: dir, detached: true, stdio: ['ignore', fd, fd],
      env: {...process.env, CREW_DISPATCHER_ID: run.config.id, CREW_RUN_DIR: dir}});
    signal?.addEventListener('abort', abort, {once: true});
    timer = setTimeout(() => stop('PRE_LAUNCH_TIMEOUT', `host command exceeded ${seconds}s`), seconds * 1000);
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, receivedSignal) => {
        if (failure) reject(failure);
        else if (code !== 0) reject(refusal('PRE_LAUNCH_FAILED', `host command exited ${code ?? receivedSignal}`));
        else resolve();
      });
    });
    announce(`[lane] PRE_LAUNCH OK · ${((performance.now() - started) / 1000).toFixed(1)}s`);
  } catch (error) {
    const message = `${error.message}; log: ${logFile}`;
    if (fd !== undefined) fs.writeSync(fd, `[pre-launch] ${error.message}\n`);
    throw refusal(String(error.code || '').startsWith('PRE_LAUNCH_') ? error.code : 'PRE_LAUNCH_FAILED',
      message.replace(/^PRE_LAUNCH_[A-Z]+: /, ''));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (fd !== undefined) fs.closeSync(fd);
  }
}
