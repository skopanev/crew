// Repair failures keep the original pending branch. Only an explicit AC defect returns its acceptance parent.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {api, batchRequest, mutateTasks, claimTasks, sameContract} from './joppa-common.mjs';
import {save} from './runtime.mjs';
import {nodeAssignee, saveNode} from './joppa-nodes.mjs';
import {heldBy} from './joppa-claims.mjs';
import {writerGone, checkoutPath, laneGit} from './retained-checkout.mjs';
import {repairSettings, repairCandidate, repairParentReady, failedRepairChanges} from './repair-delivery.mjs';
const need = (ok, message) => { if (!ok) throw new Error('DELIVERY_REPAIR: ' + message); };

export async function finishRepairFailure(run, stateFile, result, objects, artifacts) {
  const policy = repairSettings(run.config), claims = claimTasks(run);
  need(policy && run.repairDelivery && objects.length === 1 && claims.length === 1, 'failure needs one repair claim');
  need(!result.publicationUncertain && !result.cleanupError && (!run.launchPgid || writerGone(run, checkoutPath(run))),
    'publication or stopped writers remain unconfirmed');
  const checkout = checkoutPath(run);
  if (fs.existsSync(path.join(checkout, '.git'))) laneGit(checkout);
  const read = (tool, args) => api(run.config, run.joppaWorker, tool, {workspace: run.workspace, ...args});
  const task = objects[0], source = run.repairDelivery;
  need(repairCandidate(run.config, task) && task.document.data.delivery.head === source.head &&
    task.document.data.delivery.branch === source.branch, 'the saved branch identity changed during repair');
  let origin = {};
  if (artifacts && fs.existsSync(path.join(artifacts, 'origin.json'))) origin = JSON.parse(fs.readFileSync(path.join(artifacts, 'origin.json')));
  const defect = origin.signal === 'AC_DEFECT';
  const file = artifacts && path.join(artifacts, 'failure.txt');
  const finding = (file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : origin.message || result.error || 'Repair did not finish').slice(0, 2500);
  if (!run.repairFailureRequest) {
    need(heldBy(run, task), 'only this run can release its repair claim');
    const commands = [saveNode(task, {assignee: undefined, ...failedRepairChanges(run.config, task), ...(defect ? {stage: policy.defectTaskStage} : {})}, 'Release this repair claim and preserve the original pending branch.'),
      {op: 'note', target: task.address, id: randomUUID(), text: `CREW_REPAIR_FAILURE\nBranch: ${source.branch}\nHead: ${source.head}\n${finding}\nEvidence: ${artifacts || run.runFolder}`}];
    if (defect) {
      const parent = await read('joppa_objects', {address: task.document.parent});
      const schema = (await read('joppa_tree', {})).schema, field = schema.types?.[parent.kind]?.fields?.stage;
      need(schema.types[task.kind]?.fields?.stage?.values?.includes(policy.defectTaskStage) &&
        (schema.types[task.kind]?.fields?.stage?.from ?? 'own') === 'own' && parent.address === task.document.parent && parent.historical === false && parent.document?.present === true &&
        !nodeAssignee(parent) && repairParentReady(run.config, parent) && schema.types[parent.kind].role === 'ac' &&
        (field?.from ?? 'own') === 'own' && field?.values?.includes(policy.returnStage) &&
        claims[0].parent?.address === parent.address && sameContract(parent, claims[0].parent, run.claim),
      'the acceptance parent changed or its configured return stage is not editable');
      commands.push(saveNode(parent, {stage: policy.returnStage}, 'Return the acceptance criterion with the repair finding.'),
        {op: 'note', target: parent.address, id: randomUUID(), text: `CREW_AC_DEFECT\nTask: ${task.address}\n${finding}\nEvidence: ${artifacts}`});
    }
    run.repairFailureRequest = batchRequest(run, commands);
    save(stateFile, run);
  }
  await mutateTasks(run, run.repairFailureRequest);
  const confirmed = await read('joppa_objects', {address: task.address});
  need(confirmed?.address === task.address && confirmed.historical === false && confirmed.document?.present === true &&
    !nodeAssignee(confirmed) && repairCandidate(run.config, confirmed) &&
    isDeepStrictEqual(confirmed.document.data[policy.attemptField], run.repairFailureRequest.operations[0].command.data[policy.attemptField]) &&
    confirmed.document.data.delivery.head === source.head && confirmed.document.data.delivery.branch === source.branch,
  'the release did not confirm the original red pending branch');
  const parentSave = run.repairFailureRequest.operations.map(row => row.command).find(command =>
    command.op === 'save_object' && command.kind + ':' + command.id !== task.address);
  if (parentSave) {
    const parent = await read('joppa_objects', {address: parentSave.kind + ':' + parentSave.id});
    need(parent.document?.data?.stage === policy.returnStage && confirmed.document.data.stage === policy.defectTaskStage,
      'the acceptance and Task return were not confirmed');
  }
  run.releaseConfirmed = true;
  result.released = true; result.repairPending = true; result.held = false; result.blocked = false;
  result.tasks = [{address: task.address, revision: confirmed.current_revision, status: parentSave ? 'returned' : 'pending'}];
  save(stateFile, run);
}
