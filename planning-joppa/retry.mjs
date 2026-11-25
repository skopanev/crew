// Retry selection reads existing run history. Claims and publication keep their own guards.
const policies = ['always', 'on_revision', 'never'];
export function retryPolicy(config) {
  if (config.repeat !== undefined && typeof config.repeat !== 'boolean') throw new Error('repeat must be boolean');
  const policy = config.retry === undefined ? (config.repeat ? 'always' : 'on_revision') : config.retry;
  if (!policies.includes(policy)) {
    throw new Error('retry must be always, on_revision or never');
  }
  const reasons = config.retry_by_reason;
  if (reasons !== undefined && (!reasons || typeof reasons !== 'object' || Array.isArray(reasons) ||
      Object.entries(reasons).some(([code, value]) => !code.trim() || code !== code.trim() || !policies.includes(value)))) {
    throw new Error('retry_by_reason must map reason codes to always, on_revision or never');
  }
  const delays = config.retry_delay_seconds_by_reason;
  if (delays !== undefined && (!delays || typeof delays !== 'object' || Array.isArray(delays) ||
      Object.entries(delays).some(([code, value]) => !code.trim() || code !== code.trim() || !Number.isSafeInteger(value) || value < 1))) {
    throw new Error('retry_delay_seconds_by_reason must map reason codes to positive integer seconds');
  }
  return policy;
}

export function retryFilter(config, rows, attempted, cooldowns) {
  const policy = retryPolicy(config), revisions = new Map(), outcomes = new Map();
  for (const key of [...attempted, ...rows.flatMap(row => row.attemptKeys || [row.attemptKey]).filter(Boolean)]) {
    const [address, revision] = JSON.parse(key);
    revisions.set(address, Math.max(revisions.get(address) ?? 0, revision));
  }
  if (config.retry_by_reason || config.retry_delay_seconds_by_reason) for (const row of rows) {
    if (row.active) continue;
    for (const key of row.attemptKeys || [row.attemptKey].filter(Boolean)) {
      const [address, revision] = JSON.parse(key), previous = outcomes.get(address);
      const time = Date.parse(row.end || row.start) || 0;
      if (!previous || revision > previous.revision || revision === previous.revision && time > previous.time) {
        outcomes.set(address, {revision, time, reasonCode: row.reasonCode});
      }
    }
  }
  return row => {
    const outcome = outcomes.get(row.address), reason = outcome?.reasonCode;
    const selected = Object.hasOwn(config.retry_by_reason || {}, reason) ? config.retry_by_reason[reason] : policy;
    const delay = Object.hasOwn(config.retry_delay_seconds_by_reason || {}, reason) ? config.retry_delay_seconds_by_reason[reason] : 0;
    const until = delay && outcome?.time ? outcome.time + delay * 1000 : 0;
    return selected === 'always' ? Math.max(cooldowns.get(row.address) || 0, until) > Date.now() :
      selected === 'never' ? revisions.has(row.address) : (revisions.get(row.address) ?? 0) >= row.revision;
  };
}
