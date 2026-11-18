// Stop only containers tied to this run. Docker provides TERM, then KILL after the grace period.
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {command} from './runtime.mjs';

const docker = args => execFileSync('docker', args, {encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe']});
const absent = error => /No such (?:object|container)/i.test(String(error.stderr || error.message));

// The old process group and every container of its run or checkout must be gone.
export function writerGone(run, checkout) {
  if (!Number.isSafeInteger(run.launchPgid) || run.launchPgid <= 1) return false;
  try { process.kill(-run.launchPgid, 0); return false; }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  const folders = new Set([run.runFolder]);
  try { folders.add(fs.realpathSync(run.runFolder)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const ids = command('docker', ['ps', '-q', '--no-trunc']).split('\n').filter(Boolean);
  if (!ids.length) return true;
  let rows;
  try { rows = JSON.parse(command('docker', ['inspect', ...ids])); }
  catch (error) {
    // An unrelated container can disappear between ps and inspect.
    const missing = String(error.stderr || '').trim().split('\n').map(line =>
      /^Error: no such object: ([a-z0-9]+)$/i.exec(line.trim())?.[1]);
    if (error.status !== 1 || !missing.length || missing.some(id => !id || !ids.includes(id))) throw error;
    rows = JSON.parse(String(error.stdout));
    if (!Array.isArray(rows) || rows.length + missing.length !== ids.length ||
        !rows.every(row => ids.includes(row.Id) && !missing.includes(row.Id))) throw new Error('Docker inspection is incomplete');
  }
  return !rows.some(row => folders.has(row.Config?.Labels?.['medulla.runs_under']) ||
    (row.Mounts || []).some(mount => mount.Source === checkout));
}

function inspect(id) {
  try { return JSON.parse(docker(['inspect', id]))[0]; }
  catch (error) { if (absent(error)) return null; throw error; }
}
export function stopRunContainers(runFolder) {
  const root = fs.realpathSync(runFolder);
  const sessionIds = docker(['ps', '--no-trunc', '-q']).trim().split('\n').filter(Boolean);
  const stopped = [], errors = [];
  for (const id of new Set(sessionIds)) {
    try {
      if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('Docker returned an invalid container ID');
      const container = inspect(id);
      if (!container?.State?.Running) continue;
      const labels = container.Config?.Labels || {};
      if (!labels['medulla.session-owner'] ||
          !container.Mounts?.some(mount => mount.RW === true && mount.Source === root)) continue;
      try { docker(['stop', '--timeout', '10', id]); }
      catch (error) { if (!absent(error)) throw error; }
      if (inspect(id)?.State?.Running) throw new Error('Run container did not stop: ' + id);
      stopped.push(id);
    } catch (error) { errors.push(error.message); }
  }
  if (errors.length) throw new Error(errors.join('; '));
  return stopped;
}
