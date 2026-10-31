import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {command, quote} from './runtime.mjs';
import {api, batchRequest, mutateTasks} from './joppa-common.mjs';
import {formatContexts, formatRecoveryNote} from './joppa-input.mjs';
const require = (condition, message) => { if (!condition) throw new Error(message); };
const text = value => typeof value === 'string' && value.trim();

export async function recoverTimeout(run, stateFile, result, artifacts, {claims, currentTasks, verifySavedContexts, checkout, output, persist}) {
  result.held = true;
  result.blocked = false;
  await verifySavedContexts();
  const [claim] = claims, [object] = await currentTasks(true);
  const contextList = run.claim.contexts?.length ? run.claim.contexts : (claim.parent ? [claim.parent] : []);
  require(!object.document?.parent || (contextList.length > 0 &&
    contextList.every(item => text(item?.address) && /^[0-9a-f]{40,64}$/.test(item.digest || ''))),
    'Timeout recovery requires verified parent context digests; Task remains held');
  const contexts = formatContexts(contextList);
  const runDirName = path.basename(path.dirname(artifacts));
  const sessionNames = new Set([...output.matchAll(/^\[medulla\] (?:reusing )?session container (medulla-sess-[\w.-]+)\b/gm)].map(match => match[1]));
  require(sessionNames.size > 0, 'Cannot identify the old session container; Task remains held');
  const dockerFormat = '{"name":{{json .Names}},"runFolder":{{json (.Label "medulla.runs_under")}},"runDirName":{{json (.Label "medulla.run_dir_name")}}}';
  const dockerRows = command('docker', ['ps', '--format', dockerFormat])
    .split('\n').map(line => line.trim()).filter(Boolean).map(line => JSON.parse(line));
  require(dockerRows.every(row =>
    row.runFolder !== run.runFolder &&
    row.runDirName !== runDirName &&
    (!row.name || !sessionNames.has(row.name))),
    'Old session container is still running; Task remains held');
  const runId = path.basename(path.dirname(stateFile));
  const ref = `refs/heads/recovery/${runId}`;
  command('git', ['check-ref-format', ref]);
  const archivedCheckout = path.join(path.dirname(stateFile), 'recovery-checkout');
  const env = {...process.env, ...(run.config.sshDir ? {GIT_SSH_COMMAND: `ssh -F /dev/null -i ${quote(path.join(run.config.sshDir, 'id_ed25519'))} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${quote(path.join(run.config.sshDir, 'known_hosts'))}`} : {})};
  const git = (cwd, args, message, trim = true) => new Promise((resolve, reject) => execFile('git', ['-C', cwd, ...args],
    {env, encoding: 'utf8', timeout: 120_000}, (error, stdout) => error ? reject(new Error(message)) : resolve(trim ? stdout.trim() : stdout)));
  require(checkout && fs.existsSync(checkout) && !fs.lstatSync(checkout).isSymbolicLink(),
    'Timeout recovery requires a retained local checkout; Task remains held');
  const dirty = await git(checkout, ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all'],
    'Cannot inspect timeout recovery checkout status');
  require(!dirty, 'Timeout recovery checkout is not clean; Task remains held');
  const head = await git(checkout, ['rev-parse', '--verify', 'HEAD^{commit}'],
    'Cannot read timeout recovery HEAD');
  const tree = await git(checkout, ['rev-parse', '--verify', 'HEAD^{tree}'],
    'Cannot read timeout recovery tree');
  const baseFile = path.join(checkout, '.git/lane-base');
  const base = fs.existsSync(baseFile) ? fs.readFileSync(baseFile, 'utf8').trim() : '';
  require(/^[0-9a-f]{40,64}$/.test(head) && /^[0-9a-f]{40,64}$/.test(tree) &&
    /^[0-9a-f]{40,64}$/.test(base) && head !== base,
    'Timeout recovery requires a new clean checkpoint commit above lane-base; Task remains held');
  const baseTree = await git(checkout, ['rev-parse', '--verify', `${base}^{tree}`],
    'Cannot read timeout recovery base tree');
  const priorRecovery = claim.ticket?.recovery || run.claim.ticket?.recovery;
  const priorRecoverySha = priorRecovery?.sha;
  const priorRecoveryTree = priorRecovery?.tree || (priorRecoverySha
    ? await git(checkout, ['rev-parse', '--verify', `${priorRecoverySha}^{tree}`], 'Cannot read prior recovery tree')
    : null);
  require(tree !== baseTree && head !== priorRecoverySha && tree !== priorRecoveryTree,
    'Timeout recovery requires a new clean checkpoint tree above lane-base and prior recovery; Task remains held');
  await git(checkout, ['merge-base', '--is-ancestor', base, head],
    'Timeout recovery HEAD does not descend from lane-base; Task remains held');
  const diffOutput = await git(checkout, ['diff', '-z', '--no-renames', '--name-only', `${base}..${head}`],
    'Cannot inspect timeout recovery diff', false);
  const changedFiles = diffOutput.split('\0');
  if (changedFiles.at(-1) === '') changedFiles.pop();
  const roots = claim.ticket?.modulePaths || run.claim.ticket?.modulePaths || [];
  require(changedFiles.length > 0 && roots.length > 0 && changedFiles.every(file =>
    file.length > 0 && !/[\r\n]/.test(file) && !file.split('/').includes('..') &&
    roots.some(scope => scope === '.' || file === scope || file.startsWith(scope.replace(/\/+$/, '') + '/'))),
    'Timeout recovery commit is empty or touches files outside Task modulePaths; Task remains held');
  const seq = String(Object.keys(object.annotations?.comments || {}).length + 1).padStart(6, '0');
  const noteId = `recovery-${seq}-${runId}`;
  run.recovery = {task: object.address, digest: claim.digest, contexts, ref, sha: head, tree, base,
    node: 'implement_code', runId, noteId};
  persist();
  await git(checkout, ['push', 'origin', `${head}:${ref}`],
    'Cannot push timeout recovery branch; Task remains held');
  const remote = (await git(run.repository.path, ['ls-remote', 'origin', ref],
    'Cannot confirm remote recovery branch; Task remains held')).split(/\s+/)[0];
  require(remote === head, 'Remote recovery branch does not confirm the checkpoint SHA; Task remains held');
  run.recovery.pushed = true;
  const noteText = formatRecoveryNote(run.recovery);
  run.recoveryNoteRequest = batchRequest(run, [{
    op: 'note', target: object.address, id: noteId, text: noteText, reply_to: null,
  }]);
  persist();
  await api(run.config, run.joppaWorker, run.recoveryNoteRequest.operations ? 'joppa_batch' : 'joppa_command', run.recoveryNoteRequest);
  const noted = await api(run.config, run.joppaWorker, 'joppa_objects', {workspace: run.workspace, address: object.address});
  const comment = noted.annotations?.comments?.[noteId];
  require(noted.address === object.address && comment && comment.withdrawn !== true &&
    comment.actor === run.joppaWorker.actor && comment.text === noteText,
    'Joppa did not confirm the recovery checkpoint note; Task remains held');
  run.recovery.noted = true;
  persist();
  require(!fs.existsSync(archivedCheckout), 'Recovery checkout archive already exists; Task remains held');
  fs.renameSync(checkout, archivedCheckout);
  require(!fs.existsSync(checkout) && fs.existsSync(archivedCheckout),
    'Recovery checkout was not moved out of worktreeRoot before release; Task remains held');
  run.recovery.checkout = archivedCheckout;
  persist();
  const current = (await currentTasks(true))[0];
  run.releaseRequest = batchRequest(run, [{
    op: 'release_task', id: current.address, revision: current.current_revision,
    reason: `implement_code timed out; checkpoint ${head} saved on ${ref} (${noteId}).`,
  }]);
  persist();
  await mutateTasks(run, run.releaseRequest);
  const released = await api(run.config, run.joppaWorker, 'joppa_objects', {workspace: run.workspace, address: current.address});
  require(released.address === current.address && released.historical === false && released.document?.present === true &&
    Number.isSafeInteger(released.current_revision) && released.process?.status === 'open' &&
    released.process.assignee === null && !released.process.claim && !released.process.blocked &&
    !released.process.done && !released.process.retired,
    'RECOVERY_RELEASE_UNCONFIRMED: Joppa did not confirm Task as open and unassigned; Task remains held');
  run.releaseResults = [{address: current.address, revision: released.current_revision, status: 'open'}];
  run.releaseConfirmed = true;
  result.held = false;
  result.released = true;
  result.checkpointed = true;
  result.blocked = false;
  result.tasks = run.releaseResults;
  run.result = result;
  persist();
  try {
    fs.rmSync(archivedCheckout, {recursive: true, force: true});
    delete run.recovery.checkout;
    run.recovery.checkoutRemoved = !fs.existsSync(archivedCheckout);
    persist();
  } catch (error) {
    run.recovery.cleanupError = error.message;
  }
  return;
}
