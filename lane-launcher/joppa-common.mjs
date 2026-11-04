// Transport, receipt identities, and authored contract checks.
import {createHash, randomUUID} from 'node:crypto';
import {callJoppa} from './joppa-api.mjs';
import {remoteDependencyBlocker} from './dependencies.mjs';
const require = (condition, message) => { if (!condition) throw new Error(message); };
export const executionId = address => 'joppa-' + createHash('sha256').update(address).digest('hex').slice(0, 32);
export const contractDigest = object => {
  const data = {...object.document.data};
  delete data.assignee;
  delete data.commit;
  return createHash('sha256').update(JSON.stringify({
    parent: object.document.parent, data, links: object.document.links,
    ...(object.remote_links?.length ? {remote_links: object.remote_links.map(({status, ...link}) => link)} : {}),
    ...(object.remote_links_revision > 0 ? {remote_links_revision: object.remote_links_revision} : {}),
  })).digest('hex');
};

export function verifyRemoteDependencies(object) {
  const link = remoteDependencyBlocker(object);
  require(!link, `DEPENDENCY_NOT_READY: ${link}`);
}

export function api(config, worker, tool, arguments_, {signal} = {}) {
  return callJoppa(config.joppa.url, worker.tokenFile, tool, arguments_, {signal, mcpCommand: config.joppa.mcpCommand});
}

export const hasRecoveryCheckpoint = recovery => Boolean(recovery?.task || recovery?.ref || recovery?.sha);

export const runTasks = run => run.tasks || [{address: run.task, revision: run.taskRevision}];
export const claimTasks = run => run.claim.tasks || [{...run.claim, address: run.task}];

export function batchRequest(run, commands) {
  require(commands.length > 0 && commands.length <= 100,
    'Repository package exceeds the Joppa 100-operation atomic batch limit; no partial batch is permitted');
  return {workspace: run.workspace, request_id: randomUUID(), operations: commands.map(command => ({command}))};
}

export async function mutateTasks(run, request) {
  const batch = Array.isArray(request.operations);
  const result = await api(run.config, run.joppaWorker, batch ? 'joppa_batch' : 'joppa_command', request);
  if (batch) {
    require(Array.isArray(result.results) && result.results.length === request.operations.length,
      'Joppa batch response is incomplete; Tasks remain held for inspection');
    for (const [index, item] of result.results.entries()) {
      const expected = request.operations[index].command;
      const matches = expected.op === 'save_object'
        ? item.object?.address === `${expected.kind}:${expected.id}` && Number.isSafeInteger(item.object.revision)
        : Object.entries(expected).every(([key, value]) => JSON.stringify(item.command?.[key]) === JSON.stringify(value));
      require(item.command?.op === expected.op && matches,
        'Joppa batch response does not map to the requested Task; inspect the saved request');
    }
  }
  return result;
}
