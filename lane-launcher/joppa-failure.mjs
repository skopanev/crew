import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {save} from './runtime.mjs';
import {api, batchRequest, mutateTasks, claimTasks} from './joppa-common.mjs';
import {writerGone, checkoutPath, recordRetained, retainedLine} from './retained-checkout.mjs';
import {nodeAssignee, nodeStage, saveNode} from './joppa-nodes.mjs';
import {completionEvent, reasonCode} from '../notify.mjs';
const require = (condition, message) => { if (!condition) throw new Error(message); };
const text = value => typeof value === 'string' && value.trim();
const excerpt = value => Buffer.from(value, 'utf8').subarray(0, 1500).toString('utf8').replace(/\uFFFD$/, '');

export async function failTask(run, stateFile, result, artifacts, {claims, objects, owned, persist}) {
  const output = fs.readFileSync(path.join(path.dirname(stateFile), 'output.log'), 'utf8');
  const startup = output.split(/\r?\n/)
    .filter(line => /^(run\.sh:|\[sync\]|(?:CBM|MCP) (?:bridge|preflight):|Crew roles?\b).*(failed|refused|refusing|WORKTREE PREEXISTED|disconnected|unavailable|cannot|timed out|not ready|did not complete|differs from)/i.test(line)).at(-1);
  const preexisting = result.code === 73 && startup?.includes('WORKTREE PREEXISTED:');
  const failureFile = artifacts && path.join(artifacts, 'failure.txt');
  const recoveryFailure = output.match(/^RECOVERY_VERIFY_FAILED: [^\r\n]+/m)?.[0];
  if (recoveryFailure) {
    result.held = true;
    result.blocked = false;
    throw new Error(recoveryFailure);
  }
  require(!result.cleanupError && (!run.launchPgid || writerGone(run, checkoutPath(run))),
    'A lane process or container can still write; failure outcome requires inspection');
  require(objects.every(owned), 'Task holder changed; package outcome not written');
  result.blocked = true;
  let failure = preexisting ? startup : failureFile && fs.existsSync(failureFile)
    ? fs.readFileSync(failureFile, 'utf8') : startup || result.error || 'Lane failed before a failure report was written.';
  if (!preexisting && artifacts && run.config.discardFailedWorktree === true) {
    const panel = path.join(artifacts, 'panel-findings.txt');
    const review = fs.existsSync(panel) && fs.lstatSync(panel).isFile() &&
      fs.realpathSync(panel).startsWith(fs.realpathSync(run.runFolder) + path.sep) ? fs.readFileSync(panel, 'utf8') : '';
    const lastRound = review.split(/^---[ \t]*\r?$/m).filter(part => part.trim()).at(-1) || '';
    failure = excerpt(failure) + `\nFull failure: ${failureFile}` +
      '\nFailed checkout cleanup is configured after Joppa confirms this outcome.' +
      (lastRound ? `\nReview findings (last round excerpt):\n${excerpt(lastRound)}\nFull review: ${panel}` : '');
  }
  const runId = path.basename(path.dirname(stateFile));
  const code = preexisting ? 'WORKTREE_PREEXISTED' : reasonCode(completionEvent(run, result, artifacts));
  // Record a clean retained checkout once its writer is gone. A later claim of this Task may reuse it.
  if (!preexisting && claims.length === 1 && !run.blockRequest && run.retained === undefined) {
    run.retained = recordRetained(run, artifacts);
    persist();
  }
  const stage = run.config.FAILED_TASK_STAGE;
  require(text(stage) && stage === stage.trim(), 'FAILED_TASK_STAGE is required before a failed Task can be released');
  // One batch per package: a revision-checked stage save releases the Task, then the note records the reason.
  run.blockRequest ||= batchRequest(run, objects.flatMap(object => [
    saveNode(object, {assignee: undefined, stage}, `Crew lane failed: ${code}.`),
    {op: 'note', target: object.address, id: randomUUID(), reply_to: null,
      text: `CREW_FAILURE\nTask: ${object.address}\nRun: ${runId}\nReason: ${code}\n${run.retained ? retainedLine(run.retained) + '\n' : ''}${(failure || 'Lane failed').trim()}`}]));
  require(claims.every(claim => {
    const commands = run.blockRequest.operations.map(row => row.command);
    const command = commands.find(cmd => cmd.op === 'save_object' && `${cmd.kind}:${cmd.id}` === claim.address);
    return command?.data?.stage === stage && command.data.assignee === null &&
      Object.keys(command.data).every(key => ['assignee', 'stage'].includes(key));
  }), 'Saved failure request does not match FAILED_TASK_STAGE; inspect its receipt');
  persist();
  await mutateTasks(run, run.blockRequest);
  result.tasks = [];
  for (const claim of claims) {
    const requested = op => run.blockRequest.operations.find(({command}) => command.op === op &&
      (command.target ?? `${command.kind}:${command.id}`) === claim.address)?.command;
    const expectedStage = requested('save_object')?.data?.stage, note = requested('note');
    const confirmed = await api(run.config, run.joppaWorker, 'joppa_objects', {workspace: run.workspace, address: claim.address});
    const comment = confirmed.annotations?.comments?.[note?.id];
    require(confirmed.address === claim.address && confirmed.historical === false && confirmed.document?.present === true &&
      !nodeAssignee(confirmed) && expectedStage === stage && nodeStage(confirmed) === stage &&
      comment && comment.withdrawn !== true && comment.actor === run.joppaWorker.actor && comment.text === note.text,
      'Joppa did not confirm every Task block; outcome requires inspection');
    result.tasks.push({address: claim.address, status: 'blocked', revision: confirmed.current_revision});
  }
  result.blockConfirmed = true;
}

export async function noteHeldTask(run, stateFile, reason) {
  // Preserve the request ID if the server response is lost. Do not release or rerun the Task.
  run.failureRequest ||= batchRequest(run, claimTasks(run).map(claim => ({op: 'note', target: claim.address,
    id: randomUUID(), text: `${reason}\nRun: ${path.basename(path.dirname(stateFile))}\nOutcome not confirmed. Inspect evidence before retrying.`, reply_to: null})));
  save(stateFile, run);
  // Notes identify their targets through command.target; object identifies the note itself.
  await api(run.config, run.joppaWorker, run.failureRequest.operations ? 'joppa_batch' : 'joppa_command', run.failureRequest);
}
