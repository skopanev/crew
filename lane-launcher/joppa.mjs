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

export function runHoldsTasks(run) {
  if (run.releaseConfirmed === true) return false;
  if (!run.result || run.result.held || run.claimRequest && !run.claim && !run.claimRejected) return true;
  if (run.claim && !run.result.completed && !run.result.blockConfirmed) return true;
  return Boolean(run.completionRequest && !run.result.completed || run.blockRequest && !run.result.blockConfirmed ||
    run.result.blocked && !run.result.blockConfirmed || /JOPPA_OUTCOME_UNCONFIRMED/.test(run.result.error || ''));
}

async function occupancyReader(config, worker) {
  const schema = await api(config, worker, 'joppa_tree', {workspace: config.workspace}), objects = new Map();
  const object = async address => {
    if (!objects.has(address)) objects.set(address, api(config, worker, 'joppa_objects', {workspace: config.workspace, address}));
    const current = await objects.get(address);
    require(current?.address === address && current.document?.present === true && current.historical === false,
      'Task ownership context is absent or historical');
    return current;
  };
  const group = async address => {
    const current = await object(address), contract = current.document.data?.contract;
    const declarations = typeof contract === 'string' ? [...contract.matchAll(/^Repository:[ \t]*(\S[^\r\n]*)$/gm)] : [];
    const configured = declarations.filter(match => config.repositories.some(repo => repo.id === match[1].trim()));
    if (!configured.length) return null;
    require(declarations.length === 1, 'Held Task repository declaration is ambiguous');
    const repository = configured[0][1].trim(), seen = new Set();
    let parent = current.document.parent;
    while (parent) {
      require(!seen.has(parent), 'Task parent context contains a cycle');
      seen.add(parent);
      const context = await object(parent);
      if (schema.schema.types[context.kind]?.role === 'requirement') return {requirement: context.address, repository};
      parent = context.document.parent;
    }
    throw new Error('Task needs a requirement ancestor');
  };
  return {object, group};
}

async function heldTasks(config, worker, visit) {
  let cursor;
  do {
    const page = await api(config, worker, 'joppa_tasks', {workspace: config.workspace,
      purpose: 'implementation', view: 'all', limit: 100, ...(cursor ? {cursor} : {})});
    for (const task of page.tasks) {
      if (task.status === 'done' || task.status === 'retired' || task.status !== 'in_progress' && !task.assignee) continue;
      await visit(task);
    }
    cursor = page.next_cursor;
  } while (cursor);
}

export async function nextTask(config) {
  const runs = runDirectories(config.stateDir).flatMap(dir => {
    try { return [readRun(path.join(dir, 'launch.json'))]; }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  });
  const reservations = runs.filter(runHoldsTasks);
  const retained = runs.filter(run => {
    if (run.result?.blockConfirmed !== true || !/^joppa-[0-9a-f]{32}$/.test(run.executionId || '') ||
        typeof run.config?.worktreeRoot !== 'string' || typeof config.worktreeRoot !== 'string' ||
        path.resolve(run.config.worktreeRoot) !== path.resolve(config.worktreeRoot)) return false;
    try { fs.lstatSync(path.join(config.worktreeRoot, run.executionId)); return true; }
    catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  });
  const busy = new Set(reservations.map(run => run.joppaWorker?.actor));
  const terminalRetained = new Map();
  let available = 0, held = 0;
  for (const worker of config.joppa.workers) {
    if (busy.has(worker.actor)) continue;
    const mine = await api(config, worker, 'joppa_tasks', {workspace: config.workspace, view: 'mine', limit: 1});
    if (mine.total) { held++; continue; }
    const dependencies = dependencyCheck((tool, args) => api(config, worker, tool, {workspace: config.workspace, ...args}));
    const eligible = [], {object, group} = await occupancyReader(config, worker);
    const occupied = new Set();
    for (const run of [...reservations, ...retained]) {
      if (!run.joppaWorker && !run.config?.joppa) continue;
      if (!reservations.includes(run)) {
        if (!terminalRetained.has(run)) {
          try {
            const tasks = run.claim ? claimTasks(run) : runTasks(run);
            require(tasks.length > 0, 'Retained run has no Tasks');
            let terminal = true;
            for (const task of tasks) {
              const current = await api(config, worker, 'joppa_objects', {workspace: config.workspace, address: task.address});
              require(current.address === task.address && current.historical === false &&
                typeof current.document?.present === 'boolean' && Number.isSafeInteger(current.current_revision),
              'Retained Task state is absent or historical');
              if (current.document.present && !['done', 'retired'].includes(current.process?.status)) {
                terminal = false;
                break;
              }
            }
            terminalRetained.set(run, terminal);
          } catch (error) {
            terminalRetained.set(run, false);
            console.error(`Retained run ${run.executionId} remains occupied: ${error.message}`);
          }
        }
        if (terminalRetained.get(run)) continue;
      }
      const repository = run.repositoryId || run.repository?.id || run.claim?.ticket?.repository;
      const context = run.requirement && repository ? {requirement: run.requirement, repository} : await group(run.task);
      if (context) occupied.add(`${context.requirement}\n${context.repository}`);
    }
    await heldTasks(config, worker, async task => {
      const context = await group(task.address);
      if (context) occupied.add(`${context.requirement}\n${context.repository}`);
    });
    let cursor;
    do {
      const page = await api(config, worker, 'joppa_tasks', {workspace: config.workspace, project: config.joppa.project,
        purpose: 'implementation', view: 'available', limit: 100, ...(cursor ? {cursor} : {}),
        ...(config.joppa.priorities ? {priorities: config.joppa.priorities} : {})});
      for (const task of page.tasks) if ((await dependencies(task.address)).ready) {
        require(text(task.address) && Number.isSafeInteger(task.revision), 'Joppa returned an invalid Task');
        const current = await object(task.address);
        require(current.address === task.address && current.current_revision === task.revision, 'Task changed during queue selection');
        taskInput(config, current);
        const context = await group(task.address);
        if (!occupied.has(`${context.requirement}\n${context.repository}`)) eligible.push({...task, ...context});
      }
      cursor = page.next_cursor;
    } while (cursor);
    available = Math.max(available, eligible.length);
    if (eligible.length) {
      const task = eligible[0];
      const tasks = [...new Map(eligible.filter(item => item.requirement === task.requirement && item.repository === task.repository)
        .map(item => [item.address, item])).values()]
        .sort((a, b) => taskOrder(a) - taskOrder(b) || a.address.localeCompare(b.address))
        .map(item => ({address: item.address, revision: item.revision, title: item.title}));
      require(tasks.length <= 100, 'Repository package exceeds the Joppa 100-operation atomic batch limit; no Tasks claimed');
      return {candidate: {id: tasks[0].address, title: task.title, revision: tasks[0].revision,
        tasks, requirement: task.requirement, repository: task.repository}, worker, available, held};
    }
  }
  return {candidate: null, available, held};
}

const taskOrder = task => Number(/^\[(\d+)\]\s/.exec(task.title || '')?.[1] || Number.MAX_SAFE_INTEGER);
const runTasks = run => run.tasks || [{address: run.task, revision: run.taskRevision}];
const claimTasks = run => run.claim.tasks || [{...run.claim, address: run.task}];

function batchRequest(run, commands) {
  require(commands.length > 0 && commands.length <= 100,
    'Repository package exceeds the Joppa 100-operation atomic batch limit; no partial batch is permitted');
  return {workspace: run.workspace, request_id: randomUUID(), operations: commands.map(command => ({command}))};
}

async function mutateTasks(run, request) {
  const batch = Array.isArray(request.operations);
  const result = await api(run.config, run.joppaWorker, batch ? 'joppa_batch' : 'joppa_command', request);
  if (batch) {
    require(Array.isArray(result.results) && result.results.length === request.operations.length,
      'Joppa batch response is incomplete; Tasks remain held for inspection');
    for (const [index, item] of result.results.entries()) {
      const expected = request.operations[index].command;
      const address = item.object?.address || item.command?.id;
      require(item.command?.op === expected.op && (address === expected.id ||
        address === expected.id.split(':').slice(1).join(':')),
        'Joppa batch response does not map to the requested Task; inspect the saved request');
    }
  }
  return result;
}

export function packageInput(run, inputs) {
  if (inputs.length === 1) return {...inputs[0].ticket, id: run.executionId};
  const tasks = inputs.map(input => input.ticket);
  return {id: run.executionId, address: run.requirement, title: `${run.requirement}: ${inputs[0].repo.id}`,
    source: 'joppa', requirement: run.requirement, repository: inputs[0].repo.id,
    module: tasks[0].module, modulePaths: [...new Set(tasks.flatMap(task => task.modulePaths))],
    tasks, executionOrder: tasks.map(task => task.address),
    body: ['Execute these Tasks in the listed order in one checkout. Keep each Task within its own contract and writable roots.',
      'Run one workflow, required gates, independent review, and landing for the complete package.',
      'Report each Task address, result, and check evidence in coder-report.txt. Review every Task before landing.',
      'Select existing-code verification only when all Tasks already satisfy their contracts.',
      ...tasks.map((task, index) => `Task ${index + 1}: ${task.address}\nWritable roots: ${JSON.stringify(task.modulePaths)}\n${task.body}`)].join('\n\n'),
    acceptance: tasks.map(task => `${task.address}\n${task.acceptance}`).join('\n\n')};
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
  const tasks = runTasks(run);
  require(tasks.length > 0 && tasks.length <= 100,
    'Repository package exceeds the Joppa 100-operation atomic batch limit; no Tasks claimed');
  require(new Set(tasks.map(task => task.address)).size === tasks.length, 'Repository package contains duplicate Tasks');
  if (!run.claimRequest) {
    const check = dependencyCheck((tool, args) => api(run.config, run.joppaWorker, tool, {workspace: run.workspace, ...args}));
    for (const task of tasks) {
      const dependency = await check(task.address);
      require(dependency.ready, `DEPENDENCY_NOT_READY: ${dependency.blocker}`);
    }
  }
  run.claimRequest ||= batchRequest(run, tasks.map(task => ({op: 'claim_task', id: task.address, revision: task.revision})));
  persist();
  try { await mutateTasks(run, run.claimRequest); }
  catch (error) { if (error.rejected) { run.claimRejected = true; persist(); } throw error; }
  const objects = [];
  for (const task of tasks) {
    const object = await api(run.config, run.joppaWorker, 'joppa_objects', {workspace: run.workspace, address: task.address});
    require(object.address === task.address, 'Joppa returned a different Task after claim');
    require(object.process?.assignee === run.joppaWorker.actor && object.process.status === 'in_progress',
      'Joppa did not confirm the configured worker as Task holder');
    objects.push(object);
  }
  run.claim = {claimed: true, id: run.executionId, workspace: run.workspace, status: 'in_progress', source: 'joppa',
    address: run.task, actor: run.joppaWorker.actor, tasks: objects.map(object => ({address: object.address,
      revision: object.current_revision, digest: contractDigest(object)}))};
  persist();
  const inputs = [], parents = new Map();
  const schema = await api(run.config, run.joppaWorker, 'joppa_tree', {workspace: run.workspace});
  run.claim.contexts = [];
  for (const [index, object] of objects.entries()) {
    require(object.work_ready === true && object.review_required === false && object.process?.review_required !== true,
      'Claimed Task needs dependency or contract review before execution');
    const input = taskInput(run.config, object);
    require(!inputs.length || inputs[0].repo.id === input.repo.id, 'Claimed Tasks belong to different repositories');
    let address = object.document.parent, requirement;
    const seen = new Set();
    while (address) {
      require(!seen.has(address), 'Task parent context contains a cycle');
      seen.add(address);
      if (!parents.has(address)) parents.set(address, await api(run.config, run.joppaWorker, 'joppa_objects',
        {workspace: run.workspace, address}));
      const parent = parents.get(address);
      require(parent.address === address && parent.document?.present === true && parent.historical === false &&
        Number.isSafeInteger(parent.current_revision) && parent.current_revision > 0,
        'Task parent context is absent or historical');
      const context = {use: 'Acceptance reference. Execute only this Task contract.',
        address: parent.address, revision: parent.current_revision, data: parent.document.data};
      const snapshot = {address: parent.address, revision: parent.current_revision, digest: contractDigest(parent)};
      if (!run.claim.contexts.some(item => item.address === address)) run.claim.contexts.push(snapshot);
      if (address === object.document.parent) {
        input.ticket.parentContext = context;
        run.claim.tasks[index].parent = snapshot;
      }
      if (schema.schema.types[parent.kind]?.role === 'requirement') {
        requirement = address;
        input.ticket.requirementContext = context;
        break;
      }
      address = parent.document.parent;
    }
    require(requirement && (!run.requirement || run.requirement === requirement), 'Claimed Tasks belong to different requirements');
    run.requirement ||= requirement;
    run.claim.tasks[index].ticket = input.ticket;
    inputs.push(input);
  }
  run.claim.ticket = packageInput(run, inputs);
  run.repository = inputs[0].repo;
  // Keep the original receipt fields for readers of single-Task runs.
  if (objects.length === 1) Object.assign(run.claim, run.claim.tasks[0]);
  persist();
  await guardTaskClaims(run, persist);
  return run.claim;
}

export async function guardTaskClaims(run, persist) {
  require(run.releaseConfirmed !== true, 'PACKAGE_CLAIMS_RELEASED: This run no longer holds its Tasks');
  require(!run.releaseRequest, 'PACKAGE_RELEASE_UNCONFIRMED: Inspect the saved release request before retrying');
  const reader = await occupancyReader(run.config, run.joppaWorker), claims = claimTasks(run), objects = [];
  const ownAddresses = new Set(claims.map(claim => claim.address));
  const context = await reader.group(claims[0].address);
  require(context, 'Claimed Task repository is not configured');
  for (const claim of claims) {
    const object = await reader.object(claim.address);
    require(object.process?.assignee === run.joppaWorker.actor && object.process.status === 'in_progress',
      'Task holder changed before lane startup; claims remain held for inspection');
    objects.push(object);
  }
  let conflict;
  await heldTasks(run.config, run.joppaWorker, async task => {
    const other = await reader.group(task.address);
    if (!other || other.requirement !== context.requirement || other.repository !== context.repository) return;
    const object = await reader.object(task.address), actor = object.process?.assignee;
    if (actor && (actor !== run.joppaWorker.actor || !ownAddresses.has(object.address)) && object.process.status === 'in_progress') {
      conflict ||= {address: object.address, actor, ...other};
    }
  });
  if (!conflict) return;
  run.claimConflict = conflict;
  run.releaseRequest = batchRequest(run, objects.map(object => ({op: 'release_task', id: object.address,
    revision: object.current_revision, reason: `Another actor holds ${conflict.address} in this Requirement and repository. Lane did not start.`})));
  persist();
  try { await mutateTasks(run, run.releaseRequest); }
  catch (error) { throw new Error(`PACKAGE_RELEASE_UNCONFIRMED: ${error.message}`); }
  run.releaseResults = [];
  for (const claim of claims) {
    const current = await api(run.config, run.joppaWorker, 'joppa_objects', {workspace: run.workspace, address: claim.address});
    require(current.address === claim.address && current.historical === false && current.document?.present === true &&
      Number.isSafeInteger(current.current_revision) && current.process?.status === 'open' &&
      current.process.assignee === null && !current.process.claim && !current.process.done && !current.process.retired,
      'PACKAGE_RELEASE_UNCONFIRMED: Joppa did not confirm every Task as current and unclaimed');
    run.releaseResults.push({address: claim.address, revision: current.current_revision, status: 'open'});
  }
  run.releaseConfirmed = true;
  persist();
  throw new Error(`PACKAGE_ALREADY_HELD: ${conflict.address} belongs to ${conflict.actor}; this run released its own Tasks before startup`);
}

export async function finishTask(run, stateFile, result, artifacts) {
  if (run.releaseConfirmed === true) return;
  require(!run.releaseRequest, 'PACKAGE_RELEASE_UNCONFIRMED: Tasks remain held for inspection');
  if (!run.claim) return;
  const persist = () => save(stateFile, run);
  const claims = claimTasks(run);
  const currentTasks = async (validate = false) => {
    const objects = [];
    for (const claim of claims) {
      const object = await api(run.config, run.joppaWorker, 'joppa_objects', {workspace: run.workspace, address: claim.address});
      require(object.address === claim.address, 'Joppa returned a different Task for completion');
      require(object.process?.assignee === run.joppaWorker.actor && object.process.status === 'in_progress',
        'Task holder changed; package outcome not written');
      if (validate) {
        require(object.work_ready === true && object.review_required === false && object.process?.review_required !== true,
          'TASK_REVIEW_REQUIRED: Task context needs review; landed package remains held');
        require(contractDigest(object) === claim.digest, 'Task contract changed during execution; package completion refused');
      }
      objects.push(object);
    }
    return objects;
  };
  const objects = await currentTasks(result.code === 0);
  if (result.code === 0) {
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
    for (const context of new Map(claims.filter(claim => claim.parent).map(claim => [claim.parent.address, claim.parent])).values()) {
      const parent = await api(run.config, run.joppaWorker, 'joppa_objects',
        {workspace: run.workspace, address: context.address});
      require(parent.address === context.address && parent.document?.present === true && parent.historical === false &&
        Number.isSafeInteger(parent.current_revision) && parent.current_revision > 0 && parent.work_ready === true &&
        parent.review_required === false && parent.process?.review_required !== true,
        'Task parent context needs review; completion refused');
      require(contractDigest(parent) === context.digest, 'Task parent context changed during execution; package completion refused');
    }
    for (const context of run.claim.contexts || []) {
      const parent = await api(run.config, run.joppaWorker, 'joppa_objects', {workspace: run.workspace, address: context.address});
      require(parent.address === context.address && parent.document?.present === true && parent.historical === false &&
        contractDigest(parent) === context.digest && parent.review_required === false && parent.process?.review_required !== true,
        'Package acceptance context changed during execution; completion refused');
    }
    const current = await currentTasks(true);
    run.completionRequest ||= batchRequest(run, current.map(object => ({
      op: 'complete_task', id: object.address, revision: object.current_revision,
      evidence: `${evidence.trim()}\nTask: ${object.address}\nPackage Tasks: ${claims.map(claim => claim.address).join(', ')}\nRequired gates and independent review passed. Run: ${path.basename(path.dirname(stateFile))}${findings ? '\nNonblocking findings:\n' + findings : ''}`})));
    persist();
    await mutateTasks(run, run.completionRequest);
    result.tasks = [];
    for (const claim of claims) {
      const confirmed = await api(run.config, run.joppaWorker, 'joppa_objects', {workspace: run.workspace, address: claim.address});
      require(confirmed.address === claim.address && confirmed.process?.status === 'done', 'Joppa did not confirm every Task completion');
      result.tasks.push({address: claim.address, status: 'done', revision: confirmed.current_revision});
    }
    result.completed = true;
  } else {
    const startup = fs.readFileSync(path.join(path.dirname(stateFile), 'output.log'), 'utf8').split('\n')
      .filter(line => /^(run\.sh:|\[sync\]).*(failed|refused|WORKTREE PREEXISTED|disconnected|unavailable|cannot)/i.test(line)).at(-1);
    const preexisting = result.code === 73 && startup?.includes('WORKTREE PREEXISTED:');
    const failureFile = artifacts && path.join(artifacts, 'failure.txt');
    const output = fs.readFileSync(path.join(path.dirname(stateFile), 'output.log'), 'utf8');
    const container = /^\[medulla\] (medulla-sess-[\w.-]+) never became ready\b/m.exec(output)?.[1];
    const checkout = run.config.worktreeRoot && run.executionId && path.join(run.config.worktreeRoot, run.executionId);
    const nativeEmpty = !fs.existsSync(run.runFolder) || fs.readdirSync(run.runFolder).every(name => name === 'launch-claim.json');
    const startupFailed = result.status === 'failed' && container && checkout && nativeEmpty && !fs.existsSync(checkout) &&
      objects.every((object, index) => contractDigest(object) === claims[index].digest) &&
      output.includes(`run.sh: removed unused worktree: ${checkout}`) &&
      !command('docker', ['ps', '-a', '--filter', `name=${container}`, '--format', '{{.Names}}']);
    if (!preexisting && !startupFailed && (!failureFile || !fs.existsSync(failureFile))) {
      await noteHeldTask(run, stateFile, startup || result.error || 'Lane startup failed');
      result.held = true;
      return;
    }
    result.blocked = true;
    const failure = preexisting ? startup : startupFailed ?
      'Session container never became ready. Container and unused checkout are absent. No native workflow ran.' :
      fs.readFileSync(failureFile, 'utf8');
    run.blockRequest ||= batchRequest(run, objects.map(object => ({
      op: 'block_task', id: object.address, revision: object.current_revision,
      reason: preexisting ? 'WORKTREE_PREEXISTED' : startupFailed ? 'STARTUP_FAILED' : reasonCode(completionEvent(run, result, artifacts)),
      evidence: `${failure || 'Lane failed'}\nTask: ${object.address}\nRun: ${path.basename(path.dirname(stateFile))}`})));
    persist();
    await mutateTasks(run, run.blockRequest);
    result.tasks = [];
    for (const [index, claim] of claims.entries()) {
      const requested = run.blockRequest.operations?.[index].command || run.blockRequest.command;
      const confirmed = await api(run.config, run.joppaWorker, 'joppa_objects', {workspace: run.workspace, address: claim.address});
      const blocked = confirmed.process?.blocked;
      require(confirmed.address === claim.address && confirmed.process?.status === 'open' &&
        confirmed.process.assignee === null && blocked?.actor === run.joppaWorker.actor &&
        blocked.reason === requested.reason && blocked.evidence === requested.evidence &&
        Number.isSafeInteger(blocked.position) && blocked.position > 0,
        'Joppa did not confirm every Task block; outcome requires inspection');
      result.tasks.push({address: claim.address, status: 'blocked', revision: confirmed.current_revision});
    }
    result.blockConfirmed = true;
  }
}

export async function noteHeldTask(run, stateFile, reason) {
  // Preserve the request ID if the server response is lost. Do not release or rerun the Task.
  run.failureRequest ||= batchRequest(run, claimTasks(run).map(claim => ({op: 'note', target: claim.address,
    id: randomUUID(), text: `${reason}\nRun: ${path.basename(path.dirname(stateFile))}\nOutcome not confirmed. Inspect evidence before retrying.`, reply_to: null})));
  save(stateFile, run);
  // Notes identify their targets through command.target; object identifies the note itself.
  await api(run.config, run.joppaWorker, run.failureRequest.operations ? 'joppa_batch' : 'joppa_command', run.failureRequest);
}
