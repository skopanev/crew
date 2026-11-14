import {setTimeout as sleep} from 'node:timers/promises';
import {api, mutateTasks} from './joppa-common.mjs';
import {nodeAssignee} from './joppa-nodes.mjs';
import {JoppaTransportError} from './mcp-client.mjs';

export function validateClaimRetries(config) {
  const delays = config.joppa?.claimRetryDelaysSeconds;
  if (delays !== undefined && (!Array.isArray(delays) || delays.some(value =>
    !Number.isSafeInteger(value) || value <= 0 || value * 1000 > 2_147_483_647))) {
    throw new Error('joppa.claimRetryDelaysSeconds must be an array of positive, timer-safe integer seconds');
  }
}

async function noOwnedTasks(run, options) {
  try {
    for (const {command} of run.claimRequest.operations) {
      const address = `${command.kind}:${command.id}`;
      const object = await api(run.config, run.joppaWorker, 'joppa_objects',
        {workspace: run.claimRequest.workspace, address}, options);
      if (object?.address !== address || object.historical !== false || !object.document ||
          !Number.isSafeInteger(object.current_revision) || object.current_revision <= command.revision ||
          nodeAssignee(object) === command.data.assignee) return false;
    }
    return true;
  } catch { return false; }
}

// Retry only this durable claim. A successful receipt still needs claimTask's live assignee confirmation.
export async function sendClaim(run, persist, {signal, announce = () => {}} = {}) {
  validateClaimRetries(run.config);
  const delays = run.config.joppa.claimRetryDelaysSeconds || [];
  let ambiguous = false;
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try { await mutateTasks(run, run.claimRequest, {signal}); return; }
    catch (error) {
      const transport = error instanceof JoppaTransportError && !error.rejected;
      (run.claimFailures ||= []).push({at: new Date().toISOString(), attempt: attempt + 1,
        message: error.message, name: error.name,
        ...(Number.isSafeInteger(error.rpcError?.code) ? {rpcCode: error.rpcError.code} : {})});
      persist();
      signal?.throwIfAborted();
      if (error.rejected) {
        if (ambiguous && !await noOwnedTasks(run, {signal})) {
          throw new Error(`Claim replay refusal is unconfirmed after a transport failure: ${error.message}`);
        }
        run.claimRejected = true;
        persist();
      }
      if (!transport || attempt >= delays.length) throw error;
      ambiguous = true;
      announce(`[lane] CLAIM_RETRY ${attempt + 1} of ${delays.length} in ${delays[attempt]}s · same request_id`);
      try { await sleep(delays[attempt] * 1000, undefined, {signal}); }
      catch (stopped) { throw signal?.reason || stopped; }
    }
  }
}
