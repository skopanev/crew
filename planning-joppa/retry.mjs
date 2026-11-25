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
  return policy;
}

export function retryFilter(config, rows, attempted, cooldowns) {
  const policy = retryPolicy(config), revisions = new Map(), outcomes = new Map();
  for (const key of [...attempted, ...rows.flatMap(row => row.attemptKeys || [row.attemptKey]).filter(Boolean)]) {
    const [address, revision] = JSON.parse(key);
    revisions.set(address, Math.max(revisions.get(address) ?? 0, revision));
  }
  if (config.retry_by_reason) for (const row of rows) {
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
    const reason = outcomes.get(row.address)?.reasonCode;
    const selected = Object.hasOwn(config.retry_by_reason || {}, reason) ? config.retry_by_reason[reason] : policy;
    return selected === 'always' ? (cooldowns.get(row.address) || 0) > Date.now() :
      selected === 'never' ? revisions.has(row.address) : (revisions.get(row.address) ?? 0) >= row.revision;
  };
}
