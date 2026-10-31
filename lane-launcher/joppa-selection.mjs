import fs from 'node:fs';
import path from 'node:path';
import {api, claimTasks, runTasks, hasRecoveryCheckpoint} from './joppa-common.mjs';
import {alive, readRun, runDirectories} from './runtime.mjs';
import {dependencyCheck} from './dependencies.mjs';
import {taskContract, taskBody} from './task-contract.mjs';
import {taskInput} from './joppa-input.mjs';
import {publicationReader, repositoryGit} from './publication-guard.mjs';
import {requirementBranch, requirementPlan, assertRequirementHead} from './requirement-delivery.mjs';
import {finalizationCandidate} from './requirement-finalizer.mjs';
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

export async function occupancyReader(config, worker) {
  const check = (condition, message) => {
    if (!condition) throw Object.assign(new Error(message), {code: 'CANDIDATE_INVALID'});
  };
  const schema = await api(config, worker, 'joppa_tree', {workspace: config.workspace}), objects = new Map();
  const object = async address => {
    if (!objects.has(address)) objects.set(address, api(config, worker, 'joppa_objects', {workspace: config.workspace, address}));
    const current = await objects.get(address);
    check(current?.address === address && current.document?.present === true && current.historical === false,
      'Task ownership context is absent or historical');
    return current;
  };
  const group = async address => {
    const current = await object(address);
    const contract = taskBody(current.document.data) ? taskContract(current.document.data) : '';
    const declarations = typeof contract === 'string' ? [...contract.matchAll(/^Repository:[ \t]*(\S[^\r\n]*)$/gm)] : [];
    const configured = declarations.filter(match => config.repositories.some(repo => repo.id === match[1].trim()));
    if (!configured.length) return null;
    check(declarations.length === 1, 'Held Task repository declaration is ambiguous');
    const repository = configured[0][1].trim(), seen = new Set();
    let parent = current.document.parent;
    while (parent) {
      check(!seen.has(parent), 'Task parent context contains a cycle');
      seen.add(parent);
      const context = await object(parent);
      if (schema.schema.types[context.kind]?.role === 'requirement') return {requirement: context.address, repository};
      parent = context.document.parent;
    }
    throw Object.assign(new Error('Task needs a requirement ancestor'), {code: 'CANDIDATE_INVALID'});
  };
  return {object, group};
}

export async function heldTasks(config, worker, visit, inventory) {
  let cursor;
  do {
    const page = await api(config, worker, 'joppa_tasks', {workspace: config.workspace,
      view: 'all', limit: 100, ...(cursor ? {cursor} : {})});
    for (const task of page.tasks) {
      inventory?.push(task);
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
    if (!config.joppa.mcpCommand) {
      if (busy.has(worker.actor)) continue;
      const mine = await api(config, worker, 'joppa_tasks', {workspace: config.workspace, view: 'mine', limit: 1});
      if (mine.total) { held++; continue; }
    }
    const dependencies = dependencyCheck((tool, args) => api(config, worker, tool, {workspace: config.workspace, ...args}));
    const publications = publicationReader(config, (tool, args) => api(config, worker, tool, {workspace: config.workspace, ...args}));
    const eligible = [], {object, group} = await occupancyReader(config, worker);
    const occupied = new Set(), inventory = [];
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
    }, inventory);
    let cursor;
    do {
      const page = await api(config, worker, 'joppa_tasks', {workspace: config.workspace, project: config.joppa.project,
        view: 'available', limit: 100, ...(cursor ? {cursor} : {}),
        ...(config.joppa.priorities ? {priorities: config.joppa.priorities} : {})});
      for (const task of page.tasks) {
        try {
          if (!(await dependencies(task.address)).ready) continue;
          const current = await object(task.address);
          if (!text(task.address) || !Number.isSafeInteger(task.revision) ||
              current.current_revision !== task.revision) continue;
          try { taskInput(config, current); }
          catch (error) { error.code = 'CANDIDATE_INVALID'; throw error; }
          const context = await group(task.address);
          if (!context || occupied.has(`${context.requirement}\n${context.repository}`)) continue;
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
      cursor = page.next_cursor;
    } while (cursor);
    available = Math.max(available, eligible.length);
    if (config.delivery === 'requirement') {
      const candidate = await finalizationCandidate({config, worker,
        read: (tool, args) => api(config, worker, tool, {workspace: config.workspace, ...args}),
        object, group, rows: inventory, occupied, runs});
      if (candidate) return {candidate, worker, available: available + 1, held};
    }
    while (eligible.length) {
      const first = eligible[0];
      const task = eligible.filter(item => item.requirement === first.requirement && item.repository === first.repository)
        .sort((a, b) => taskOrder(a) - taskOrder(b) || a.address.localeCompare(b.address))[0];
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
        tasks, requirement: task.requirement, repository: task.repository}, worker, available, held};
    }
  }
  return {candidate: null, available, held};
}

const taskOrder = task => Number(/^\[(\d+)\]\s/.exec(task.title || '')?.[1] || Number.MAX_SAFE_INTEGER);
