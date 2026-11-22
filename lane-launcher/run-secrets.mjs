import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const require = (ok, message) => {
  if (!ok) throw Object.assign(new Error(`PRE_LAUNCH_SECRETS_INVALID: ${message}`), {code: 'PRE_LAUNCH_SECRETS_INVALID'});
};
const inside = (file, root) => file === root || file.startsWith(root.endsWith(path.sep) ? root : root + path.sep);
const plainPath = value => typeof value === 'string' && value.length > 0 && !/[\0\r\n:]/.test(value);
const invalid = error => error.code === 'PRE_LAUNCH_SECRETS_INVALID' ? error :
  Object.assign(new Error(`PRE_LAUNCH_SECRETS_INVALID: ${error.message}`), {code: 'PRE_LAUNCH_SECRETS_INVALID'});

// The private directory is never part of the shared source or run-artifact mounts.
export function prepareRunSecrets(run, outerDir) {
  if (run.config.preLaunchSecrets !== true) return null;
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-run-secrets-')));
  const cleanup = () => fs.rmSync(dir, {recursive: true, force: true});
  try {
    const roots = [run.config.sourceRoot, run.config.stateDir, run.config.worktreeRoot,
      run.config.sshDir, run.config.cbmCacheDir, ...run.config.readOnlyRepos || [],
      ...run.config.readWriteDirs || [], fileURLToPath(new URL('..', import.meta.url)),
      run.config.workflow && path.dirname(run.config.workflow)].filter(Boolean);
    require(roots.every(root => !inside(dir, fs.existsSync(root) ? fs.realpathSync(root) : path.resolve(root))),
      'temporary directory overlaps a configured shared mount');
    fs.chmodSync(dir, 0o700);
    fs.copyFileSync(path.join(outerDir, 'launch.json'), path.join(dir, 'launch.json'));
    fs.chmodSync(path.join(dir, 'launch.json'), 0o600);
    return {dir, cleanup, mountArgs: () => {
      try { return manifestMounts(dir); }
      catch (error) { throw invalid(error); }
    }};
  } catch (error) { cleanup(); throw invalid(error); }
}

function manifestMounts(dir) {
  const manifest = path.join(dir, 'mounts.json');
  let stat;
  try { stat = fs.lstatSync(manifest); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  require(stat.isFile() && stat.size <= 65536, 'mounts.json must be a regular file of at most 64 KiB');
  let rows;
  try { rows = JSON.parse(fs.readFileSync(manifest, 'utf8')); }
  catch { require(false, 'mounts.json must contain a JSON list'); }
  require(Array.isArray(rows), 'mounts.json must contain a JSON list');
  const hosts = new Set(), targets = new Set();
  return rows.flatMap(row => {
    require(row && Object.keys(row).sort().join(',') === 'container_path,host_path,mode' && row.mode === '0600',
      'each mount needs host_path, container_path and mode "0600"');
    const {host_path: host, container_path: target} = row;
    require(plainPath(host) && path.isAbsolute(host) && inside(path.resolve(host), dir) &&
      !['launch.json', 'mounts.json'].includes(path.relative(dir, host)), 'host_path must name a secret inside CREW_RUN_DIR');
    const parent = fs.realpathSync(path.dirname(host));
    require(inside(parent, dir), 'host_path parent escapes CREW_RUN_DIR');
    require(plainPath(target) && path.posix.isAbsolute(target) && path.posix.normalize(target) === target &&
      target !== '/' && !target.endsWith('/') && !inside(target, '/workspace'),
      'container_path must be an absolute file path outside /workspace');
    require(!hosts.has(host) && ![...targets].some(other => inside(target, other) || inside(other, target)),
      'secret mount paths must be distinct and must not overlap');
    hosts.add(host); targets.add(target);
    require(fs.lstatSync(host).isFile(), 'host_path must be a regular file');
    const fd = fs.openSync(host, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const file = fs.fstatSync(fd);
      require(file.isFile() && file.nlink === 1, 'host_path must be a regular file without other hard links');
      fs.fchmodSync(fd, 0o600);
    } finally { fs.closeSync(fd); }
    return ['--mount-file', `${host}:${target}`];
  });
}
