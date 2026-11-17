// Stop only containers tied to this run. Docker provides TERM, then KILL after the grace period.
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';

const docker = args => execFileSync('docker', args, {encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe']});
const absent = error => /No such (?:object|container)/i.test(String(error.stderr || error.message));
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
