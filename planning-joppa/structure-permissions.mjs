// Authorize only the structural exceptions enabled by the flow configuration.
import {readJoppa} from '../lane-launcher/joppa-api.mjs';
import {pathToFileURL} from 'node:url';

const need = (ok, message) => { if (!ok) throw new Error(message); };
const data = node => node.document?.data || {};
const parent = node => node.document?.parent;
// Every ref name that a command uses anywhere, for example {"$ref": "part/address"} gives part.
const used = (value, names = new Set()) => {
  if (Array.isArray(value)) value.forEach(item => used(item, names));
  else if (value && typeof value === 'object') {
    if (typeof value.$ref === 'string') names.add(value.$ref.split('/')[0]);
    else Object.values(value).forEach(item => used(item, names));
  }
  return names;
};
const reference = value => value && typeof value === 'object' && Object.keys(value).join() === '$ref' &&
  typeof value.$ref === 'string' && value.$ref.endsWith('/address') ? value.$ref.slice(0, -8) : null;

export async function authorize({config, assignment, rows}, read) {
  const policy = config.publication, structure = policy.structure, selected = assignment.selected;
  // early: creates that the publisher may run before the claim releases. A create under a claimed parent runs after
  // the releases, so each row that uses its ref, directly or through another row, also runs after them.
  const result = {creates: [], moves: [], notes: [], early: []}, created = new Map(), cache = new Map(), late = new Set();
  const owned = new Set((assignment.items || [selected]).map(node => node.address));
  const editable = new Map([selected, ...assignment.children].map(node => [node.address, node]));
  const fresh = async address => {
    need(typeof address === 'string' && address.length > 0, 'A structural parent needs an address');
    if (!cache.has(address)) cache.set(address, await read(address));
    const node = cache.get(address);
    need(typeof node?.address === 'string' && node.historical !== true && node.document?.present === true,
      'The structural parent is not current: ' + address);
    need(!data(node).assignee && !(data(node).tags || []).some(tag => (config.exclude_tags || []).includes(tag)),
      'The structural parent is held or excluded: ' + address);
    return node;
  };
  const inScope = async node => {
    let scope = config.selection.parent;
    if (!scope) return;
    scope = (await fresh(scope)).address;
    const seen = new Set();
    while (node.address !== scope) {
      need(parent(node) && !seen.has(node.address), 'The structural parent is outside selection.parent');
      seen.add(node.address);
      node = await fresh(parent(node));
    }
  };
  const allowedParent = async (kind, value, scopes) => {
    let parentKind;
    const ref = reference(value);
    if (ref && scopes.includes('created')) {
      need(created.has(ref), 'A created parent must precede its child');
      parentKind = created.get(ref);
    } else if (typeof value === 'string' && scopes.includes('context_parent') && value === parent(selected)) {
      const captured = assignment.context?.parent;
      need(captured?.address === value, 'Capture the structural context parent before planning');
      const current = await fresh(value);
      need(current.current_revision === captured.current_revision, 'The captured structural parent changed');
      parentKind = current.kind;
    } else if (typeof value === 'string' && scopes.includes('fresh_parent')) {
      const current = await fresh(value);
      await inScope(current);
      parentKind = current.kind;
    } else return false;
    need((assignment.schema.types[kind]?.parents || []).includes(parentKind), 'The schema refuses this structural parent');
    return true;
  };
  for (const [index, row] of rows.entries()) {
    const command = row.command;
    if (command?.op === 'save_object' && command.revision === 0) {
      const root = command.parent === null && assignment.schema.types[command.kind]?.root === true;
      if (!root && !owned.has(command.parent)) {
        need(await allowedParent(command.kind, command.parent, structure.create?.[command.kind] || []),
          'The configured flow cannot create under this parent');
        result.creates.push(index);
      }
      const after = !root && owned.has(command.parent) || [...used(command)].some(name => late.has(name));
      if (!after) result.early.push(index);
      if (row.ref) {
        need(!created.has(row.ref) && policy.create_kinds.includes(command.kind), 'Invalid structural creation ref');
        created.set(row.ref, command.kind);
        if (after) late.add(row.ref);
      }
    } else if (command?.op === 'save_object' && 'parent' in command) {
      const address = command.kind + ':' + command.id, node = editable.get(address);
      need(node && (command.kind === selected.kind ? address === selected.address : parent(node) === selected.address),
        'A structural move must target the selected object or its own direct child');
      need(address === selected.address || !data(node).assignee, 'The child being moved is held');
      need(await allowedParent(command.kind, command.parent, structure.move?.[command.kind] || []),
        'The configured flow cannot move to this parent');
      need(address !== selected.address && !owned.has(address) || ![...used(command)].some(name => late.has(name)),
        'A claimed object cannot move under a create that runs after its release');
      result.moves.push(index);
    } else if (command?.op === 'note' && reference(command.target)) {
      need(structure.note_created === true && created.has(reference(command.target)),
        'A structural note needs an earlier permitted creation');
      result.notes.push(index);
    }
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  try {
    let input = '';
    for await (const chunk of process.stdin) input += chunk;
    const value = JSON.parse(input), config = value.config;
    const read = address => readJoppa(config.url, config.token_file, 'joppa_objects',
      {workspace: config.workspace, address}, {mcpCommand: config.mcp_command});
    console.log(JSON.stringify(await authorize(value, read)));
  } catch (error) { console.error('Structural publication: ' + error.message); process.exitCode = 1; }
}
