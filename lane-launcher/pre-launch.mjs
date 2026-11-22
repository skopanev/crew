// Run an optional host command before the worker claims a Task or starts a lane.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

export function validatePreLaunch(config) {
  const args = config.preLaunch;
  if (config.preLaunchSecrets !== undefined && typeof config.preLaunchSecrets !== 'boolean') {
    throw new Error('preLaunchSecrets must be true or false');
  }
  if (config.preLaunchSecrets === true && args == null) throw new Error('preLaunchSecrets requires preLaunch');
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

export async function runHostHook(config, dir, {args, seconds, name, prefix, validate,
  signal, announce = () => {}, logDir = dir}) {
  const logFile = path.join(logDir, name + '.log');
  let fd, timer, child, failure;
  const stop = (code, message) => {
    failure ||= refusal(code, message);
    if (child?.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  const abort = () => stop(prefix + '_ABORTED', 'host command interrupted');
  try {
    validate();
    if (signal?.aborted) throw refusal(prefix + '_ABORTED', 'host command interrupted');
    fd = fs.openSync(logFile, 'a', 0o600);
    fs.writeSync(fd, `[${name}] ${new Date().toISOString()} · timeout ${seconds}s\n`);
    announce(`[lane] ${prefix} · timeout ${seconds}s · log: ${logFile}`);
    const started = performance.now();
    const [command, ...argv] = args;
    child = spawn(command, argv, {cwd: dir, detached: true, stdio: ['ignore', fd, fd],
      env: {...process.env, CREW_DISPATCHER_ID: config.id, CREW_RUN_DIR: dir}});
    signal?.addEventListener('abort', abort, {once: true});
    timer = setTimeout(() => stop(prefix + '_TIMEOUT', `host command exceeded ${seconds}s`), seconds * 1000);
    if (signal?.aborted) abort();
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, receivedSignal) => {
        if (failure) reject(failure);
        else if (code !== 0) reject(refusal(prefix + '_FAILED', `host command exited ${code ?? receivedSignal}`));
        else resolve();
      });
    });
    announce(`[lane] ${prefix} OK · ${((performance.now() - started) / 1000).toFixed(1)}s`);
  } catch (error) {
    const message = `${error.message}; log: ${logFile}`;
    if (fd !== undefined) fs.writeSync(fd, `[${name}] ${error.message}\n`);
    throw refusal(String(error.code || '').startsWith(prefix + '_') ? error.code : prefix + '_FAILED',
      message.replace(new RegExp('^' + prefix + '_[A-Z]+: '), ''));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export async function runPreLaunch(run, dir, options = {}) {
  if (run.config.preLaunch == null) return;
  return runHostHook(run.config, dir, {...options, args: run.config.preLaunch,
    seconds: run.config.preLaunchTimeoutSeconds ?? 60, name: 'pre-launch', prefix: 'PRE_LAUNCH',
    validate: () => validatePreLaunch(run.config)});
}
