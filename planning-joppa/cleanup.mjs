#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {executionId} from '../lane-launcher/joppa.mjs';
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
  const prepared = [];
  for (const task of blocked) {
    require(!task.process.assignee && !task.process.claim && task.process.status !== 'in_progress', 'Blocked Task has a holder');
    const id = task.address.slice(task.address.indexOf(':') + 1);
    require(operations.some(({command: cmd}) => cmd.id === id &&
      (cmd.op === 'retire_task' || cmd.op === 'save_object' && cmd.kind === task.kind)),
    'Every blocked Task needs a contract update or retirement before cleanup');
    const execution = executionId(task.address), folder = path.join(root, execution), entry = stat(folder);
    if (!entry) continue;
    require(runs !== folder && !runs.startsWith(folder + path.sep), 'Cleanup cannot contain lane receipts');
    require(entry.isDirectory() && !entry.isSymbolicLink() && fs.realpathSync(folder) === folder,
      'Blocked worktree must be a real directory without symlinks');
    const runId = /^Run:\s*([^\s]+)\s*$/m.exec(task.process.blocked.evidence || '')?.[1];
    require(runId && uuid.test(runId), 'Blocked worktree has no terminal lane Run ID');
    require(stat(runs)?.isDirectory() && fs.realpathSync(runs) === runs, 'Lane runs folder must be a real directory');
    const evidence = path.join(runs, runId, 'launch.json');
    require(stat(evidence)?.isFile() && fs.realpathSync(evidence) === evidence, 'Lane block receipt is absent or symlinked');
    const matches = [];
    for (const name of fs.readdirSync(runs)) {
      if (!uuid.test(name)) continue;
      const file = path.join(runs, name, 'launch.json');
      if (!stat(file)) continue;
      require(fs.realpathSync(file) === file, 'Lane receipt must not use symlinks');
      const run = readRun(file);
      if (run.task !== task.address && run.executionId !== execution) continue;
      require(run.task === task.address && run.executionId === execution && run.workspace === config.workspace &&
        run.config?.joppa?.url === config.url && typeof run.config.worktreeRoot === 'string' &&
        path.resolve(run.config.worktreeRoot) === root,
      'Lane receipt belongs to another Task or configuration');
      require(run.result && Number.isInteger(run.result.code) && run.result.finishedAt &&
        !run.result.held && !run.result.completed && run.result.code !== 0,
      'Active, held or unconfirmed successful lane prevents worktree cleanup');
      matches.push(name);
    }
    require(matches.includes(runId), 'Block receipt does not confirm a finished lane for this Task');
    prepared.push({task: task.address, folder});
  }
  // Validate every target before deleting any checkout. Publication follows cleanup.
  for (const item of prepared) {
    if (!dryRun) fs.rmSync(item.folder, {recursive: true});
    console.log(`planning: ${dryRun ? 'would discard' : 'discarded'} blocked worktree for ${item.task}`);
  }
  return prepared;
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
