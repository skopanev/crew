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
    ...(config.dockerEngine ? ['--docker-engine'] : []),
    '--cbm-mcp-command', config.cbmMcpCommand, '--cbm-cache-dir', config.cbmCacheDir,
    '--test-command', JSON.stringify(config.testCommand || []),
    '--ssh-dir', config.sshDir,
    ...config.readOnlyRepos.flatMap(repo => ['--mount-ro', repo]),
    ...config.gateCommands.flatMap(check => ['--gate-command', check])];
}
export function runDirectories(stateDir) {
  const root = path.join(stateDir, 'runs');
  fs.mkdirSync(root, {recursive: true, mode: 0o700});
  return fs.readdirSync(root).map(name => path.join(root, name))
    .filter(dir => fs.statSync(dir).isDirectory());
}
