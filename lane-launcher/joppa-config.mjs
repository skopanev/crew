import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {command} from './runtime.mjs';
const require = (condition, message) => { if (!condition) throw new Error(message); };
const text = value => typeof value === 'string' && value.trim();
const here = path.dirname(fileURLToPath(import.meta.url));
const inside = (file, root) => file === root || file.startsWith(root + path.sep);

export function validateJoppa(config) {
  const joppa = config.joppa;
  require(joppa && text(joppa.url) && text(joppa.project), 'Config needs joppa.url and a full joppa.project address');
  const url = new URL(joppa.url);
  require((url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) &&
    !url.username && !url.password && !url.search && !url.hash, 'Joppa needs HTTPS or loopback HTTP without URL credentials');
  require(joppa.project.includes(':'), 'joppa.project must be a full object address');
  const sharedLogin = joppa.mcpCommand !== undefined;
  if (sharedLogin) require(Array.isArray(joppa.mcpCommand) && joppa.mcpCommand.length &&
    joppa.mcpCommand.every(arg => text(arg) && !arg.includes('\0')), 'Joppa mcpCommand needs an executable and arguments');
  require(Array.isArray(joppa.workers) && joppa.workers.length >= (sharedLogin ? 1 : config.limit),
    sharedLogin ? 'Joppa needs the existing user actor' : 'Each lane slot needs a separate Joppa worker');
  if (sharedLogin) require(joppa.workers.length === 1, 'A shared Joppa login uses exactly one existing user actor');
  if (sharedLogin) require(config.delivery !== 'requirement',
    'Shared Joppa login currently supports target or branch delivery');
  const actors = new Set(), tokens = new Set();
  for (const worker of joppa.workers) {
    require(text(worker.actor) && !actors.has(worker.actor), 'Joppa worker actors must be distinct');
    if (sharedLogin) { actors.add(worker.actor); continue; }
    require(text(worker.tokenFile) && path.isAbsolute(worker.tokenFile), 'Joppa worker tokenFile must be absolute');
    const token = fs.realpathSync(worker.tokenFile);
    require(fs.statSync(token).isFile() && !tokens.has(token), 'Joppa worker token files must be distinct files');
    require((fs.statSync(token).mode & 0o077) === 0, 'Joppa token files must not grant group or other access');
    const mounted = [config.sourceRoot, path.resolve(here, '..'), config.stateDir,
      config.sshDir, ...(config.readOnlyRepos || []), ...(config.readWriteDirs || [])].filter(Boolean);
    require(!mounted.some(root => inside(token, fs.existsSync(root) ? fs.realpathSync(root) : root)),
      'Joppa token files must stay outside source, Crew, run, key and extra mount directories');
    actors.add(worker.actor); tokens.add(token);
  }
  require(!config.tags?.length && !config.preferTags?.length, 'Joppa uses a project filter, not tags');
  require(Array.isArray(config.repositories) && config.repositories.length, 'Config needs repositories');
  require(text(config.sourceRoot) && path.isAbsolute(config.sourceRoot), 'Config needs absolute sourceRoot');
  const root = fs.realpathSync(config.sourceRoot), ids = new Set(), paths = new Set();
  for (const repo of config.repositories) {
    require(text(repo.id) && !ids.has(repo.id), 'Repository IDs must be distinct');
    require(text(repo.path) && path.isAbsolute(repo.path), 'Repository paths must be absolute');
    const folder = fs.realpathSync(repo.path);
    require(inside(folder, root) && !paths.has(folder) && fs.statSync(path.join(folder, '.git')).isDirectory(),
      'Each repository needs a distinct canonical Git directory inside sourceRoot');
    require(text(repo.targetBranch) && repo.targetBranch !== 'HEAD' && !repo.targetBranch.startsWith('-'), 'Repository needs targetBranch');
    command('git', ['check-ref-format', `refs/heads/${repo.targetBranch}`]);
    require(text(repo.cbmProject), 'Repository needs cbmProject');
    require(Array.isArray(repo.modules) && repo.modules.length, 'Repository needs modules: [{name, path}]');
    const modules = new Set();
    for (const {name, path: modulePath, paths: modulePaths = [modulePath]} of repo.modules) {
      require(!modules.has(name), 'Module names must be distinct within their repository');
      require(text(name) && text(modulePath) && !path.isAbsolute(modulePath) && inside(path.resolve(folder, modulePath), folder),
        'Module paths must stay inside their repository');
      require(inside(fs.realpathSync(path.resolve(folder, modulePath)), folder), 'Module symlinks must stay inside their repository');
      require(Array.isArray(modulePaths) && modulePaths.length, 'Module paths must be a nonempty list');
      for (const scope of modulePaths) {
        require(text(scope) && !path.isAbsolute(scope) && !scope.split(/[\\/]/).includes('..') &&
          inside(path.resolve(folder, scope), folder), 'Module paths must stay inside their repository');
        require(inside(fs.realpathSync(path.resolve(folder, scope)), folder), 'Module symlinks must stay inside their repository');
      }
      modules.add(name);
    }
    require(Array.isArray(repo.gateCommands) && repo.gateCommands.length && repo.gateCommands.every(text), 'Repository needs gateCommands');
    require(repo.reviewCommands == null || Array.isArray(repo.reviewCommands) && repo.reviewCommands.length && repo.reviewCommands.every(text),
      'Repository reviewCommands must be a nonempty array of check commands');
    if (config.delivery === 'requirement') {
      const review = repo.reviewCommands ?? config.reviewCommands;
      require(Array.isArray(review) && review.length && review.every(text),
        'Requirement delivery needs explicit reviewCommands for lint and focused tests');
    }
    require(repo.gateTimeoutSeconds == null || (Number.isSafeInteger(repo.gateTimeoutSeconds) && repo.gateTimeoutSeconds > 0),
      'Repository gateTimeoutSeconds must be a positive integer');
    require(repo.coderTimeoutSeconds == null || (Number.isSafeInteger(repo.coderTimeoutSeconds) && repo.coderTimeoutSeconds > 0),
      'Repository coderTimeoutSeconds must be a positive integer');
    require(Array.isArray(repo.testCommand) && repo.testCommand.length && repo.testCommand.every(text), 'Repository needs testCommand');
    require(repo.preflight === null || (text(repo.preflight) && !path.isAbsolute(repo.preflight) &&
      inside(path.resolve(folder, repo.preflight), folder)), 'Repository needs preflight: relative executable path or null');
    if (repo.afterLand != null) {
      require(text(repo.afterLand) && !path.isAbsolute(repo.afterLand) &&
        inside(path.resolve(folder, repo.afterLand), folder), 'afterLand must be a relative repository executable');
      const hook = fs.realpathSync(path.resolve(folder, repo.afterLand));
      require(inside(hook, folder) && fs.statSync(hook).isFile(), 'afterLand must stay inside its repository');
      fs.accessSync(hook, fs.constants.X_OK);
    }
    ids.add(repo.id); paths.add(folder);
  }
  require(['branch', 'target', 'requirement'].includes(config.delivery), 'delivery must be branch, target or requirement');
  if (config.delivery === 'requirement' && !sharedLogin) {
    const reader = joppa.readerTokenFile;
    require(text(reader) && path.isAbsolute(reader) && fs.statSync(reader).isFile() &&
      (fs.statSync(reader).mode & 0o077) === 0, 'Requirement delivery needs a private read-only joppa.readerTokenFile');
    require(!tokens.has(fs.realpathSync(reader)), 'The Joppa reader must not use a worker mutation token');
  }
  require(text(config.worktreeRoot) && path.isAbsolute(config.worktreeRoot) &&
    inside(path.resolve(config.worktreeRoot), root) && path.resolve(config.worktreeRoot) !== root,
    'worktreeRoot must be a directory inside sourceRoot');
  require(!paths.has(path.resolve(config.worktreeRoot)), 'worktreeRoot must not replace a canonical repository');
  if (fs.existsSync(config.worktreeRoot)) require(fs.realpathSync(config.worktreeRoot) === path.resolve(config.worktreeRoot), 'worktreeRoot must not be a symlink');
}
