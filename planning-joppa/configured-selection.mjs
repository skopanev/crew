// Normal selection and one-time operator flushes share the same admission checks.
import {nextConfiguredItem} from './queue.mjs';
import {pendingFlush, consumeFlush, forcedConfig} from './flush.mjs';
import {retryFilter} from './retry.mjs';
import {occupiedSlots} from './slots.mjs';
import {contextAdmission} from './context-admission.mjs';

export async function configuredSelection({config, root, tokenFile, signal, rows, pool, detached, concurrency, attempted, cooldowns}) {
  const used = new Set(rows.map(row => row.flushRequest?.id).filter(Boolean));
  const requests = pendingFlush(config, root).filter(request => {
    if (!used.has(request.id)) return true;
    consumeFlush(request); return false;
  });
  const active = detached ? pool.runs.filter(run => run.active) : [...pool.active.values()].map(run => ({...run, config: run.config ?? config}));
  const occupied = occupiedSlots(config, rows, active), conflicts = contextAdmission(active);
  const skipRetry = retryFilter(config, rows, attempted, cooldowns), stats = {};
  const busy = address => !detached && pool.owns(address) || rows.some(row => row.active && row.ac === address);
  const profiles = (config.inputs || [{}]).map((profile, input) => ({input,
    profile: {...config, ...profile, inputs: undefined}, request: requests.find(request => request.input === input)}));
  profiles.sort((a, b) => Number(Boolean(b.request)) - Number(Boolean(a.request)));
  let count = 0, filtered = 0, next = null, flush = null;
  const queue = [];
  for (const entry of profiles) {
    const {input, request} = entry, profile = request ? forcedConfig(entry.profile) : entry.profile;
    const blocked = pool.size >= concurrency || occupied?.get(profile.slot) > 0;
    const result = await nextConfiguredItem(profile, tokenFile, signal,
      (row, effective, read) => blocked || busy(row.address) || skipRetry(row) || conflicts(row, effective, read), stats);
    count += result.count; filtered += result.filtered; queue.push(...result.queue);
    if (request && (result.count === 0 || !blocked && result.filtered === result.count)) {
      consumeFlush(request); console.log(`nothing to flush: ${request.slot}`);
    }
    if (!next && result.next) {
      next = {...result.next, ...(config.inputs ? {input} : {}), ...(profile.slot ? {slot: profile.slot} : {})};
      flush = request || null;
    }
    if (next && !config.batch?.by && !profile.slot) break;
  }
  return {count, filtered, next, queue, occupied, stats, flush};
}
