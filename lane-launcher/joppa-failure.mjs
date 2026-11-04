import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {command, save} from './runtime.mjs';
import {api, batchRequest, mutateTasks, claimTasks, contractDigest} from './joppa-common.mjs';
import {recoverTimeout} from './joppa-recovery.mjs';
import {releaseTasks, taskQuestions} from './joppa-claims.mjs';
import {nodeAssignee, nodeWaiting, saveNode} from './joppa-nodes.mjs';
import {completionEvent, reasonCode} from '../notify.mjs';
const require = (condition, message) => { if (!condition) throw new Error(message); };
const text = value => typeof value === 'string' && value.trim();

function isImplementTimeout(artifacts) {
  if (!artifacts) return false;
  const originFile = path.join(artifacts, 'origin.json');
  const journalFile = path.join(path.dirname(artifacts), 'journal.jsonl');
  if (!fs.existsSync(originFile) || !fs.existsSync(journalFile)) return false;
  try {
    const origin = JSON.parse(fs.readFileSync(originFile, 'utf8'));
    if (origin?.node !== 'implement_code' || origin.signal !== '__timeout__') return false;
    const journal = fs.readFileSync(journalFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    if (!journal.length || journal.some(row => ['git_landing', 'cleanup', 'notify_success'].includes(row.node))) return false;
    const last = journal.filter(row => row.node !== 'notify_failure').at(-1);
    return Boolean(last && last.node === 'implement_code' && last.signal === '__timeout__' &&
      last.timed_out === true && (!last.next || last.next === 'notify_failure'));
  } catch {
    return false;
  }
}

function isPrepareFailure(artifacts) {
  if (!artifacts) return false;
  try {
    const origin = JSON.parse(fs.readFileSync(path.join(artifacts, 'origin.json'), 'utf8'));
    const journal = fs.readFileSync(path.join(path.dirname(artifacts), 'journal.jsonl'), 'utf8')
      .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const preparation = journal.filter(row => row.node === 'prepare');
    return origin.node === 'prepare' && ['__failed__', '__timeout__', '__default__'].includes(origin.signal) &&
      journal.every(row => ['prepare', 'notify_failure'].includes(row.node)) && preparation.length === 1 &&
      journal[0].node === 'prepare' && preparation[0].signal === origin.signal;
  } catch { return false; }
}

export async function failTask(run, stateFile, result, artifacts, {claims, objects, currentTasks, verifySavedContexts, owned, unclaimed, persist}) {
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
  const absent = file => {
    try { fs.lstatSync(file); return false; }
    catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  };
  const container = /^\[medulla\] (medulla-sess-[\w.-]+) never became ready\b/m.exec(output)?.[1];
  const checkout = run.config.worktreeRoot && run.executionId && path.join(run.config.worktreeRoot, run.executionId);
  const checkoutAbsent = Boolean(checkout) && absent(checkout) &&
    (absent(run.config.worktreeRoot) || !fs.lstatSync(run.config.worktreeRoot).isSymbolicLink());
  const nativeEmpty = !fs.existsSync(run.runFolder) || fs.readdirSync(run.runFolder).every(name => name === 'launch-claim.json');
  const contractsUnchanged = objects.every((object, index) => contractDigest(object) === claims[index].digest);
  const runFolders = new Set([run.runFolder, ...(run.runFolder && fs.existsSync(run.runFolder) ? [fs.realpathSync(run.runFolder)] : [])].filter(Boolean));
  const containerFailed = Boolean(container) &&
    output.includes(`run.sh: removed unused worktree: ${checkout}`) &&
    !command('docker', ['ps', '-a', '--filter', `name=${container}`, '--format', '{{.Names}}']);
  const launchGroupGone = () => {
    if (!Number.isSafeInteger(run.launchPgid) || run.launchPgid <= 1) return false;
    try { process.kill(-run.launchPgid, 0); return false; }
    catch (error) { return error.code === 'ESRCH'; }
  };
  const startingContainers = [...output.matchAll(/^\[medulla\] session container (medulla-sess-[\w.-]+) starting\r?$/gm)]
    .map(match => match[1]);
  const preMedullaFailed = !preexisting &&
    (Boolean(startup) || output.includes(`run.sh: removed unused worktree: ${checkout}`)) &&
    output.split(/\r?\n/).filter(line => line.startsWith('[medulla] '))
      .every(line => /^\[medulla\] session container medulla-sess-[\w.-]+ starting$/.test(line)) &&
    !output.includes('run.sh: retained ') && !output.includes('run.sh: cannot remove ') &&
    launchGroupGone() &&
    runFolders.size > 0 &&
    startingContainers.every(name => !command('docker', ['ps', '-a', '--filter', `name=^/${name}$`, '--format', '{{.Names}}'])) &&
    [...runFolders].every(folder => !command('docker', ['ps', '-a', '--filter', `label=medulla.runs_under=${folder}`, '--format', '{{.Names}}']));
  const startupFailed = result.status === 'failed' && !artifacts && checkoutAbsent && nativeEmpty &&
    contractsUnchanged && (containerFailed || preMedullaFailed);
  const prepareFailed = result.status === 'failed' && checkoutAbsent && contractsUnchanged &&
    output.includes(`run.sh: removed unused worktree: ${checkout}`) && isPrepareFailure(artifacts);
  if (startupFailed || prepareFailed) {
    const releasing = objects.every(unclaimed) ? [] : objects;
    require(!releasing.length || objects.every(owned), 'PACKAGE_RELEASE_UNCONFIRMED: Task ownership differs within the package');
    await releaseTasks(run, persist, releasing, prepareFailed
      ? 'Lane preparation failed before agent work. Unused checkout removed; see the run failure evidence.'
      : containerFailed
        ? 'Session container never became ready. No native workflow ran; unused checkout removed.'
        : 'Lane startup failed before workflow launch. No native workflow ran; unused checkout absent.',
    'STARTUP_RELEASE_UNCONFIRMED');
    result.released = true;
    result.held = false;
    result.blocked = false;
    result.tasks = run.releaseResults;
    persist();
    return;
  }
  require(objects.every(owned), 'Task holder changed; package outcome not written');
  if (!preexisting && claims.length === 1 && isImplementTimeout(artifacts)) {
    await recoverTimeout(run, stateFile, result, artifacts,
      {claims, currentTasks, verifySavedContexts, checkout, output, persist});
    return;
  }
  if (!preexisting && (!failureFile || !fs.existsSync(failureFile))) {
    await noteHeldTask(run, stateFile, startup || result.error || 'Lane startup failed');
    result.held = true;
    return;
  }
  result.blocked = true;
  const failure = preexisting ? startup : fs.readFileSync(failureFile, 'utf8');
  const runId = path.basename(path.dirname(stateFile)), question = await taskQuestions(run);
  const code = preexisting ? 'WORKTREE_PREEXISTED' : reasonCode(completionEvent(run, result, artifacts));
  // One batch per package: release save (the assess fence), waiting assessment, and the failure note.
  run.blockRequest ||= batchRequest(run, objects.flatMap(object => [
    saveNode(object, {assignee: undefined}, `Crew lane failed: ${code}.`, question(object)),
    {op: 'assess', target: object.address, ready: false, reason: code},
    {op: 'note', target: object.address, id: randomUUID(), reply_to: null,
      text: `CREW_FAILURE\nTask: ${object.address}\nRun: ${runId}\nReason: ${code}\n${(failure || 'Lane failed').trim()}`}]));
  persist();
  await mutateTasks(run, run.blockRequest);
  result.tasks = [];
  for (const claim of claims) {
    const requested = op => run.blockRequest.operations.find(({command}) => command.op === op && command.target === claim.address)?.command;
    const assess = requested('assess'), note = requested('note');
    const confirmed = await api(run.config, run.joppaWorker, 'joppa_objects', {workspace: run.workspace, address: claim.address});
    const comment = confirmed.annotations?.comments?.[note?.id];
    require(confirmed.address === claim.address && confirmed.historical === false && confirmed.document?.present === true &&
      !nodeAssignee(confirmed) && nodeWaiting(confirmed) && assess && confirmed.process?.assessment?.reason === assess.reason &&
      confirmed.process.assessment.actor === run.joppaWorker.actor &&
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
