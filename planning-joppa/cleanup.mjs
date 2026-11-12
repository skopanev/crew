#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {executionId, runHoldsTasks} from '../lane-launcher/joppa.mjs';
import {readRun} from '../lane-launcher/runtime.mjs';
import {nodeAssignee, nodeHold, nodeWaiting} from '../lane-launcher/joppa-nodes.mjs';
import {isDeepStrictEqual} from 'node:util';

const require = (condition, message) => { if (!condition) throw new Error(message); };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const stat = file => {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

// Return the lane runs folders from lane_runs_folder or lane_runs_folders. context.py uses the same rule.
export function laneRunsFolders(config) {
  const single = config.lane_runs_folder != null, many = config.lane_runs_folders != null;
  require(!(single && many), 'Set config.lane_runs_folder or config.lane_runs_folders, not both');
  if (!many) return single ? [config.lane_runs_folder] : [];
  const folders = config.lane_runs_folders;
  require(Array.isArray(folders) && folders.length && new Set(folders).size === folders.length &&
    folders.every(folder => typeof folder === 'string' && path.isAbsolute(folder)),
  'config.lane_runs_folders must be a nonempty list of distinct absolute paths');
  return folders;
}

export function cleanupBlockedTasks({config, tasks, operations}, {dryRun = false} = {}) {
  const blocked = tasks.filter(task => task.document?.present === true && nodeWaiting(task));
  if (!blocked.length) return [];
  const configured = laneRunsFolders(config);
  require(config.worktree_root && configured.length, 'Blocked retries need config.worktree_root and lane runs folders');
  require([config.worktree_root, ...configured].every(item => typeof item === 'string' && path.isAbsolute(item)),
    'Cleanup paths must be absolute');
  const root = path.resolve(config.worktree_root), folders = configured.map(item => path.resolve(item));
  require(Array.isArray(config.repositories) && config.repositories.length && config.repositories.every(repo =>
    typeof repo.path === 'string' && path.resolve(repo.path) !== root && !path.resolve(repo.path).startsWith(root + path.sep)),
  'Worktree root cannot contain a canonical repository');
  const rootStat = stat(root);
  require(!rootStat || rootStat.isDirectory() && !rootStat.isSymbolicLink() && fs.realpathSync(root) === root,
    'Worktree root must be a real directory without symlinks');
  const prepared = new Map(), receipts = new Map();
  // Read every folder before any deletion. One Run ID must identify one receipt.
  for (const runs of folders) {
    if (!stat(runs)) continue;
    require(stat(runs).isDirectory() && fs.realpathSync(runs) === runs, 'Lane runs folder must be a real directory');
    for (const name of fs.readdirSync(runs)) {
      if (!uuid.test(name)) continue;
      const file = path.join(runs, name, 'launch.json');
      if (!stat(file)) continue;
      require(stat(file).isFile() && fs.realpathSync(file) === file, 'Lane receipt must not use symlinks');
      require(!receipts.has(name), `Lane Run ID ${name} occurs in more than one runs folder`);
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
    return operations.find(({command: cmd}) => cmd.op === 'archive_object' && cmd.target === task.address ||
      cmd.op === 'save_object' && cmd.id === id && cmd.kind === task.kind);
  };
  const validateTask = task => {
    require(!nodeAssignee(task), 'Blocked Task has a holder');
    const operation = operationFor(task);
    require(operation, 'Every blocked Task needs an unblock, contract update or retirement before cleanup');
    const cmd = operation.command;
    require(cmd.revision === task.current_revision, 'Cleanup operation uses a different Task revision');
    // A partial save that only clears the hold retries the unchanged contract.
    const retry = cmd.op === 'save_object' && isDeepStrictEqual(cmd.data, {hold: null}) &&
      cmd.relations === undefined && cmd.parent === undefined;
    if (cmd.op === 'save_object') {
      require(!cmd.data.assignee, 'Cleanup cannot assign a Task');
      require(cmd.data.hold === null, 'Task contract save must clear its hold');
    }
    require(!retry || nodeHold(task) === 'WORKTREE_PREEXISTED',
      'Only worktree startup failures can use unchanged contract cleanup');
    return {operation, retry};
  };
  const failureReceipt = task => {
    const comments = Object.entries(task.annotations?.comments || {});
    for (const [id, note] of comments.reverse()) {
      if (note.withdrawn || !note.text?.startsWith('CREW_FAILURE\n')) continue;
      const field = name => new RegExp(`^${name}: ([^\\r\\n]+)$`, 'm').exec(note.text)?.[1];
      if (field('Task') !== task.address || field('Reason') !== nodeHold(task)) continue;
      const runId = field('Run'), receipt = receipts.get(runId);
      if (!uuid.test(runId || '') || !receipt) continue;
      const requested = receipt.blockRequest?.operations?.find(({command}) =>
        command.op === 'note' && command.target === task.address && command.id === id)?.command;
      require(note.actor === receipt.joppaWorker?.actor && requested?.text === note.text &&
        receipt.result?.blockConfirmed === true, 'Failure note does not match a confirmed lane block');
      return {runId, receipt};
    }
    return {};
  };
  for (const task of blocked) {
    const {retry} = validateTask(task);
    const {runId, receipt} = failureReceipt(task);
    const related = [...receipts.values()].filter(run => members(run).includes(task.address));
    if (!receipt && !related.length && !stat(path.join(root, executionId(task.address))) && !retry) continue;
    require(runId && uuid.test(runId) && receipt, 'Blocked worktree has no terminal lane Run ID or receipt');
    require(members(receipt).includes(task.address), 'Block receipt does not include this Task');
    const execution = receipt.executionId;
    require(typeof execution === 'string' && /^joppa-[0-9a-f]{32}$/.test(execution), 'Lane receipt has an invalid checkout ID');
    const folder = path.join(root, execution), entry = stat(folder);
    require(folders.every(runs => runs !== folder && !runs.startsWith(folder + path.sep)),
      'Cleanup cannot contain lane receipts');
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
      const overlaps = members(run).some(address => group.includes(address));
      if (run.executionId !== execution && !samePackage && !overlaps) continue;
      require((samePackage || overlaps) && run.workspace === config.workspace &&
        run.config?.joppa?.url === config.url && typeof run.config.worktreeRoot === 'string' &&
        path.resolve(run.config.worktreeRoot) === root,
      'Lane receipt belongs to another package or configuration');
      require(run.result && Number.isInteger(run.result.code) && run.result.finishedAt && !runHoldsTasks(run),
      'Active, held or unconfirmed successful lane prevents worktree cleanup');
      if (run.result.completed || run.result.code === 0) {
        require(run.result.completed === true && run.result.code === 0,
          'Unconfirmed successful lane prevents worktree cleanup');
        require(!overlaps, 'A successful receipt overlaps the blocked Tasks; inspect Task history before cleanup');
        const finished = Date.parse(run.result.finishedAt), started = Date.parse(receipt.createdAt);
        require(Number.isFinite(finished) && Number.isFinite(started) && finished <= started,
          'Successful package ownership is not historical; inspect lane receipts before cleanup');
        continue;
      }
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
