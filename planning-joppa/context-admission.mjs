// Admit disjoint configured contexts within one dispatcher. Tracker guards remain authoritative.
import fs from 'node:fs';
import path from 'node:path';
import {nodePages} from '../lane-launcher/joppa-nodes.mjs';
import {normalizeSlots} from './slots.mjs';

const require = (condition, message) => { if (!condition) throw new Error('Context admission: ' + message); };
const json = file => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const kinds = value => Array.isArray(value) ? value : [value];
const address = value => typeof value === 'string' && value.includes(':');

function capturedAddresses(input) {
  require(input?.selected?.document && Number.isSafeInteger(input.selected.current_revision),
    'active worker input profile is unavailable');
  const addresses = new Set([input.selected.address]), context = input.context;
  if (!context) return addresses;
  require(address(context.parent?.address) && Array.isArray(context.incoming), 'captured context is incomplete');
  addresses.add(context.parent.address);
  for (const item of context.incoming) {
    require(address(item.address), 'captured incoming identity is missing');
    if (item.document?.present !== false) addresses.add(item.address);
  }
  return addresses;
}

function worker(run) {
  const folder = run.medullaRun || run.current?.folder;
  const input = folder ? json(path.join(folder, 'artifacts/input.json')) : null;
  const index = run.input ?? input?.input;
  const configFile = run.args?.[run.args.indexOf('--config') + 1];
  const raw = run.config || (configFile && json(configFile));
  const config = raw && normalizeSlots(raw);
  require(config, 'active worker snapshot is unavailable');
  require(!input || input.selected?.address === run.address, 'active worker input identity differs');
  let profile = config;
  if (config.inputs) {
    // A legacy captured input already records its context. Do not infer its profile from current filters.
    if (index === undefined && input) return {addresses: capturedAddresses(input)};
    require(Number.isSafeInteger(index) && index >= 0 && index < config.inputs.length,
      'active worker input profile is unavailable');
    profile = {...config, ...config.inputs[index], inputs: undefined};
  }
  return {profile, selected: input?.selected || {address: run.address}, context: input?.context};
}

// The callback accepts the effective profile from queue recursion, including profiles without related context.
export function contextAdmission(active) {
  let occupied;
  const objects = new Map(), incoming = new Map();
  const full = async (address, read) => {
    if (!objects.has(address)) objects.set(address, read('joppa_objects', {address}));
    const item = await objects.get(address);
    require(item?.address === address && item.historical === false && item.document &&
      Number.isSafeInteger(item.current_revision), 'object read is not current');
    return item;
  };
  const scope = async (profile, selected, context, read) => {
    require(typeof selected.address === 'string' && selected.address.includes(':'), 'selected identity is missing');
    const addresses = new Set([selected.address]), spec = profile.related;
    if (!spec) return addresses;
    if (spec.parent) {
      let parent = context?.parent?.address || selected.parent || selected.document?.parent;
      if (!parent) parent = (await full(selected.address, read)).document.parent;
      require(typeof parent === 'string' && parent.includes(':'), 'related parent is unavailable');
      addresses.add(parent);
    }
    if (spec.incoming) {
      if (context) {
        require(Array.isArray(context.incoming), 'captured incoming context is unavailable');
        for (const item of context.incoming) {
          if (item.document?.present !== false && kinds(spec.incoming.kind).includes(item.kind)) addresses.add(item.address);
        }
      } else {
        const key = JSON.stringify([selected.address, spec.incoming]);
        if (!incoming.has(key)) incoming.set(key, (async () => {
          const found = [];
          for await (const page of nodePages(read, {relations_of: selected.address, direction: 'incoming',
            relation: spec.incoming.relation, fields: ['kind', 'revision']})) {
            for (const row of page.items) {
              if (!kinds(spec.incoming.kind).includes(row.kind)) continue;
              const item = await full(row.address, read);
              if (item.document.present === false) continue;
              require(item.relations?.[spec.incoming.relation]?.edges?.some(edge => edge.to === selected.address),
                'incoming relation changed');
              found.push(item.address);
            }
          }
          return found;
        })());
        for (const address of await incoming.get(key)) addresses.add(address);
      }
    }
    return addresses;
  };
  return async (row, profile, read) => {
    if (!active.length) return false;
    // The queue's existing parent guard rejects this row without reading further context.
    if (profile.related?.parent && !row.parent) return false;
    occupied ||= Promise.all(active.map(async run => {
      const captured = worker(run);
      return captured.addresses || scope(captured.profile, captured.selected, captured.context, read);
    }));
    const reservations = await occupied, candidate = await scope(profile, row, undefined, read);
    return reservations.some(addresses => [...candidate].some(address => addresses.has(address)));
  };
}
