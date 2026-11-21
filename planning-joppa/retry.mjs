// Retry selection reads existing run history. Claims and publication keep their own guards.
export function retryPolicy(config) {
  if (config.repeat !== undefined && typeof config.repeat !== 'boolean') throw new Error('repeat must be boolean');
  const policy = config.retry === undefined ? (config.repeat ? 'always' : 'on_revision') : config.retry;
  if (!['always', 'on_revision', 'never'].includes(policy)) {
    throw new Error('retry must be always, on_revision or never');
  }
  return policy;
}

export function retryFilter(config, rows, attempted, cooldowns) {
  const policy = retryPolicy(config), revisions = new Map();
  for (const key of [...attempted, ...rows.flatMap(row => row.attemptKeys || [row.attemptKey]).filter(Boolean)]) {
    const [address, revision] = JSON.parse(key);
    revisions.set(address, Math.max(revisions.get(address) ?? 0, revision));
  }
  return row => policy === 'always' ? (cooldowns.get(row.address) || 0) > Date.now() :
    policy === 'never' ? revisions.has(row.address) : (revisions.get(row.address) ?? 0) >= row.revision;
}
