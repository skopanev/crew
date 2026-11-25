// Compute display rates from retained run evidence. No service reads or metric files.
export function avgPace(rows, now = Date.now()) {
  const starts = rows.map(row => Date.parse(row.start)).filter(at => Number.isFinite(at) && at <= now);
  const hours = starts.length ? Math.min(6, (now - starts.reduce((a, b) => Math.min(a, b))) / 3600000) : 0;
  if (hours < 1) return 'avg pace: ?';
  const events = new Map();
  for (const [index, row] of rows.entries()) {
    if (row.active) continue;
    const samples = row.paceEvents ?? (row.paceCount > 0 ? [{id: row.runId ?? index, at: row.end, count: row.paceCount}] : []);
    for (const event of samples) {
      const at = Date.parse(event.at), count = event.count ?? 1;
      if (!Number.isFinite(at) || at > now || !Number.isFinite(count) || count <= 0) continue;
      if (!events.has(event.id) || at < events.get(event.id).at) events.set(event.id, {at, count});
    }
  }
  const count = [...events.values()].filter(event => event.at >= now - hours * 3600000)
    .reduce((total, event) => total + event.count, 0);
  return `avg pace: ${(count / hours).toFixed(1)}/hr`;
}

// Several Tasks can describe one branch. Count only accepted heads after confirmed publication.
export function landingPace(input, state, result, retained = null) {
  const items = input?.items || (input?.selected ? [input.selected] : []);
  if (!state && !retained && !items.some(item => item.document?.data?.delivery?.branch)) return null;
  const events = [];
  const confirmed = result?.claim_released === true && !result?.needs_recovery;
  if (confirmed && state?.landed && state.landed_at) {
    const accepted = new Set((state.accepted || []).map(item => item.address));
    for (const item of items) {
      const data = item.document?.data, delivery = data?.delivery;
      if (accepted.has(item.address) && delivery?.branch && delivery.head) events.push({
        id: JSON.stringify([data.repository, delivery.branch, delivery.head]), at: state.landed_at});
    }
  } else if (retained?.publication_confirmed && retained.reason_code === 'LANDED' &&
      Number.isSafeInteger(retained.batch_size) && retained.batch_size > 0) {
    events.push({id: retained.run_id, at: retained.ended_at, count: retained.batch_size});
  }
  return {paceEvents: events};
}
