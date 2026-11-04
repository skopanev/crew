import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {isDeepStrictEqual} from 'node:util';
import {quote, save} from './runtime.mjs';
import {api, batchRequest, claimTasks, contractDigest, verifyRemoteDependencies, hasRecoveryCheckpoint} from './joppa-common.mjs';
import {parsePublication} from './requirement-delivery.mjs';
import {failTask} from './joppa-failure.mjs';
import {heldBy, released, contextLive, taskQuestions} from './joppa-claims.mjs';
import {saveNode} from './joppa-nodes.mjs';
import {frozenBindings, packageBudget} from './test-bindings.mjs';
import {missingTestNodes} from './test-nodes.mjs';
const require = (condition, message) => { if (!condition) throw new Error(message); };

export async function finishTask(run, stateFile, result, artifacts) {
  if (run.releaseConfirmed === true) return;
  require(!run.releaseRequest, 'PACKAGE_RELEASE_UNCONFIRMED: Tasks remain held for inspection');
  require(!run.recoveryNoteRequest, 'RECOVERY_NOTE_UNCONFIRMED: Task remains held for inspection');
  require(!hasRecoveryCheckpoint(run.recovery), 'RECOVERY_HANDOFF_UNCONFIRMED: Task remains held for inspection');
  if (!run.claim) return;
  const persist = () => save(stateFile, run);
  const claims = claimTasks(run);
  const unclaimed = released;
  const owned = object => heldBy(run, object);
  const currentTasks = async (validate = false, allowReleased = false) => {
    const objects = [];
    for (const claim of claims) {
      const object = await api(run.config, run.joppaWorker, 'joppa_objects', {workspace: run.workspace, address: claim.address});
      require(object.address === claim.address, 'Joppa returned a different Task for completion');
      require(owned(object) || allowReleased && !run.completionRequest && !run.blockRequest && unclaimed(object),
        'Task holder changed; package outcome not written');
      if (validate) {
        verifyRemoteDependencies(object);
        require(object.work_ready === true,
          'TASK_REVIEW_REQUIRED: Task context needs review; landed package remains held');
        require(contractDigest(object) === claim.digest, 'Task contract changed during execution; package completion refused');
      }
      objects.push(object);
    }
    return objects;
  };
  const verifySavedContexts = async () => {
    for (const context of new Map(claims.filter(claim => claim.parent).map(claim => [claim.parent.address, claim.parent])).values()) {
      const parent = await api(run.config, run.joppaWorker, 'joppa_objects',
        {workspace: run.workspace, address: context.address});
      verifyRemoteDependencies(parent);
      require(parent.address === context.address && contextLive(parent) && parent.work_ready === true,
        'Task parent context needs review; completion refused');
      require(contractDigest(parent) === context.digest, 'Task parent context changed during execution; package completion refused');
    }
    for (const context of run.claim.contexts || []) {
      const parent = await api(run.config, run.joppaWorker, 'joppa_objects', {workspace: run.workspace, address: context.address});
      verifyRemoteDependencies(parent);
      require(parent.address === context.address && contextLive(parent) && parent.work_ready === true &&
        contractDigest(parent) === context.digest, 'Package acceptance context changed during execution; completion refused');
    }
  };
  const objects = await currentTasks(result.code === 0, result.code !== 0);
  if (result.code === 0) {
    const report = ['landing.txt', 'verification.txt'].map(name => path.join(artifacts || '', name)).find(file => fs.existsSync(file));
    require(report, 'Checked publication evidence is missing; Task remains held');
    const evidence = fs.readFileSync(report, 'utf8');
    const {sha, target} = parsePublication(evidence);
    const expected = run.config.delivery === 'requirement'
      ? run.requirementDelivery.final ? run.repository.targetBranch : run.requirementDelivery.branch
      : report.endsWith('verification.txt') || run.config.delivery === 'target' ? run.repository.targetBranch : run.deliveryBranch || `ticket-${run.executionId}`;
    require(sha && target === expected, 'Publication evidence does not match the configured delivery');
    const env = {...process.env, GIT_SSH_COMMAND: `ssh -F /dev/null -i ${quote(path.join(run.config.sshDir, 'id_ed25519'))} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${quote(path.join(run.config.sshDir, 'known_hosts'))}`};
    const remote = await new Promise((resolve, reject) => execFile('git', ['-C', run.repository.path, 'ls-remote', 'origin', `refs/heads/${target}`],
      {env, encoding: 'utf8', timeout: 120_000}, (error, output) => error ? reject(new Error('Cannot confirm published SHA')) : resolve(output.trim().split(/\s/)[0])));
    if (remote !== sha && remote && expected === run.repository.targetBranch) {
      const git = args => new Promise((resolve, reject) => execFile('git', ['-C', run.repository.path, ...args],
        {env, encoding: 'utf8', timeout: 120_000}, error => error ? reject(new Error('Remote branch does not contain the checked SHA; Task remains held')) : resolve()));
      await git(['fetch', '--no-write-fetch-head', 'origin', remote]);
      await git(['merge-base', '--is-ancestor', sha, remote]);
    } else require(remote === sha, 'Remote branch does not confirm the checked SHA; Task remains held');
    const followups = path.join(artifacts, 'followups.txt');
    const findings = fs.existsSync(followups) ? fs.readFileSync(followups, 'utf8').trim() : '';
    await verifySavedContexts();
    const current = await currentTasks(true), question = await taskQuestions(run), runId = path.basename(path.dirname(stateFile));
    // One save records the commit and removes the assignee. The archive uses the revision that save returns.
    if (!run.completionRequest) {
      // Recompute the frozen test bindings. Create each missing (AC, test) node in the completion batch.
      const bindings = frozenBindings(run, artifacts, current);
      const read = (tool, args) => api(run.config, run.joppaWorker, tool, {workspace: run.workspace, ...args});
      const nodes = bindings.rows.length ? await missingTestNodes(read, (await read('joppa_tree', {})).schema, bindings.rows) : [];
      packageBudget(current.length, nodes.length);
      run.testBindings = {status: bindings.status, gaps: bindings.gaps, nodes: nodes.length};
      const bound = object => bindings.rows.filter(row => row.task === object.address)
        .map(({ac, check, test}) => ({ac, check, test}));
      run.completionRequest = batchRequest(run, [...current.flatMap((object, index) => [
        saveNode(object, {assignee: undefined, commit: sha, ...(bound(object).length ? {test_bindings: bound(object)} : {})},
          `${evidence.trim()}\nTask: ${object.address}\nPackage Tasks: ${claims.map(claim => claim.address).join(', ')}\nRequired gates and independent review passed. Run: ${runId}${findings ? '\nNonblocking findings:\n' + findings : ''}`, question(object)),
        {op: 'archive_object', target: object.address, revision: {$ref: `done${index}/saved_revision`}, reason: `Crew lane landed ${sha}.`}]),
        ...nodes]);
      current.forEach((_, index) => { run.completionRequest.operations[index * 2].ref = `done${index}`; });
    }
    const operations = run.completionRequest.operations, nodeCount = operations.length - claims.length * 2;
    require(nodeCount >= 0 && operations.slice(claims.length * 2).every(({command}) =>
      command.op === 'save_object' && command.revision === 0 && !command.id) && claims.every((claim, index) => {
      const [{command: save, ref}, {command: archive}] = operations.slice(index * 2, index * 2 + 2);
      return save.op === 'save_object' && `${save.kind}:${save.id}` === claim.address && save.data?.commit === sha &&
        !save.data.assignee && save.question_checked === question(current[index]) && typeof ref === 'string' && archive.op === 'archive_object' &&
        archive.target === claim.address && isDeepStrictEqual(archive.revision, {$ref: `${ref}/saved_revision`});
    }), 'Saved completion request does not name the checked SHA; inspect it before retrying');
    persist();
    // Save receipts carry the saved object. Archive receipts carry the command with the resolved revision.
    const receipt = await api(run.config, run.joppaWorker, 'joppa_batch', run.completionRequest);
    require(Array.isArray(receipt?.results) && receipt.results.length === operations.length,
      'Joppa batch response is incomplete; Tasks remain held for inspection');
    const savedRevisions = claims.map((claim, index) => {
      const [saved, archived] = receipt.results.slice(index * 2, index * 2 + 2);
      const revision = saved.object?.revision;
      require(saved.command?.op === 'save_object' && saved.object?.address === claim.address && Number.isSafeInteger(revision) &&
        revision >= operations[index * 2].command.revision && archived.command?.op === 'archive_object' && !archived.object &&
        archived.command.target === claim.address && archived.command.revision === revision,
      'Joppa batch response does not map to the requested Task; inspect the saved request');
      return revision;
    });
    for (const created of receipt.results.slice(claims.length * 2)) {
      require(created.command?.op === 'save_object' && typeof created.object?.address === 'string' &&
        Number.isSafeInteger(created.object.revision), 'Joppa batch response does not confirm each test node; inspect the saved request');
    }
    // An archived node reads as present:false and keeps data.commit.
    result.tasks = [];
    for (const [index, claim] of claims.entries()) {
      const confirmed = await api(run.config, run.joppaWorker, 'joppa_objects', {workspace: run.workspace, address: claim.address});
      require(confirmed?.address === claim.address && confirmed.historical === false &&
        Number.isSafeInteger(confirmed.current_revision) && confirmed.current_revision > savedRevisions[index] &&
        confirmed.document?.present === false && confirmed.document.data?.commit === sha && !confirmed.document.data.assignee,
        'Joppa did not confirm every Task completion at the checked SHA');
      result.tasks.push({address: claim.address, status: 'done', revision: confirmed.current_revision});
    }
    result.completed = true;
    if (run.testBindings) result.testBindings = run.testBindings;
  } else {
    await failTask(run, stateFile, result, artifacts,
      {claims, objects, currentTasks, verifySavedContexts, owned, unclaimed, persist});
  }
}
