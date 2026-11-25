// Count native candidates for display. Admission checks remain part of selection only.
import {api} from './joppa.mjs';

const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ?
  Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const count = value => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid aggregate count');
  return value;
};

export async function availableCounts(config, tokenFile, signal, claimsKnown = true, read = (args) =>
  api({joppa: {url: config.url, mcpCommand: config.mcp_command}}, {tokenFile}, 'joppa_objects', args, {signal})) {
  const started = performance.now(), calls = new Map();
  const profiles = config.inputs?.map(profile => ({...config, ...profile})) || [config];
  const values = await Promise.all(profiles.map(async (profile, index) => {
    const excluded = profile.exclude_tags || [];
    const args = {...profile.selection, workspace: config.workspace, assignee: '',
      ...(excluded.length ? {group_by: ['tags']} : {count: true})};
    const key = JSON.stringify(canonical(args));
    if (!calls.has(key)) calls.set(key, Promise.resolve().then(() => read(args)));
    let value = '?';
    try {
      const result = await calls.get(key);
      let total = count(result.total);
      if (excluded.length) {
        if (!Array.isArray(result.groups)) throw new Error('Missing aggregate groups');
        let grouped = 0;
        total = result.groups.reduce((sum, group) => {
          const size = count(group.count);
          grouped += size;
          if (group.tags !== null && (!Array.isArray(group.tags) || group.tags.some(tag => typeof tag !== 'string')))
            throw new Error('Invalid aggregate tags');
          return sum + (excluded.some(tag => group.tags?.includes(tag)) ? 0 : size);
        }, 0);
        if (grouped !== result.total) throw new Error('Incomplete aggregate groups');
      }
      if (claimsKnown) value = total;
    } catch { /* A display read never changes selection or stops the dispatcher. */ }
    const label = profile.slot || (typeof profile.selection.data?.stage === 'string' && profile.selection.data.stage) || `input ${index + 1}`;
    return {label, value};
  }));
  return {text: values.length === 1 ? String(values[0].value) : ': ' + values.map(({label, value}) =>
    `${label.replace(/[\x00-\x1f\x7f]/g, ' ')} ${value}`).join(' · '), values, reads: calls.size, ms: performance.now() - started};
}

export const availabilityLabel = state => `available${state.available?.startsWith(':') ? '' : ' '}${state.available ?? '?'}` +
  (state.skipped === undefined ? '' : ` · skipped ${state.skipped}`);
