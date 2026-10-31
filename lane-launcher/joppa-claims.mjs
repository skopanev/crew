import {api, batchRequest, mutateTasks, runTasks, claimTasks, contractDigest, verifyRemoteDependencies} from './joppa-common.mjs';
import {occupancyReader, heldTasks} from './joppa-selection.mjs';
import {packageInput, taskInput} from './joppa-input.mjs';
import {dependencyCheck} from './dependencies.mjs';
const require = (condition, message) => { if (!condition) throw new Error(message); };
const text = value => typeof value === 'string' && value.trim();

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
    let address = object.document.parent, requirement, parentContext, requirementContext;
    const seen = new Set(), taskContexts = [];
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
        address: parent.address, item_id: parent.item_id, revision: parent.current_revision, data: parent.document.data,
        ...(parent.remote_links?.length ? {remote_links: parent.remote_links} : {})};
      const snapshot = {address: parent.address, revision: parent.current_revision, digest: contractDigest(parent)};
      taskContexts.push(snapshot);
      if (!run.claim.contexts.some(item => item.address === address)) run.claim.contexts.push(snapshot);
      if (address === object.document.parent) {
        parentContext = context;
        run.claim.tasks[index].parent = snapshot;
      }
      if (schema.schema.types[parent.kind]?.role === 'requirement') {
        requirement = address;
        requirementContext = context;
        break;
      }
      address = parent.document.parent;
    }
    const input = taskInput(run.config, object, taskContexts);
    if (parentContext) input.ticket.parentContext = parentContext;
    if (requirementContext) input.ticket.requirementContext = requirementContext;
    require(!inputs.length || inputs[0].repo.id === input.repo.id, 'Claimed Tasks belong to different repositories');
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
    verifyRemoteDependencies(object);
    require(contractDigest(object) === claim.digest, 'Task contract changed before lane startup');
    objects.push(object);
  }
  for (const context of run.claim.contexts || []) {
    const object = await reader.object(context.address);
    verifyRemoteDependencies(object);
    require(contractDigest(object) === context.digest, 'Acceptance context changed before lane startup');
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
  await releaseTaskClaims(run, persist,
    `Another actor holds ${conflict.address} in this Requirement and repository. Lane did not start.`);
  throw new Error(`PACKAGE_ALREADY_HELD: ${conflict.address} belongs to ${conflict.actor}; this run released its own Tasks before startup`);
}

export async function releaseTaskClaims(run, persist, reason) {
  const claims = claimTasks(run), objects = [];
  for (const claim of claims) {
    const object = await api(run.config, run.joppaWorker, 'joppa_objects', {workspace: run.workspace, address: claim.address});
    require(object.address === claim.address && object.process?.status === 'in_progress' &&
      object.process.assignee === run.joppaWorker.actor && contractDigest(object) === claim.digest,
      'PACKAGE_RELEASE_UNCONFIRMED: Task holder or contract changed');
    objects.push(object);
  }
  run.releaseRequest = batchRequest(run, objects.map(object => ({op: 'release_task', id: object.address,
    revision: object.current_revision, reason})));
  persist();
  try { await mutateTasks(run, run.releaseRequest); }
  catch (error) { throw new Error(`PACKAGE_RELEASE_UNCONFIRMED: ${error.message}`); }
  run.releaseResults = [];
  for (const claim of claims) {
    const current = await api(run.config, run.joppaWorker, 'joppa_objects', {workspace: run.workspace, address: claim.address});
    require(current.address === claim.address && current.historical === false && current.document?.present === true &&
      Number.isSafeInteger(current.current_revision) && current.process?.status === 'open' &&
      current.process.assignee === null && !current.process.claim && !current.process.blocked && !current.process.done && !current.process.retired,
      'PACKAGE_RELEASE_UNCONFIRMED: Joppa did not confirm every Task as current and unclaimed');
    run.releaseResults.push({address: claim.address, revision: current.current_revision, status: 'open'});
  }
  run.releaseConfirmed = true;
  persist();
}
