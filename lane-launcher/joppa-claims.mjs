import os from 'node:os';
import {api, batchRequest, mutateTasks, runTasks, claimTasks, contractDigest, verifyRemoteDependencies} from './joppa-common.mjs';
import {nodeAssignee, nodeWaiting, saveNode} from './joppa-nodes.mjs';
import {occupancyReader, heldTasks} from './joppa-selection.mjs';
import {packageInput, taskInput} from './joppa-input.mjs';
import {dependencyCheck} from './dependencies.mjs';
const require = (condition, message) => { if (!condition) throw new Error(message); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A failure writes a release save, an assessment and a note for each Task in one batch.
const FAILURE_OPERATIONS = 3;

export const laneAssignee = runId => {
  require(uuid.test(runId || ''), 'Task claim needs the launch UUID');
  return `crew-lane:${os.hostname()}:${runId}`;
};
const current = object => object?.historical === false && object.document?.present === true &&
  Number.isSafeInteger(object.current_revision) && object.current_revision > 0;
// The run holds a Task only through its own run-specific assignee. A waiting Task is not held.
export const heldBy = (run, object) => current(object) && typeof run.claim?.assignee === 'string' &&
  nodeAssignee(object) === run.claim.assignee && !nodeWaiting(object);
export const released = object => current(object) && !nodeAssignee(object) && !nodeWaiting(object);
// Acceptance context is live when it is current, not waiting and not held by a planner.
export const contextLive = object => current(object) && !nodeWaiting(object) && !nodeAssignee(object);
const kindOf = object => object.address.slice(0, object.address.indexOf(':'));
const read = (run, address) => api(run.config, run.joppaWorker, 'joppa_objects', {workspace: run.workspace, address});

export async function taskQuestions(run) {
  const types = (await api(run.config, run.joppaWorker, 'joppa_tree', {workspace: run.workspace}))?.schema?.types;
  require(types && typeof types === 'object', 'Joppa tree schema is missing');
  // Generic saves must answer the type question with its exact text.
  return object => {
    const question = types[kindOf(object)]?.question;
    require(typeof question === 'string' && question.trim(), `Joppa type ${kindOf(object)} needs a schema question`);
    return question;
  };
}

// Release saves remove only data.assignee at the read revision. Joppa must then show every Task unassigned.
export async function releaseTasks(run, persist, objects, reason, code) {
  if (objects.length) {
    const question = await taskQuestions(run);
    run.releaseRequest = batchRequest(run, objects.map(object => saveNode(object, {assignee: undefined}, reason, question(object))));
    persist();
    try { await mutateTasks(run, run.releaseRequest); }
    catch (error) { throw new Error(`${code}: ${error.message}`); }
  }
  run.releaseResults = [];
  for (const claim of claimTasks(run)) {
    const object = await read(run, claim.address);
    require(object?.address === claim.address && released(object),
      `${code}: Joppa did not confirm every Task as current and unassigned`);
    run.releaseResults.push({address: claim.address, revision: object.current_revision, status: 'open'});
  }
  run.releaseConfirmed = true;
  persist();
}

export async function claimTask(run, persist, runId) {
  const tasks = runTasks(run);
  require(tasks.length > 0 && tasks.length * FAILURE_OPERATIONS <= 100,
    'Repository package exceeds the Joppa 100-operation atomic batch limit; no Tasks claimed');
  require(new Set(tasks.map(task => task.address)).size === tasks.length, 'Repository package contains duplicate Tasks');
  const assignee = laneAssignee(runId);
  if (!run.claimRequest) {
    const question = await taskQuestions(run), selected = [];
    for (const task of tasks) {
      const object = await read(run, task.address);
      require(object?.address === task.address && current(object) &&
        (task.revision === undefined || object.current_revision === task.revision), 'Task changed after selection; no Tasks claimed');
      require(!nodeAssignee(object), `TASK_ASSIGNED: ${task.address} already has an assignee; no Tasks claimed`);
      require(!nodeWaiting(object), `TASK_WAITING: ${task.address} is waiting; no Tasks claimed`);
      selected.push(object);
    }
    // Own Task state refuses first. Dependency traversal also stops at a waiting Task.
    const check = dependencyCheck((tool, args) => api(run.config, run.joppaWorker, tool, {workspace: run.workspace, ...args}));
    for (const task of tasks) {
      const dependency = await check(task.address);
      require(dependency.ready, `DEPENDENCY_NOT_READY: ${dependency.blocker}`);
    }
    run.claimRequest = batchRequest(run, selected.map(object =>
      saveNode(object, {assignee}, 'Take this Task for a Crew lane run.', question(object))));
  }
  persist();
  try { await mutateTasks(run, run.claimRequest); }
  catch (error) { if (error.rejected) { run.claimRejected = true; persist(); } throw error; }
  const objects = [];
  for (const task of tasks) {
    const object = await read(run, task.address);
    require(object.address === task.address, 'Joppa returned a different Task after claim');
    require(heldBy({claim: {assignee}}, object), 'Joppa did not confirm this run as Task assignee');
    objects.push(object);
  }
  run.claim = {claimed: true, id: run.executionId, workspace: run.workspace, status: 'in_progress', source: 'joppa',
    address: run.task, actor: run.joppaWorker.actor, assignee, runId, tasks: objects.map(object => ({address: object.address,
      revision: object.current_revision, digest: contractDigest(object)}))};
  persist();
  const inputs = [], parents = new Map();
  const schema = await api(run.config, run.joppaWorker, 'joppa_tree', {workspace: run.workspace});
  run.claim.contexts = [];
  for (const [index, object] of objects.entries()) {
    require(object.work_ready === true, 'Claimed Task needs dependency or contract review before execution');
    let address = object.document.parent, requirement, parentContext, requirementContext;
    const seen = new Set(), taskContexts = [];
    while (address) {
      require(!seen.has(address), 'Task parent context contains a cycle');
      seen.add(address);
      if (!parents.has(address)) parents.set(address, await read(run, address));
      const parent = parents.get(address);
      require(parent.address === address && contextLive(parent),
        'Task parent context is absent, historical, waiting or held for planning');
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
  const reader = await occupancyReader(run.config, run.joppaWorker), claims = claimTasks(run);
  const ownAddresses = new Set(claims.map(claim => claim.address));
  const context = await reader.group(claims[0].address);
  require(context, 'Claimed Task repository is not configured');
  for (const claim of claims) {
    const object = await reader.object(claim.address);
    require(heldBy(run, object), 'Task holder changed before lane startup; claims remain held for inspection');
    verifyRemoteDependencies(object);
    require(contractDigest(object) === claim.digest, 'Task contract changed before lane startup');
  }
  for (const context of run.claim.contexts || []) {
    const object = await reader.object(context.address);
    verifyRemoteDependencies(object);
    require(contextLive(object) && contractDigest(object) === context.digest, 'Acceptance context changed before lane startup');
  }
  let conflict;
  await heldTasks(run.config, run.joppaWorker, async task => {
    const other = await reader.group(task.address);
    if (!other || other.requirement !== context.requirement || other.repository !== context.repository) return;
    const object = await reader.object(task.address), actor = nodeAssignee(object);
    if (actor && (actor !== run.claim.assignee || !ownAddresses.has(object.address))) {
      conflict ||= {address: object.address, actor, ...other};
    }
  });
  if (!conflict) return;
  run.claimConflict = conflict;
  await releaseTaskClaims(run, persist,
    `Another assignee holds ${conflict.address} in this Requirement and repository. Lane did not start.`);
  throw new Error(`PACKAGE_ALREADY_HELD: ${conflict.address} belongs to ${conflict.actor}; this run released its own Tasks before startup`);
}

export async function releaseTaskClaims(run, persist, reason) {
  const objects = [];
  for (const claim of claimTasks(run)) {
    const object = await read(run, claim.address);
    require(object.address === claim.address && heldBy(run, object) && contractDigest(object) === claim.digest,
      'PACKAGE_RELEASE_UNCONFIRMED: Task holder or contract changed');
    objects.push(object);
  }
  await releaseTasks(run, persist, objects, reason, 'PACKAGE_RELEASE_UNCONFIRMED');
}
