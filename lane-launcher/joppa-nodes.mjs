// Generic Joppa node reads and revision-checked document saves.
const require = (condition, message) => { if (!condition) throw new Error(message); };
export const NODE_TONES = ['red', 'yellow', 'orange', 'grey', 'green', 'purple'];

export const nodeAssignee = node => node.document?.data?.assignee ?? node.data?.assignee ?? node['data.assignee'] ?? null;
export const nodeWaiting = node => (node.process?.assessment ?? node['process.assessment'])?.state === 'waiting';

export function saveNode(node, changes, reason, question) {
  require(node.historical === false && node.document?.present === true &&
    Number.isSafeInteger(node.current_revision) && node.current_revision > 0,
  'A node save requires a current, present document');
  const separator = node.address?.indexOf(':');
  require(separator > 0, 'A node save requires its full address');
  const data = structuredClone(node.document.data);
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete data[key];
    else data[key] = value;
  }
  return {op: 'save_object', kind: node.address.slice(0, separator), id: node.address.slice(separator + 1),
    revision: node.current_revision, parent: node.document.parent, data,
    links: structuredClone(node.document.links || []), reason,
    ...(question ? {question_checked: question} : {})};
}

export async function roleKinds(read, role) {
  const types = (await read('joppa_tree', {}))?.schema?.types;
  require(types && typeof types === 'object', 'Joppa tree schema is missing');
  const kinds = Object.keys(types).filter(kind => types[kind].role === role);
  require(kinds.length > 0, `Joppa tree has no ${role} type`);
  return kinds;
}

export async function* nodePages(read, filters) {
  let cursor;
  const seen = new Set();
  do {
    const page = await read('joppa_objects', {parent: '*', ...filters, limit: 25, ...(cursor ? {cursor} : {})});
    require(Array.isArray(page?.items), 'Joppa node page is incomplete');
    yield page;
    cursor = page.next_cursor;
    if (cursor) {
      require(typeof cursor === 'string' && !seen.has(cursor), 'Joppa node pagination did not advance');
      seen.add(cursor);
    }
  } while (cursor);
}

export async function* taskPages(read, filters = {}) {
  yield* nodePages(read, {kind: await roleKinds(read, 'task'),
    fields: ['title', 'revision', 'parent', 'present', 'data.assignee', 'data.commit', 'data.priority', 'data.projects',
      'work_ready', 'process.assessment'],
    ...filters});
}

export function taskMatchesProject(config, node) {
  const project = config.joppa.project, short = project.slice(project.indexOf(':') + 1);
  const projects = node.document?.data?.projects ?? node.data?.projects ?? node['data.projects'];
  return Array.isArray(projects) && projects.some(value => value === project || value === short);
}
