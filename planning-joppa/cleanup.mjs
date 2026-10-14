#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {executionId, runHoldsTasks} from '../lane-launcher/joppa.mjs';
import {readRun} from '../lane-launcher/runtime.mjs';

const require = (condition, message) => { if (!condition) throw new Error(message); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const stat = file => {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

export function cleanupBlockedTasks({config, tasks, operations}, {dryRun = false} = {}) {
  const blocked = tasks.filter(task => task.process?.blocked && !task.process.done && !task.process.retired);
  if (!blocked.length) return [];
  require(config.worktree_root && config.lane_runs_folder, 'Blocked retries need config.worktree_root and config.lane_runs_folder');
  const root = path.resolve(config.worktree_root), runs = path.resolve(config.lane_runs_folder);
  require(path.isAbsolute(config.worktree_root) && path.isAbsolute(config.lane_runs_folder), 'Cleanup paths must be absolute');
  require(Array.isArray(config.repositories) && config.repositories.length && config.repositories.every(repo =>
    typeof repo.path === 'string' && path.resolve(repo.path) !== root && !path.resolve(repo.path).startsWith(root + path.sep)),
  'Worktree root cannot contain a canonical repository');
  const rootStat = stat(root);
  require(!rootStat || rootStat.isDirectory() && !rootStat.isSymbolicLink() && fs.realpathSync(root) === root,
    'Worktree root must be a real directory without symlinks');
  const prepared = new Map(), receipts = new Map();
  if (stat(runs)) {
    require(stat(runs).isDirectory() && fs.realpathSync(runs) === runs, 'Lane runs folder must be a real directory');
    for (const name of fs.readdirSync(runs)) {
      if (!uuid.test(name)) continue;
      const file = path.join(runs, name, 'launch.json');
      if (!stat(file)) continue;
      require(stat(file).isFile() && fs.realpathSync(file) === file, 'Lane receipt must not use symlinks');
      receipts.set(name, readRun(file));
    }
  }
  const members = run => [...new Set([run.task, ...(run.tasks || []).map(task => task.address),
    ...(run.claim?.tasks || []).map(task => task.address)].filter(Boolean))];
  const packageKey = run => {
    const repo = run.repositoryId || run.repository?.id || run.claim?.ticket?.repository;
    return run.requirement && repo ? `${run.requirement}\n${repo}` : null;
  };
  const operationFor = task => {
    const id = task.address.slice(task.address.indexOf(':') + 1);
    return operations.find(({command: cmd}) => (cmd.id === id || cmd.id === task.address) &&
      (cmd.op === 'unblock_task' || cmd.op === 'retire_task' || cmd.op === 'save_object' && cmd.kind === task.kind));
  };
  const validateTask = task => {
    require(!task.process.assignee && !task.process.claim && task.process.status !== 'in_progress', 'Blocked Task has a holder');
    const operation = operationFor(task);
    require(operation, 'Every blocked Task needs an unblock, contract update or retirement before cleanup');
    require(operation.command.op !== 'unblock_task' || task.process.blocked.reason === 'WORKTREE_PREEXISTED',
      'Only worktree startup failures can use unblock cleanup');
    return operation;
  };
  for (const task of blocked) {
    const operation = validateTask(task);
    const retry = operation.command.op === 'unblock_task';
    const runId = /^Run:\s*([^\s]+)\s*$/m.exec(task.process.blocked.evidence || '')?.[1];
    const receipt = receipts.get(runId);
    const related = [...receipts.values()].filter(run => members(run).includes(task.address));
    if (!receipt && !related.length && !stat(path.join(root, executionId(task.address))) && !retry) continue;
    require(runId && uuid.test(runId) && receipt, 'Blocked worktree has no terminal lane Run ID or receipt');
    require(members(receipt).includes(task.address), 'Block receipt does not include this Task');
    const execution = receipt.executionId;
    require(typeof execution === 'string' && /^joppa-[0-9a-f]{32}$/.test(execution), 'Lane receipt has an invalid checkout ID');
    const folder = path.join(root, execution), entry = stat(folder);
    require(runs !== folder && !runs.startsWith(folder + path.sep), 'Cleanup cannot contain lane receipts');
    require(!entry || entry.isDirectory() && !entry.isSymbolicLink() && fs.realpathSync(folder) === folder,
      'Blocked worktree must be a real directory without symlinks');
    if (!entry && !retry) continue;
    const group = members(receipt);
    for (const address of group) {
      const current = blocked.find(item => item.address === address);
      require(current, 'Grouped checkout cleanup needs every blocked Task; replan the whole Requirement');
      validateTask(current);
    }
    const matches = [];
    for (const [name, run] of receipts) {
      const samePackage = packageKey(receipt) && packageKey(run) === packageKey(receipt);
      if (run.executionId !== execution && !samePackage && !members(run).some(address => group.includes(address))) continue;
      require((samePackage || members(run).some(address => group.includes(address))) && run.workspace === config.workspace &&
        run.config?.joppa?.url === config.url && typeof run.config.worktreeRoot === 'string' &&
        path.resolve(run.config.worktreeRoot) === root,
      'Lane receipt belongs to another package or configuration');
      require(run.result && Number.isInteger(run.result.code) && run.result.finishedAt &&
        !runHoldsTasks(run) && !run.result.completed && run.result.code !== 0,
      'Active, held or unconfirmed successful lane prevents worktree cleanup');
      matches.push(name);
      if (name === runId && retry) require(run.result.code === 73, 'Startup retry requires the worktree failure exit code');
    }
    require(matches.includes(runId), 'Block receipt does not confirm a finished lane for this Task');
    if (entry) prepared.set(folder, {task: group.join(', '), folder});
  }
  // Validate every target before deleting any checkout. Publication follows cleanup.
  for (const item of prepared.values()) {
    if (!dryRun) fs.rmSync(item.folder, {recursive: true});
    console.log(`planning: ${dryRun ? 'would discard' : 'discarded'} blocked worktree for ${item.task}`);
  }
  return [...prepared.values()];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    require(process.argv.length === 2 || process.argv.length === 3 && process.argv[2] === '--dry-run',
      'Usage: cleanup.mjs [--dry-run] < cleanup input JSON');
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    cleanupBlockedTasks(JSON.parse(input), {dryRun: process.argv[2] === '--dry-run'});
  } catch (error) {
    console.error(`Planning cleanup: ${error.message}`);
    process.exitCode = 2;
  }
}
