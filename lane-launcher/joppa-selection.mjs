import path from 'node:path';
import {api, claimTasks, runTasks, hasRecoveryCheckpoint} from './joppa-common.mjs';
import {readDetails} from './joppa-api.mjs';
import {alive, readRun, runDirectories} from './runtime.mjs';
import {dependencyCheck} from './dependencies.mjs';
import {repositoryDeclarations} from './task-contract.mjs';
import {taskInput} from './joppa-input.mjs';
import {coveredBy} from './test-bindings.mjs';
import {publicationReader, repositoryGit} from './publication-guard.mjs';
import {requirementBranch, requirementPlan, assertRequirementHead} from './requirement-delivery.mjs';
import {finalizationCandidate} from './requirement-finalizer.mjs';
import {nodeAssignee, nodeWaiting, nodeStageDone, taskPages, coversFields} from './joppa-nodes.mjs';
const require = (condition, message) => { if (!condition) throw new Error(message); };
const text = value => typeof value === 'string' && value.trim();

export function runHoldsTasks(run) {
  if (run.finalizeOnly) return !run.result && (!run.worker || alive(run.worker.pid));
  if (run.releaseConfirmed === true) return false;
  if (!run.result || run.result.held || run.claimRequest && !run.claim && !run.claimRejected) return true;
  if (run.claim && !run.result.completed && !run.result.blockConfirmed) return true;
  return Boolean(run.completionRequest && !run.result.completed || run.blockRequest && !run.result.blockConfirmed ||
    run.releaseRequest && !run.releaseConfirmed || run.recoveryNoteRequest && !run.releaseConfirmed ||
    hasRecoveryCheckpoint(run.recovery) && !run.releaseConfirmed ||
    run.result.blocked && !run.result.blockConfirmed || /JOPPA_OUTCOME_UNCONFIRMED/.test(run.result.error || ''));
}

// One selection pass of one worker shares object and schema reads. Other tools and later passes read again.
export function passReader(config, worker) {
  const reads = new Map();
  const detailKey = address => JSON.stringify(['joppa_objects', {workspace: config.workspace, address}]);
  const read = (tool, args) => {
    const effective = {workspace: config.workspace, ...args};
    if (tool !== 'joppa_objects' && tool !== 'joppa_tree') return api(config, worker, tool, effective);
    const key = JSON.stringify([tool, effective]);
    if (!reads.has(key)) reads.set(key, api(config, worker, tool, effective));
    return reads.get(key);
  };
  // Seed detail reads in calls of up to 25 addresses. An address without an exact result stays a single read.
  read.prefetch = async addresses => {
    const wanted = [...new Set(addresses.filter(text))].filter(address => !reads.has(detailKey(address)));
    const found = new Map();
    for (let index = 0; index < wanted.length; index += 25) {
      const part = await readDetails(config.joppa.url, worker.tokenFile, {workspace: config.workspace},
        wanted.slice(index, index + 25), {mcpCommand: config.joppa.mcpCommand});
      for (const [address, value] of part) {
        reads.set(detailKey(address), Promise.resolve(value));
        found.set(address, value);
      }
    }
    return [...found.values()];
  };
  return read;
}

export async function occupancyReader(config, read) {
  const check = (condition, message) => {
    if (!condition) throw Object.assign(new Error(message), {code: 'CANDIDATE_INVALID'});
  };
  const schema = await read('joppa_tree', {});
  const object = async (address, {allowArchived = false} = {}) => {
    const current = await read('joppa_objects', {address});
    check(current?.address === address && (allowArchived || current.document?.present === true) && current.historical === false,
      'Task ownership context is absent or historical');
    return current;
  };
  const group = async (address, allowArchived = false) => {
    const current = await object(address, {allowArchived: true});
    if (!allowArchived && current.document.present !== true) return null;
    const declarations = repositoryDeclarations(current.document.data);
    const configured = declarations.filter(id => config.repositories.some(repo => repo.id === id));
    if (!configured.length) return null;
    check(declarations.length === 1, 'Task repository declaration is ambiguous');
    const repository = configured[0], seen = new Set();
    let parent = current.document.parent;
    while (parent) {
      check(!seen.has(parent), 'Task parent context contains a cycle');
      seen.add(parent);
      const context = await object(parent, {allowArchived: true});
      if (context.document.present !== true) return null;
      if (schema.schema.types[context.kind]?.role === 'requirement') return {requirement: context.address, repository};
      parent = context.document.parent;
    }
    return null;
  };
  return {object, group};
}

export async function heldTasks(config, read, visit, inventory) {
  for await (const page of taskPages(read, {}, coversFields(config))) {
    for (const task of page.items) {
      inventory?.push(task);
      if (!nodeAssignee(task)) continue;
      await visit(task);
    }
  }
  if (inventory && config.delivery === 'requirement') {
    for await (const page of taskPages(read, {status: 'purple'}, coversFields(config))) inventory.push(...page.items);
  }
}

export async function nextTask(config) {
  const runs = runDirectories(config.stateDir).flatMap(dir => {
    try { return [readRun(path.join(dir, 'launch.json'))]; }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  });
  const reservations = runs.filter(runHoldsTasks);
  const reserved = new Set(reservations.flatMap(run =>
    run.finalizeOnly ? [{address: run.task}] : run.claim ? claimTasks(run) : runTasks(run)).map(task => task.address));
  const finalizing = new Set(reservations.filter(run => run.finalizeOnly).map(run =>
    `${run.requirement}\n${run.repositoryId || run.repository?.id || run.claim?.ticket?.repository}`));
  const dependencyIssues = new Map();
  let available = 0, held = 0;
  for (const worker of config.joppa.workers) {
    const read = passReader(config, worker);
    const dependencies = dependencyCheck(read);
    const publications = publicationReader(config, read);
    const eligible = [], {object, group} = await occupancyReader(config, read);
    const inventory = [], assigned = [];
    await heldTasks(config, read, async task => { assigned.push(task); }, inventory);
    const priorities = config.joppa.priorities;
    if (priorities !== undefined) require(Array.isArray(priorities) && priorities.length && priorities.every(text),
      'joppa.priorities must contain priority values');
    const open = task => task.present === true && !reserved.has(task.address) && !nodeStageDone(task) &&
      !nodeAssignee(task) && !nodeWaiting(task) && !(priorities && !priorities.includes(task['data.priority']));
    // Batch the Task details, then their immediate parents and local dependencies. Deeper reads stay single.
    const tasks = await read.prefetch([...assigned, ...inventory.filter(open)].map(task => task.address));
    await read.prefetch(tasks.flatMap(value => [value.document.parent, ...(value.document.links || [])
      .filter(link => link.relation === 'depends_on' && link.blocking === true && link.workspace === undefined)
      .map(link => link.target)]));
    let workerHeld = 0;
    for (const task of assigned) {
      const current = await object(task.address, {allowArchived: true});
      if (current.document.present && repositoryDeclarations(current.document.data)
        .some(id => config.repositories.some(repo => repo.id === id))) workerHeld++;
    }
    held = Math.max(held, workerHeld);
    let coversOf;
    for (const task of inventory) {
      if (!open(task)) continue;
        try {
          const context = await group(task.address);
          if (!context) continue;
          const dependency = await dependencies(task.address);
          if (!dependency.ready) {
            if (dependency.code) dependencyIssues.set(`${task.address}\n${dependency.consumer}\n${dependency.blocker}`,
              {task: task.address, ...dependency});
            continue;
          }
          const current = await object(task.address);
          if (!text(task.address) || !Number.isSafeInteger(task.revision) ||
              current.current_revision !== task.revision) continue;
          // A shared Task may name its configured covered criteria in data.acceptance_checks.
          coversOf ||= coveredBy(config, (await read('joppa_tree', {})).schema.types);
          try { taskInput(config, current, undefined, coversOf(current)); }
          catch (error) { error.code = 'CANDIDATE_INVALID'; throw error; }
          await publications({config, tasks: [{address: task.address}], requirement: context.requirement,
            repository: config.repositories.find(repo => repo.id === context.repository),
            requirementDelivery: {branch: requirementBranch(context.requirement, context.repository)}});
          eligible.push({...task, ...context});
        } catch (error) {
          if (error.code === 'DEPENDENCY_NOT_LANDED') continue;
          if (['DEPENDENCY_INVALID', 'CANDIDATE_INVALID'].includes(error.code)) {
            console.error(`${task.address}: ${error.message}; skipping this Task`);
            continue;
          }
          throw error;
        }
    }
    const priorityOrder = priorities || (await read('joppa_tree', {})).schema.priorities || [];
    const rank = task => {
      const index = priorityOrder.indexOf(task['data.priority']);
      return index < 0 ? Number.MAX_SAFE_INTEGER : index;
    };
    eligible.sort((a, b) => rank(a) - rank(b) || a.address.localeCompare(b.address));
    available = Math.max(available, eligible.length);
    if (config.delivery === 'requirement') {
      const candidate = await finalizationCandidate({config, worker,
        read: (tool, args) => api(config, worker, tool, {workspace: config.workspace, ...args}),
        object, group, rows: inventory, occupied: finalizing, runs});
      if (candidate) return {candidate, worker, available: available + 1, held, dependencyIssues: [...dependencyIssues.values()]};
    }
    while (eligible.length) {
      const first = eligible[0];
      const task = eligible.filter(item => item.requirement === first.requirement && item.repository === first.repository)
        .sort((a, b) => rank(a) - rank(b) || taskOrder(a) - taskOrder(b) || a.address.localeCompare(b.address))[0];
      const tasks = [{address: task.address, revision: task.revision, title: task.title}];
      if (config.delivery === 'requirement') {
        let paused = true;
        try {
          const plan = await requirementPlan({config, requirement: task.requirement, repository: task.repository, tasks},
            (tool, args) => api(config, worker, tool, {workspace: config.workspace, ...args}));
          paused = plan.planningHeld;
          if (!paused) assertRequirementHead(plan, (await repositoryGit(config, config.repositories.find(repo => repo.id === task.repository),
            ['ls-remote', 'origin', `refs/heads/${plan.branch}`])).split(/\s/)[0] || '');
        } catch (error) {
          if (!['CANDIDATE_INVALID', 'REQUIREMENT_HEAD_UNCONFIRMED'].includes(error.code)) throw error;
          paused = true;
          console.error(`${task.address}: ${error.message}; skipping this Requirement unit`);
        }
        if (paused) {
          for (let index = eligible.length - 1; index >= 0; index--) {
            if (eligible[index].requirement === task.requirement && eligible[index].repository === task.repository) eligible.splice(index, 1);
          }
          available = eligible.length;
          continue;
        }
      }
      return {candidate: {id: task.address, title: task.title, revision: task.revision,
        tasks, requirement: task.requirement, repository: task.repository}, worker, available, held,
        dependencyIssues: [...dependencyIssues.values()]};
    }
  }
  return {candidate: null, available, held, dependencyIssues: [...dependencyIssues.values()]};
}

const taskOrder = task => Number(/^\[(\d+)\]\s/.exec(task.title || '')?.[1] || Number.MAX_SAFE_INTEGER);
