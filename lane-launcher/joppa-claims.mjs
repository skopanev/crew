import os from 'node:os';
import {api, batchRequest, mutateTasks, runTasks, claimTasks, contractDigest, contextDigest, verifyRemoteDependencies} from './joppa-common.mjs';
import {nodeAssignee, nodeWaiting, nodeStageDone, saveNode} from './joppa-nodes.mjs';
import {packageInput, taskInput, testAcceptance} from './joppa-input.mjs';
import {packageBudget, estimatedNodes, coveredBy} from './test-bindings.mjs';
import {dependencyCheck} from './dependencies.mjs';
import {coversSpec, taskCovers, coveredProblem} from './joppa-covers.mjs';
import {criterionTests} from './test-nodes.mjs';
import {criterionSources} from './source-context.mjs';
const require = (condition, message) => { if (!condition) throw new Error(message); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A failure writes one release save with the hold code and one note for each Task in one batch.
const FAILURE_OPERATIONS = 2;

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

// Release saves remove only data.assignee at the read revision. Joppa must then show every Task unassigned.
export async function releaseTasks(run, persist, objects, reason, code) {
  if (objects.length) {
    run.releaseRequest = batchRequest(run, objects.map(object => saveNode(object, {assignee: undefined}, reason)));
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
    const selected = [];
    for (const task of tasks) {
      const object = await read(run, task.address);
      require(object?.address === task.address && current(object) &&
        (task.revision === undefined || object.current_revision === task.revision), 'Task changed after selection; no Tasks claimed');
      require(!nodeAssignee(object), `TASK_ASSIGNED: ${task.address} already has an assignee; no Tasks claimed`);
      require(!nodeWaiting(object), `TASK_WAITING: ${task.address} is waiting; no Tasks claimed`);
      require(!nodeStageDone(object), `TASK_COMPLETED: ${task.address} is done; no Tasks claimed`);
      selected.push(object);
    }
    const check = dependencyCheck((tool, args) => api(run.config, run.joppaWorker, tool, {workspace: run.workspace, ...args}));
    for (const task of tasks) {
      const dependency = await check(task.address);
      require(dependency.ready, `DEPENDENCY_NOT_READY: ${dependency.blocker}`);
    }
    // A covering Task also needs each covered criterion live, unheld and ready before any claim.
    const types = (await api(run.config, run.joppaWorker, 'joppa_tree', {workspace: run.workspace}))?.schema?.types;
    for (const object of selected) {
      const covered = taskCovers(coversSpec(run.config, types, kindOf(object)), object);
      const requirement = covered.length ? (await read(run, object.document.parent))?.document?.parent : undefined;
      for (const address of covered) {
        const problem = coveredProblem(await read(run, address), address, await check(address), requirement);
        require(!problem, `COVERED_CONTEXT_NOT_READY: ${problem}; no Tasks claimed`);
      }
    }
    // Each acceptance row must name the parent or a covered criterion and a Task check. Bound both outcome
    // batches before the claim. The gate receipt proves the report; Crew does not guess it from command text.
    const coversOf = coveredBy(run.config, types);
    for (const object of selected) testAcceptance(object, coversOf(object));
    packageBudget(selected.length, estimatedNodes(selected, coversOf));
    run.claimRequest = batchRequest(run, selected.map(object =>
      saveNode(object, {assignee}, 'Take this Task for a Crew lane run.')));
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
  const inputs = [], parents = new Map(), acceptanceTests = new Map(), sources = new Map();
  const schema = await api(run.config, run.joppaWorker, 'joppa_tree', {workspace: run.workspace});
  run.claim.contexts = [];
  const sourceContext = async (criterion, taskContexts) => {
    for (const {snapshot} of await criterionSources(run, schema.schema.types, criterion, sources)) {
      if (!taskContexts.some(item => item.address === snapshot.address)) taskContexts.push(snapshot);
      if (!run.claim.contexts.some(item => item.address === snapshot.address)) run.claim.contexts.push(snapshot);
    }
  };
  for (const [index, object] of objects.entries()) {
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
      const snapshot = {address: parent.address, revision: parent.current_revision, digest: contractDigest(parent),
        criterion: schema.schema.types[parent.kind]?.role === 'ac'};
      taskContexts.push(snapshot);
      if (!run.claim.contexts.some(item => item.address === address)) run.claim.contexts.push(snapshot);
      if (snapshot.criterion) await sourceContext(parent, taskContexts);
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
    const covered = taskCovers(coversSpec(run.config, schema.schema.types, kindOf(object)), object);
    const coveredContexts = [], fresh = covered.length && dependencyCheck((tool, args) =>
      api(run.config, run.joppaWorker, tool, {workspace: run.workspace, ...args}));
    for (const address of covered) {
      // Read again after the claim. A change since the pre-claim check releases this run's Tasks.
      const criterion = await read(run, address);
      const problem = coveredProblem(criterion, address, await fresh(address), parents.get(object.document.parent)?.document?.parent);
      if (problem) {
        await releaseTaskClaims(run, persist, `Covered criterion is not ready: ${problem}. Lane did not start.`);
        throw new Error(`COVERED_CONTEXT_NOT_READY: ${problem}; this run released its own Tasks before startup`);
      }
      const snapshot = {address, revision: criterion.current_revision, digest: contractDigest(criterion), criterion: true};
      taskContexts.push(snapshot);
      if (!run.claim.contexts.some(item => item.address === address)) run.claim.contexts.push(snapshot);
      coveredContexts.push({use: 'Covered acceptance reference. Execute only this Task contract.',
        address, item_id: criterion.item_id, revision: criterion.current_revision, data: criterion.document.data});
      await sourceContext(criterion, taskContexts);
    }
    if (covered.length) run.claim.tasks[index].covers = covered;
    const input = taskInput(run.config, object, taskContexts, covered);
    if (coveredContexts.length) input.ticket.coveredContexts = coveredContexts;
    if (parentContext) input.ticket.parentContext = parentContext;
    // The coder sees how its criterion is tested. These are references, not bindings: Crew binds
    // only the rows of data.acceptance_checks. Tasks of one criterion share one read and one snapshot.
    const ac = object.document.parent;
    if (schema.schema.types[parents.get(ac)?.kind]?.role === 'ac') {
      if (!acceptanceTests.has(ac)) acceptanceTests.set(ac, await criterionTests((tool, args) =>
        api(run.config, run.joppaWorker, tool, {workspace: run.workspace, ...args}), schema.schema.types, ac));
      input.ticket.acceptanceTests = acceptanceTests.get(ac);
    }
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
  if (sources.size) run.claim.ticket.sources = [...sources.values()].map(item => item.input);
  // The lane refuses more distinct (AC, test) node saves than the completion batch can hold.
  run.claim.ticket = {...run.claim.ticket, bindingNodeLimit: packageBudget(objects.length, 0)};
  persist();
  await guardTaskClaims(run, persist);
  return run.claim;
}

export async function guardTaskClaims(run, persist) {
  require(run.releaseConfirmed !== true, 'PACKAGE_CLAIMS_RELEASED: This run no longer holds its Tasks');
  require(!run.releaseRequest, 'PACKAGE_RELEASE_UNCONFIRMED: Inspect the saved release request before retrying');
  const claims = claimTasks(run);
  const dependencies = dependencyCheck((tool, args) =>
    api(run.config, run.joppaWorker, tool, {workspace: run.workspace, ...args}));
  for (const claim of claims) {
    const object = await read(run, claim.address);
    require(object?.address === claim.address && heldBy(run, object),
      'Task holder changed before lane startup; claims remain held for inspection');
    verifyRemoteDependencies(object);
    const dependency = await dependencies(claim.address);
    require(dependency.ready, `DEPENDENCY_NOT_READY: ${dependency.blocker}`);
    require(contractDigest(object) === claim.digest, 'Task contract changed before lane startup');
  }
  for (const context of run.claim.contexts || []) {
    const object = await read(run, context.address);
    verifyRemoteDependencies(object);
    const dependency = await dependencies(context.address);
    require(object?.address === context.address && contextLive(object) &&
      dependency.ready &&
      contextDigest(object, context) === context.digest,
      `Acceptance context changed before lane startup: ${context.address}`);
  }
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
