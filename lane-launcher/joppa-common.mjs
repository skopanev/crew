// Transport, receipt identities, and authored contract checks.
import {createHash, randomUUID} from 'node:crypto';
import {callJoppa, readJoppa} from './joppa-api.mjs';
import {remoteDependencyBlocker} from './dependencies.mjs';
const require = (condition, message) => { if (!condition) throw new Error(message); };
export const executionId = address => 'joppa-' + createHash('sha256').update(address).digest('hex').slice(0, 32);
const digestOf = (object, data) => createHash('sha256').update(JSON.stringify({
  parent: object.document.parent, data, links: object.document.links,
  ...(object.remote_links?.length ? {remote_links: object.remote_links.map(({status, ...link}) => link)} : {}),
  ...(object.remote_links_revision > 0 ? {remote_links_revision: object.remote_links_revision} : {}),
})).digest('hex');
const legacyDigest = object => {
  const data = {...object.document.data};
  delete data.assignee;
  delete data.commit;
  delete data.test_bindings;
  return digestOf(object, data);
};
export const contractDigest = object => {
  const data = {...object.document.data};
  delete data.assignee;
  delete data.commit;
  // Completion writes the bound test names next to the commit. They are lifecycle evidence, not contract.
  delete data.test_bindings;
  // Stage tracks execution or rolls up from status. It does not change the authored contract.
  delete data.stage;
  return digestOf(object, data);
};

// Old claims include stage in the digest. Use their frozen data, never revision equality, to prove a match.
export function sameContract(object, snapshot, claim = {}) {
  if (!snapshot?.digest) return false;
  if (contractDigest(object) === snapshot.digest || legacyDigest(object) === snapshot.digest) return true;
  const tickets = [claim.ticket, ...(claim.tasks || []).map(task => task.ticket)].filter(Boolean);
  const frozen = tickets.flatMap(ticket => [ticket.parentContext, ticket.requirementContext,
    ...(ticket.coveredContexts || [])]).find(context => context?.address === object.address && context.data);
  if (!frozen) return false;
  const original = {...object, document: {...object.document, data: frozen.data}};
  return contractDigest(original) === contractDigest(object) && legacyDigest(original) === snapshot.digest;
}

// Never expose download credentials. These fields also identify attachment changes independently of document revisions.
export const sourceFiles = object => (object.files || []).map(file => Object.fromEntries(
  ['id', 'name', 'hash', 'size', 'content_type', 'at'].filter(key => file[key] !== undefined).map(key => [key, file[key]])));

// A Source fixes a version. Its file edits must invalidate the context, even when its body does not change.
export const contextDigest = (object, context) => context.source
  ? createHash('sha256').update(JSON.stringify({revision: object.current_revision,
    contract: contractDigest(object), files: sourceFiles(object)})).digest('hex')
  : contractDigest(object);

export const sameContext = (object, context, claim) => context.source
  ? contextDigest(object, context) === context.digest : sameContract(object, context, claim);

export function verifyRemoteDependencies(object) {
  const link = remoteDependencyBlocker(object);
  require(!link, `DEPENDENCY_NOT_READY: ${link}`);
}

export function api(config, worker, tool, arguments_, {signal} = {}) {
  const call = ['joppa_objects', 'joppa_tree', 'joppa_help', 'joppa_search'].includes(tool) ? readJoppa : callJoppa;
  return call(config.joppa.url, worker.tokenFile, tool, arguments_, {signal, mcpCommand: config.joppa.mcpCommand});
}

export const hasRecoveryCheckpoint = recovery => Boolean(recovery?.task || recovery?.ref || recovery?.sha);

export const runTasks = run => run.tasks || [{address: run.task, revision: run.taskRevision}];
export const claimTasks = run => run.claim.tasks || [{...run.claim, address: run.task}];

export function batchRequest(run, commands) {
  require(commands.length > 0 && commands.length <= 100,
    'Repository package exceeds the Joppa 100-operation atomic batch limit; no partial batch is permitted');
  return {workspace: run.workspace, request_id: randomUUID(), operations: commands.map(command => ({command}))};
}

export async function mutateTasks(run, request, options = {}) {
  const batch = Array.isArray(request.operations);
  const result = await api(run.config, run.joppaWorker, batch ? 'joppa_batch' : 'joppa_command', request, options);
  if (batch) {
    require(Array.isArray(result.results) && result.results.length === request.operations.length,
      'Joppa batch response is incomplete; Tasks remain held for inspection');
    for (const [index, item] of result.results.entries()) {
      const expected = request.operations[index].command;
      const matches = expected.op === 'save_object'
        ? item.object?.address === `${expected.kind}:${expected.id}` && Number.isSafeInteger(item.object.revision)
        // Receipts trim long texts. Match the identity of the operation, not its echo.
        : ['target', 'id', 'revision'].every(key => expected[key] === undefined ||
          JSON.stringify(item.command?.[key]) === JSON.stringify(expected[key]));
      require(item.command?.op === expected.op && matches,
        'Joppa batch response does not map to the requested Task; inspect the saved request');
    }
  }
  return result;
}
