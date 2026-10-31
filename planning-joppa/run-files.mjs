// Small file helpers for the Joppa planner dashboard.
import fs from 'node:fs';
import path from 'node:path';

// Read only the end of an existing log. Do not create a history store.
export function tail(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.min(size, 65536));
    const length = fs.readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    return buffer.subarray(0, length).toString('utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return '';
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

// Exclusive create, fail closed. A lock left by a dead dispatcher is never
// removed automatically: between reading its owner and removing it, another
// dispatcher may have replaced it. An operator checks the pid and removes it.
export function lock(stateDir, pid = process.pid) {
  fs.mkdirSync(stateDir, {recursive: true});
  const file = path.join(stateDir, 'dispatch.lock');
  try {
    fs.writeFileSync(file, String(pid), {flag: 'wx'});
    return file;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  let owner = '';
  try { owner = fs.readFileSync(file, 'utf8').trim(); } catch {}
  throw new Error(`Another dispatcher holds ${file}${owner ? ` (pid ${owner})` : ''}. ` +
    'If no dispatcher runs for this workspace, remove the file and start again.');
}
