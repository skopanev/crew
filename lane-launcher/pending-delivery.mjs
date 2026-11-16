// A checked branch waits for target integration. It does not complete its Tasks.
import {isDeepStrictEqual} from 'node:util';
import {api, batchRequest, mutateTasks} from './joppa-common.mjs';
import {saveNode} from './joppa-nodes.mjs';
const require = (ok, message) => { if (!ok) throw new Error(message); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function validatePendingDelivery(config) {
  if (config.delivery !== 'branch') return;
  const data = config.pendingDeliveryData;
  require(object(data) && Object.keys(data).length &&
    !Object.keys(data).some(key => ['assignee', 'commit', 'repository', 'delivery', 'acceptance'].includes(key)),
  'Branch delivery needs pendingDeliveryData: a nonempty native data patch without host-owned fields');
}

export async function recordPendingDelivery({run, objects, sha, branch, runId, persist, result}) {
  validatePendingDelivery(run.config);
  require(!run.completionRequest, 'An earlier branch completion request needs recovery before pending delivery');
  const saved = run.pendingDeliveryRequest?.operations[0]?.command.data.delivery;
  const delivery = {state: 'pending', branch, head: sha, target: run.repository.targetBranch, run: runId,
    ...(saved ? saved.pushed_at ? {pushed_at: saved.pushed_at} : {} : {pushed_at: new Date().toISOString()})};
  const changes = {...run.config.pendingDeliveryData, assignee: undefined, commit: sha,
    repository: run.repository.id, delivery};
  const commands = objects.map(node => saveNode(node, changes,
    `Checked branch ${branch} at ${sha} waits for target ${run.repository.targetBranch}. Run: ${runId}`));
  if (run.pendingDeliveryRequest) {
    require(isDeepStrictEqual(run.pendingDeliveryRequest.operations.map(row => row.command), commands),
      'Saved branch handoff differs from the checked publication; inspect its receipt');
  } else run.pendingDeliveryRequest = batchRequest(run, commands);
  persist();
  await mutateTasks(run, run.pendingDeliveryRequest);
  const tasks = [];
  for (const node of objects) {
    const current = await api(run.config, run.joppaWorker, 'joppa_objects', {workspace: run.workspace, address: node.address});
    const data = current.document?.data;
    require(current.address === node.address && current.historical === false && current.document.present === true &&
      !data.assignee && data.commit === sha && data.repository === run.repository.id &&
      isDeepStrictEqual(data.delivery, delivery) && Object.entries(run.config.pendingDeliveryData)
        .every(([key, value]) => value === null ? !Object.hasOwn(data, key) : isDeepStrictEqual(data[key], value)),
    'Joppa did not confirm the pending branch handoff for every Task');
    tasks.push({address: node.address, status: 'pending', revision: current.current_revision});
  }
  run.pendingDeliveryConfirmed = true;
  persist();
  result.pendingDelivery = true;
  result.tasks = tasks;
}
