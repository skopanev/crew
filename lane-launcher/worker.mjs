#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {save, read, herdr, laneArgs} from './runtime.mjs';
import {laneRunFolder} from './scope.mjs';
import {api, claimTask, guardTaskClaims, releaseTaskClaims} from './joppa.mjs';
import {requirementPlan, assertRequirementHead} from './requirement-delivery.mjs';
import {publicationReader, repositoryGit} from './publication-guard.mjs';
import {formatLaneLine} from './lane-log.mjs';
import {notifyCompletion} from '../notify.mjs';
import {failureDetails, finishFinalization, recordTaskOutcome, checkRequirementHead} from './worker-outcome.mjs';

const stateFile = path.resolve(process.argv[2]);
const dir = path.dirname(stateFile);
// The worker owns this state after dispatch. The launcher must not change it while the worker lives.
const lock = path.join(dir, 'worker.lock');
try { fs.mkdirSync(lock); }
catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.error('Joppa worker lock exists. Inspect the current run before retrying.');
  process.exit(2);
}
process.once('exit', () => fs.rmdirSync(lock));
let run = read(stateFile);
if (run.worker || run.claimRequest || run.result) {
  console.error('Joppa run already started. Inspect its claim and publication before retrying.');
  process.exit(2);
}
const log = fs.openSync(path.join(dir, 'output.log'), 'a', 0o600);
const color = process.env.NO_COLOR === undefined && process.env.FORCE_COLOR !== '0' &&
  (process.stdout.isTTY || process.env.FORCE_COLOR === '1');
function announce(message) {
  fs.writeSync(log, message + '\n');
  process.stdout.write(formatLaneLine(message, color) + '\n');
}
run.worker = {pid: process.pid, startedAt: new Date().toISOString()};
save(stateFile, run);
const script = fileURLToPath(new URL('../lane/run.sh', import.meta.url));
let child, signal;
const stop = value => {
  signal = value;
  if (child?.pid) {
    try { process.kill(-child.pid, value); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
};
process.on('SIGTERM', () => stop('SIGTERM'));
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGHUP', () => stop('SIGTERM'));
let result, claimRefused = false;
let artifacts = null;
let readerDir;
let finalizationTicket;
try {
  announce(`[lane] START ${run.ticket || '(ticket)'} · pane ${run.pane}`);
  announce(`[lane] logs: ${path.join(dir, 'output.log')}`);
  if (signal) throw new Error(`Startup interrupted by ${signal}`);
  if (run.finalizeOnly) {
    if (run.config.delivery !== 'requirement') throw new Error('Finalization requires requirement delivery');
    run.repository = run.config.repositories.find(repo => repo.id === run.repositoryId);
    if (!run.repository) throw new Error('Finalization repository is not configured');
    finalizationTicket = {id: run.executionId, source: 'joppa', address: run.requirement,
      repository: run.repository.id, module: '.', title: `Finalize ${run.requirement}`};
    announce(`[lane] FINALIZE ${run.requirement} · no Task claim`);
  } else {
    announce(`[lane] CLAIM ${run.ticket}`);
    const adoptedJoppaClaim = Boolean(run.claim);
    const claimed = run.claim || await claimTask(run, () => save(stateFile, run));
    if (claimed?.claimed !== true || claimed.status !== 'in_progress' ||
        String(claimed.id).toLowerCase() !== String(run.executionId || run.ticket).toLowerCase()) {
      delete run.claim;
      claimRefused = true;
      throw new Error(`Joppa did not confirm claim for ${run.ticket}`);
    }
    run.claim = {...claimed, workspace: run.workspace};
    save(stateFile, run);
    if (adoptedJoppaClaim) await guardTaskClaims(run, () => save(stateFile, run));
    announce(`[lane] CLAIMED ${run.ticket} · in_progress`);
  }
  const readJoppa = (tool, args) => api(run.config, run.joppaWorker, tool, {workspace: run.workspace, ...args});
  if (run.config.delivery === 'requirement') {
    run.requirementDelivery = await requirementPlan(run, readJoppa);
    if (run.requirementDelivery.planningHeld) {
      if (!run.finalizeOnly) await releaseTaskClaims(run, () => save(stateFile, run), 'Requirement planning is active; lane did not start.');
      throw new Error('REQUIREMENT_PLANNING_ACTIVE: wait for the planner to release the Requirement');
    }
    if (run.finalizeOnly && !run.requirementDelivery.final) throw new Error('REQUIREMENT_CHANGED: unfinished work remains');
    run.deliveryBranch = run.requirementDelivery.branch;
    run.requirementDelivery.head = (await repositoryGit(run.config, run.repository,
      ['ls-remote', 'origin', `refs/heads/${run.deliveryBranch}`])).split(/\s/)[0] || '';
    try { assertRequirementHead(run.requirementDelivery, run.requirementDelivery.head); }
    catch (error) {
      if (!run.finalizeOnly) await releaseTaskClaims(run, () => save(stateFile, run), error.message + '; lane did not start.');
      throw error;
    }
    if (run.finalizeOnly) {
      if (!run.requirementDelivery.head) throw new Error('REQUIREMENT_CHANGED: requirement branch is absent');
      run.requirementDelivery.targetHead = (await repositoryGit(run.config, run.repository,
        ['ls-remote', 'origin', `refs/heads/${run.repository.targetBranch}`])).split(/\s/)[0];
    }
    save(stateFile, run);
  }
  try {
    if (!run.finalizeOnly) {
      const dependencies = await publicationReader(run.config, readJoppa)(run);
      if (dependencies.needsReader && !run.config.joppa.mcpCommand && !run.config.joppa.readerTokenFile) {
        throw new Error('Remote dependency rechecks need joppa.mcpCommand or joppa.readerTokenFile before lane startup');
      }
    }
  } catch (error) {
    if (error.code === 'DEPENDENCY_NOT_LANDED') {
      await releaseTaskClaims(run, () => save(stateFile, run), error.message + '; lane did not start.');
    }
    throw error;
  }
  run.args = laneArgs({...run.config, gateCommands: run.repository.gateCommands, testCommand: run.repository.testCommand,
    reviewCommands: run.repository.reviewCommands ?? run.config.reviewCommands,
    coderTimeoutSeconds: run.repository.coderTimeoutSeconds ?? run.config.coderTimeoutSeconds,
    gateTimeoutSeconds: run.repository.gateTimeoutSeconds ?? run.config.gateTimeoutSeconds}, run.executionId);
  save(stateFile, run);
  if (signal) throw new Error(`Startup interrupted by ${signal}`);
  run.runFolder = laneRunFolder(run.runFolder, run.config.id);
  save(stateFile, run);
  fs.mkdirSync(run.runFolder, {recursive: true});
  const claimFile = path.join(fs.realpathSync(run.runFolder), 'launch-claim.json');
  const delivery = run.requirementDelivery && {plan: run.requirementDelivery,
    input: {requirement: run.requirement, repository: run.repository.id, tasks: run.tasks, finalizeOnly: run.finalizeOnly === true,
      task: run.task, config: {repositories: run.config.repositories.map(repo => ({id: repo.id})),
        joppa: {url: run.config.joppa.url}}, workspace: run.workspace}};
  const claim = run.finalizeOnly ? {id: run.executionId, workspace: run.workspace,
    source: 'joppa-finalization', anchor: run.task, ticket: finalizationTicket} : run.claim;
  fs.writeFileSync(claimFile, JSON.stringify({...claim, joppa_url: run.config.joppa.url,
    ...(delivery ? {delivery} : {})}) + '\n', {mode: 0o600});
  if (run.config.joppa.readerTokenFile) {
    readerDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'crew-joppa-reader-')));
    fs.copyFileSync(run.config.joppa.readerTokenFile, path.join(readerDir, 'token'));
    fs.chmodSync(path.join(readerDir, 'token'), 0o600);
  }
  // Dedicated process group lets a stopped worker stop all of its shell children.
  child = spawn('bash', [script, ...run.args], {cwd: path.dirname(path.dirname(script)),
    env: {...process.env, LANE_RUNS_FOLDER: run.runFolder,
      LANE_SOURCE: 'joppa', LANE_REPOSITORY_JSON: JSON.stringify(run.repository),
      LANE_REPOSITORIES_JSON: JSON.stringify(run.config.repositories), LANE_WORKTREE_ROOT: run.config.worktreeRoot,
      LANE_DELIVERY: run.config.delivery, LANE_DELIVERY_BRANCH: run.deliveryBranch || '',
      LANE_REQUIREMENT_BRANCH: run.requirementDelivery?.branch || '',
      LANE_REQUIREMENT_HEAD: run.requirementDelivery?.head || '',
      LANE_REQUIREMENT_FINAL: String(run.requirementDelivery?.final ?? false),
      LANE_REQUIREMENT_READER_DIR: readerDir || '',
      ...(run.config.joppa.mcpCommand ? {LANE_JOPPA_MCP_COMMAND_JSON: JSON.stringify(run.config.joppa.mcpCommand)} : {}),
      LANE_FINALIZE_ONLY: String(run.finalizeOnly === true),
      EQUILL_STORE: run.config.equillStore || process.env.EQUILL_STORE || '',
      LANE_CLAIM_FILE: claimFile}, detached: true,
    stdio: ['ignore', 'pipe', 'pipe']});
  run.launchPgid = child.pid;
  save(stateFile, run);
  for (const [stream, target] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    // Keep original bytes on disk; presentation colors apply only to the tab.
    stream.on('data', data => fs.writeSync(log, data));
    if (color || stream === child.stderr) {
      createInterface({input: stream, crlfDelay: Infinity}).on('line', line => {
        if (color) target.write(formatLaneLine(line, true) + '\n');
      });
    }
    if (!color) stream.on('data', data => target.write(data));
  }
  const outcome = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, receivedSignal) => resolve({code, signal: receivedSignal || signal}));
  });
  result = {...outcome, status: outcome.code === 0 ? 'exited' : 'failed'};
  const postLand = fs.readFileSync(path.join(dir, 'output.log'), 'utf8')
    .match(/^run\.sh: POST_LAND_FAILED: ([^\r\n]+)/m);
  if (postLand) result.postLandWarning = postLand[1];
  if (result.status === 'failed') result.error = `Lane exited ${result.code ?? result.signal}; full output: ${path.join(dir, 'output.log')}`;
} catch (error) {
  const message = run.claim || signal || run.finalizeOnly ? error.message :
    claimRefused || error.rejected ? `CLAIM_REFUSED: ${error.message}` :
      `CLAIM_UNCERTAIN: ${error.message}; check ${run.ticket} in Joppa before retrying`;
  result = {status: 'failed', code: 2,
    error: message};
  process.exitCode = 2;
} finally {
  if (readerDir) fs.rmSync(readerDir, {recursive: true, force: true});
  announce(`[lane] ${result.status === 'exited' ? 'EXIT' : 'FAILED'} · code ${result.code ?? '?'}${result.signal ? ` · ${result.signal}` : ''}${result.error ? ` · ${result.error}` : ''}`);
  if (result.status !== 'exited') {
    artifacts = failureDetails(run, announce);
  }
  if (run.finalizeOnly) {
    artifacts = await finishFinalization({run, dir, stateFile, result, artifacts, announce});
  } else if (run.releaseRequest) {
    result.released = run.releaseConfirmed === true;
    result.held = !result.released;
    result.blocked = false;
    if (result.released) result.tasks = run.releaseResults;
    announce(`[lane] ${result.released ? 'RELEASED' : 'HELD'} ${run.task} · ${run.claimConflict ? 'package ownership conflict' : 'startup failed'}; lane did not start`);
  } else {
    ({result, artifacts} = await recordTaskOutcome({run, stateFile, result, artifacts, announce}));
  }
  if (!run.finalizeOnly && !result.completed && result.status === 'failed' &&
      run.requirementDelivery?.final === false && typeof run.requirementDelivery.head === 'string') {
    await checkRequirementHead({run, stateFile, result, announce});
  }
  // Record completion first: closing this pane can terminate this process immediately.
  run.result = {...result, finishedAt: new Date().toISOString()};
  process.exitCode = result.code || (result.status === 'exited' ? 0 : 2);
  save(stateFile, run);
  try {
    if (await notifyCompletion(run, result, artifacts)) {
      announce('[lane] Notification sent to channel');
    }
  } catch (error) {
    // Notification delivery does not change the ticket outcome or occupy a lane slot.
    save(path.join(dir, 'notification-error.json'), {error: error.message});
    announce(`[lane] Notification failed: ${error.message}`);
  }
  fs.closeSync(log);
  if (run.config.closeTabOnExit === true) {
    try { herdr(run.config, ['pane', 'close', run.pane]); }
    catch (error) { console.error(`Lane ended; cannot close ${run.pane}: ${error.message}`); }
  } else {
    console.log(`[lane] Finished. Tab kept open; logs: ${path.join(dir, 'output.log')}`);
  }
}
