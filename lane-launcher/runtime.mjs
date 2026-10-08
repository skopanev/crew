import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';

export function save(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
  fs.renameSync(temp, file);
}
export const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export function readRun(file) {
  const run = read(file);
  // Read existing history. New runs keep their state in one file.
  for (const field of ['worker', 'result']) {
    const previous = path.join(path.dirname(file), `${field}.json`);
    if (!run[field] && fs.existsSync(previous)) run[field] = read(previous);
  }
  return run;
}
export const alive = pid => {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
};
export const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export function command(bin, args) {
  return execFileSync(bin, args, {encoding: 'utf8', timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']}).trim();
}
export function herdr(config, args) {
  const output = command(config.herdr, args);
  // Herdr's pane run/close acknowledge success through exit status and may
  // produce no stdout. Commands that return pane IDs/lists must return JSON.
  if (!output && args[0] === 'pane' && ['run', 'close'].includes(args[1])) return;
  if (!output) throw new Error(`Herdr returned no JSON for ${args.slice(0, 2).join(' ')}`);
  let reply;
  try { reply = JSON.parse(output); }
  catch { throw new Error(`Herdr returned invalid JSON for ${args.slice(0, 2).join(' ')}`); }
  if (reply.error || reply.ok === false) throw new Error(`Herdr refused ${args.slice(0, 2).join(' ')}`);
  return reply.result;
}
export function laneArgs(config, ticket) {
  return ['--ticket-id', ticket, '--project', config.workspace, '--source-root', config.sourceRoot,
    '--dispatcher-id', config.id,
    '--image', config.image,
    ...(config.train ? ['--land-mode', 'train'] : []),
    ...(config.train && config.trainGatesOnly ? ['--train-gates-only'] : []),
    ...(config.laneSetup ? ['--lane-setup', config.laneSetup] : []),
    ...(config.dockerEngine ? ['--docker-engine'] : []),
    '--cbm-mcp-command', config.cbmMcpCommand, '--cbm-cache-dir', config.cbmCacheDir,
    '--test-command', JSON.stringify(config.testCommand || []),
    '--ssh-dir', config.sshDir,
    ...config.readOnlyRepos.flatMap(repo => ['--mount-ro', repo]),
    ...(config.readWriteDirs || []).flatMap(dir => ['--mount-rw', dir]),
    ...config.gateCommands.flatMap(check => ['--gate-command', check])];
}
// Equal, child or parent: the overlap rule for every writable mount.
const inside = (a, b) => {
  const relative = path.relative(b, a);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
const protectedOf = config => [config.sourceRoot, config.sshDir, config.cbmCacheDir,
  ...(config.readOnlyRepos || [])].filter(Boolean).map(dir => fs.realpathSync(dir));
// realpath of a directory that may not exist yet: resolve its nearest existing parent.
function resolveFuture(dir) {
  const missing = [];
  let current = path.resolve(dir);
  while (!fs.existsSync(current)) {
    missing.unshift(path.basename(current));
    current = path.dirname(current);
  }
  return path.join(fs.realpathSync(current), ...missing);
}
export function validateWritableDirs(config, ticket) {
  if (!config.readWriteDirs?.length) return;
  const protectedDirs = protectedOf(config);
  const names = new Set([config.sourceRoot, config.sshDir, ...(config.readOnlyRepos || [])]
    .filter(Boolean).map(dir => path.basename(fs.realpathSync(dir))));
  if (ticket) names.add(ticket);
  for (const folder of config.readWriteDirs) {
    const dir = fs.realpathSync(folder);
    if (protectedDirs.some(other => inside(dir, other) || inside(other, dir))) {
      throw new Error(`Writable directory overlaps a protected directory: ${folder}`);
    }
    const name = path.basename(dir);
    if (names.has(name)) throw new Error(`Writable mount name is already in use: ${name}`);
    names.add(name);
    protectedDirs.push(dir);
  }
}
// The lander's train.persistentMounts are writable too: the same overlap rule applies,
// against the protected directories, the lanes' readWriteDirs and each other.
export function validatePersistentMounts(config) {
  const mounts = config.train?.persistentMounts;
  if (mounts == null) return;
  if (!Array.isArray(mounts)) throw new Error('train.persistentMounts must be an array of {host, inside}');
  const protectedDirs = [...protectedOf(config), ...(config.readWriteDirs || []).map(dir => fs.realpathSync(dir))];
  for (const mount of mounts) {
    if (!mount || typeof mount.host !== 'string' || !path.isAbsolute(mount.host)) {
      throw new Error(`train.persistentMounts host must be an absolute path: ${JSON.stringify(mount)}`);
    }
    const dir = resolveFuture(mount.host);
    if (protectedDirs.some(other => inside(dir, other) || inside(other, dir))) {
      throw new Error(`train.persistentMounts host overlaps a protected or writable directory: ${mount.host}`);
    }
    protectedDirs.push(dir);
  }
}
export function runDirectories(stateDir) {
  const root = path.join(stateDir, 'runs');
  fs.mkdirSync(root, {recursive: true, mode: 0o700});
  return fs.readdirSync(root).map(name => path.join(root, name))
    .filter(dir => fs.statSync(dir).isDirectory());
}
// A train lane exits 0 after queueing its candidate; that is a pending landing, not READY.
// Returns {artifacts, train} for the newest queued run in this launch, or null.
export function queuedOutcome(runFolder) {
  let names;
  try { names = fs.readdirSync(runFolder); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const found = names.map(name => path.join(runFolder, name, 'artifacts'))
    .filter(folder => fs.existsSync(path.join(folder, 'outcome.json')))
    .sort((a, b) => fs.statSync(path.join(b, 'outcome.json')).mtimeMs - fs.statSync(path.join(a, 'outcome.json')).mtimeMs)[0];
  if (!found) return null;
  let outcome;
  try { outcome = read(path.join(found, 'outcome.json')); } catch { return null; }
  if (outcome?.status !== 'queued') return null;
  const result = path.join(found, 'train-result.json');
  let train = null;
  try { if (fs.existsSync(result)) train = read(result); } catch { train = null; }
  return {artifacts: found, train};
}
