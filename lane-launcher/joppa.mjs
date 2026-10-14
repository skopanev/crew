import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {callJoppa} from './joppa-api.mjs';
import {dependencyCheck} from './dependencies.mjs';
import {createHash, randomUUID} from 'node:crypto';
import {readRun, runDirectories, save, command, quote} from './runtime.mjs';
import {completionEvent, reasonCode} from '../notify.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = (condition, message) => { if (!condition) throw new Error(message); };
const text = value => typeof value === 'string' && value.trim();
const inside = (file, root) => file === root || file.startsWith(root + path.sep);
export const executionId = address => 'joppa-' + createHash('sha256').update(address).digest('hex').slice(0, 32);
export const contractDigest = object => createHash('sha256').update(JSON.stringify({
  parent: object.document.parent, data: object.document.data, links: object.document.links,
})).digest('hex');

export function validateJoppa(config) {
  const joppa = config.joppa;
  require(joppa && text(joppa.url) && text(joppa.project), 'Config needs joppa.url and a full joppa.project address');
  const url = new URL(joppa.url);
  require((url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) &&
    !url.username && !url.password && !url.search && !url.hash, 'Joppa needs HTTPS or loopback HTTP without URL credentials');
  require(joppa.project.includes(':'), 'joppa.project must be a full object address');
  require(Array.isArray(joppa.workers) && joppa.workers.length >= config.limit, 'Each lane slot needs a separate Joppa worker');
  const actors = new Set(), tokens = new Set();
  for (const worker of joppa.workers) {
    require(text(worker.actor) && !actors.has(worker.actor), 'Joppa worker actors must be distinct');
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
  require(!config.tags?.length && !config.preferTags?.length, 'Joppa uses project and purpose filters, not NTK tags');
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
    require(repo.gateTimeoutSeconds == null || (Number.isSafeInteger(repo.gateTimeoutSeconds) && repo.gateTimeoutSeconds > 0),
      'Repository gateTimeoutSeconds must be a positive integer');
    require(Array.isArray(repo.testCommand) && repo.testCommand.length && repo.testCommand.every(text), 'Repository needs testCommand');
    require(repo.preflight === null || (text(repo.preflight) && !path.isAbsolute(repo.preflight) &&
      inside(path.resolve(folder, repo.preflight), folder)), 'Repository needs preflight: relative executable path or null');
    ids.add(repo.id); paths.add(folder);
  }
  require(['branch', 'target'].includes(config.delivery), 'delivery must be branch or target');
  require(text(config.worktreeRoot) && path.isAbsolute(config.worktreeRoot) &&
    inside(path.resolve(config.worktreeRoot), root) && path.resolve(config.worktreeRoot) !== root,
    'worktreeRoot must be a directory inside sourceRoot');
  require(!paths.has(path.resolve(config.worktreeRoot)), 'worktreeRoot must not replace a canonical repository');
  if (fs.existsSync(config.worktreeRoot)) require(fs.realpathSync(config.worktreeRoot) === path.resolve(config.worktreeRoot), 'worktreeRoot must not be a symlink');
}

export function api(config, worker, tool, arguments_, {signal} = {}) {
  return callJoppa(config.joppa.url, worker.tokenFile, tool, arguments_, {signal});
}

export async function nextTask(config) {
  const busy = new Set(runDirectories(config.stateDir).flatMap(dir => {
    try { const run = readRun(path.join(dir, 'launch.json')); return !run.result || run.claimRequest && !run.claim && !run.claimRejected ? [run.joppaWorker?.actor] : []; }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  }));
  let available = 0, held = 0;
  for (const worker of config.joppa.workers) {
    if (busy.has(worker.actor)) continue;
    const mine = await api(config, worker, 'joppa_tasks', {workspace: config.workspace, view: 'mine', limit: 1});
    if (mine.total) { held++; continue; }
    const dependencies = dependencyCheck((tool, args) => api(config, worker, tool, {workspace: config.workspace, ...args}));
    const eligible = [];
    let cursor;
    do {
      const page = await api(config, worker, 'joppa_tasks', {workspace: config.workspace, project: config.joppa.project,
        purpose: 'implementation', view: 'available', limit: 100, ...(cursor ? {cursor} : {}),
        ...(config.joppa.priorities ? {priorities: config.joppa.priorities} : {})});
      for (const task of page.tasks) if ((await dependencies(task.address)).ready) eligible.push(task);
      cursor = page.next_cursor;
    } while (cursor);
    available = Math.max(available, eligible.length);
    if (eligible.length) {
      const task = eligible[0];
      require(text(task.address) && Number.isSafeInteger(task.revision), 'Joppa returned an invalid Task');
      return {candidate: {id: task.address, title: task.title, revision: task.revision}, worker, available, held};
    }
  }
  return {candidate: null, available, held};
}

export function taskInput(config, object) {
  require(object.document?.present === true && object.historical === false, 'Joppa Task is absent or historical');
  const data = object.document.data;
  require(text(data?.contract) && data.purpose === 'implementation', 'Task needs an implementation contract');
  const field = name => {
    const matches = [...data.contract.matchAll(new RegExp(`^${name}:[ \\t]*(\\S[^\\r\\n]*)$`, 'gm'))];
    require(matches.length === 1, `Task contract needs exactly one ${name}: line`);
    return matches[0][1].trim();
  };
  const repo = config.repositories.find(repo => repo.id === field('Repository'));
  require(repo, 'Task repository is not configured');
  const module = field('Module');
  const configuredModule = repo.modules.find(item => item.name === module);
  const modulePath = configuredModule?.path;
  require(modulePath, 'Task module is not configured');
  return {repo, ticket: {id: executionId(object.address), address: object.address, title: data.title,
    body: data.contract, module: modulePath, moduleId: module, modulePaths: configuredModule.paths || [modulePath],
    repository: repo.id, revision: object.current_revision, source: 'joppa',
    parent: object.document.parent, links: object.document.links, annotations: object.annotations || {}, acceptance: data.contract}};
}

export async function claimTask(run, persist) {
  if (!run.claimRequest) {
    const check = dependencyCheck((tool, args) => api(run.config, run.joppaWorker, tool, {workspace: run.workspace, ...args}));
    const dependency = await check(run.task);
    require(dependency.ready, `DEPENDENCY_NOT_READY: ${dependency.blocker}`);
  }
  run.claimRequest ||= {workspace: run.workspace, request_id: randomUUID(), command: {
    op: 'claim_task', id: run.task, revision: run.taskRevision}};
  persist();
  try { await api(run.config, run.joppaWorker, 'joppa_command', run.claimRequest); }
  catch (error) { if (error.rejected) { run.claimRejected = true; persist(); } throw error; }
  const object = await api(run.config, run.joppaWorker, 'joppa_objects', {workspace: run.workspace, address: run.task});
  require(object.address === run.task, 'Joppa returned a different Task after claim');
  require(object.process?.assignee === run.joppaWorker.actor && object.process.status === 'in_progress',
    'Joppa did not confirm the configured worker as Task holder');
  run.claim = {claimed: true, id: run.executionId, workspace: run.workspace, status: 'in_progress', source: 'joppa',
    address: run.task, actor: run.joppaWorker.actor, revision: object.current_revision, digest: contractDigest(object)};
  persist();
  require(object.work_ready === true && object.review_required === false && object.process?.review_required !== true,
    'Claimed Task needs dependency or contract review before execution');
  const input = taskInput(run.config, object);
  if (object.document.parent) {
    const parent = await api(run.config, run.joppaWorker, 'joppa_objects',
      {workspace: run.workspace, address: object.document.parent});
    require(parent.address === object.document.parent && parent.document?.present === true && parent.historical === false &&
      Number.isSafeInteger(parent.current_revision) && parent.current_revision > 0,
      'Task parent context is absent or historical');
    input.ticket.parentContext = {use: 'Acceptance reference. Execute only the Task contract.',
      address: parent.address, revision: parent.current_revision, data: parent.document.data};
    run.claim.parent = {address: parent.address, digest: contractDigest(parent)};
  }
  run.claim.ticket = input.ticket;
  run.repository = input.repo;
  persist();
  return run.claim;
}

export async function finishTask(run, stateFile, result, artifacts) {
  if (!run.claim) return;
  const persist = () => save(stateFile, run);
  const object = await api(run.config, run.joppaWorker, 'joppa_objects', {workspace: run.workspace, address: run.task});
  require(object.address === run.task, 'Joppa returned a different Task for completion');
  require(object.process?.assignee === run.joppaWorker.actor && object.process.status === 'in_progress', 'Task holder changed; outcome not written');
  if (result.code === 0) {
    require(object.work_ready === true && object.review_required === false && object.process?.review_required !== true,
      'TASK_REVIEW_REQUIRED: Task context needs review; landed work remains held');
    require(contractDigest(object) === run.claim.digest, 'Task contract changed during execution; completion refused');
    const report = ['landing.txt', 'verification.txt'].map(name => path.join(artifacts || '', name)).find(file => fs.existsSync(file));
    require(report, 'Checked publication evidence is missing; Task remains held');
    const evidence = fs.readFileSync(report, 'utf8');
    const sha = evidence.match(/(?:Landed SHA|Verified existing SHA): ([0-9a-f]{40,64})\b/)?.[1];
    const target = evidence.match(/^Target: (.+)$/m)?.[1];
    const expected = report.endsWith('verification.txt') || run.config.delivery === 'target' ? run.repository.targetBranch : run.deliveryBranch || `ticket-${run.executionId}`;
    require(sha && target === expected, 'Publication evidence does not match the configured delivery');
    const env = {...process.env, GIT_SSH_COMMAND: `ssh -F /dev/null -i ${quote(path.join(run.config.sshDir, 'id_ed25519'))} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${quote(path.join(run.config.sshDir, 'known_hosts'))}`};
    const remote = await new Promise((resolve, reject) => execFile('git', ['-C', run.repository.path, 'ls-remote', 'origin', `refs/heads/${target}`],
      {env, encoding: 'utf8', timeout: 120_000}, (error, output) => error ? reject(new Error('Cannot confirm published SHA')) : resolve(output.trim().split(/\s/)[0])));
    if (remote !== sha && remote && expected === run.repository.targetBranch) {
      const git = args => new Promise((resolve, reject) => execFile('git', ['-C', run.repository.path, ...args],
        {env, encoding: 'utf8', timeout: 120_000}, error => error ? reject(new Error('Remote branch does not contain the checked SHA; Task remains held')) : resolve()));
      await git(['fetch', '--no-write-fetch-head', 'origin', remote]);
      await git(['merge-base', '--is-ancestor', sha, remote]);
    } else require(remote === sha, 'Remote branch does not confirm the checked SHA; Task remains held');
    const followups = path.join(artifacts, 'followups.txt');
    const findings = fs.existsSync(followups) ? fs.readFileSync(followups, 'utf8').trim() : '';
    if (run.claim.parent) {
      const parent = await api(run.config, run.joppaWorker, 'joppa_objects',
        {workspace: run.workspace, address: run.claim.parent.address});
      require(parent.address === run.claim.parent.address && parent.document?.present === true && parent.historical === false &&
        Number.isSafeInteger(parent.current_revision) && parent.current_revision > 0 && parent.work_ready === true &&
        parent.review_required === false && parent.process?.review_required !== true,
        'Task parent context needs review; completion refused');
    }
    const current = await api(run.config, run.joppaWorker, 'joppa_objects', {workspace: run.workspace, address: run.task});
    require(current.address === run.task && current.process?.assignee === run.joppaWorker.actor && current.process.status === 'in_progress',
      'Task holder changed before completion; outcome not written');
    require(current.work_ready === true && current.review_required === false && current.process?.review_required !== true,
      'TASK_REVIEW_REQUIRED: Task context needs review; landed work remains held');
    require(contractDigest(current) === run.claim.digest, 'Task contract changed before completion; completion refused');
    run.completionRequest ||= {workspace: run.workspace, request_id: randomUUID(), command: {
      op: 'complete_task', id: run.task, revision: current.current_revision,
      evidence: `${evidence.trim()}\nRequired gates and independent review passed. Run: ${path.basename(path.dirname(stateFile))}${findings ? '\nNonblocking findings:\n' + findings : ''}`}};
    persist();
    await api(run.config, run.joppaWorker, 'joppa_command', run.completionRequest);
    const confirmed = await api(run.config, run.joppaWorker, 'joppa_objects', {workspace: run.workspace, address: run.task});
    require(confirmed.process?.status === 'done', 'Joppa did not confirm Task completion');
    result.completed = true;
  } else {
    const startup = fs.readFileSync(path.join(path.dirname(stateFile), 'output.log'), 'utf8').split('\n')
      .filter(line => /^(run\.sh:|\[sync\]).*(failed|refused|WORKTREE PREEXISTED|disconnected|unavailable|cannot)/i.test(line)).at(-1);
    const preexisting = result.code === 73 && startup?.includes('WORKTREE PREEXISTED:');
    const failureFile = artifacts && path.join(artifacts, 'failure.txt');
    if (!preexisting && (!failureFile || !fs.existsSync(failureFile))) {
      await noteHeldTask(run, stateFile, startup || result.error || 'Lane startup failed');
      result.held = true;
      return;
    }
    result.blocked = true;
    const failure = preexisting ? startup : fs.readFileSync(failureFile, 'utf8');
    run.blockRequest ||= {workspace: run.workspace, request_id: randomUUID(), command: {
      op: 'block_task', id: run.task, revision: object.current_revision,
      reason: preexisting ? 'WORKTREE_PREEXISTED' : reasonCode(completionEvent(run, result, artifacts)),
      evidence: `${failure || 'Lane failed'}\nRun: ${path.basename(path.dirname(stateFile))}`}};
    persist();
    await api(run.config, run.joppaWorker, 'joppa_command', run.blockRequest);
    const confirmed = await api(run.config, run.joppaWorker, 'joppa_objects', {workspace: run.workspace, address: run.task});
    const blocked = confirmed.process?.blocked;
    require(confirmed.address === run.task && confirmed.process?.status === 'open' &&
      confirmed.process.assignee === null && blocked?.actor === run.joppaWorker.actor &&
      blocked.reason === run.blockRequest.command.reason && blocked.evidence === run.blockRequest.command.evidence &&
      Number.isSafeInteger(blocked.position) && blocked.position > 0,
      'Joppa did not confirm the Task block; outcome requires inspection');
    result.blockConfirmed = true;
  }
}

export async function noteHeldTask(run, stateFile, reason) {
  // Preserve the request ID if the server response is lost. Do not release or rerun the Task.
  run.failureRequest ||= {workspace: run.workspace, request_id: randomUUID(), command: {op: 'note', target: run.task,
    id: randomUUID(), text: `${reason}\nRun: ${path.basename(path.dirname(stateFile))}\nOutcome not confirmed. Inspect evidence before retrying.`, reply_to: null}};
  save(stateFile, run);
  await api(run.config, run.joppaWorker, 'joppa_command', run.failureRequest);
}
