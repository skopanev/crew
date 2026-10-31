// Read live dependency state for one queue check. Store no persistent state.
const invalid = message => Object.assign(new Error(message), {code: 'DEPENDENCY_INVALID'});

const validWorkspaceId = value => typeof value === 'string' && Boolean(value.trim()) &&
  value === value.trim() && !/[\0-\x20\x7f]/.test(value);

const validRemoteLink = (link, ownWorkspace) => Boolean(link && typeof link === 'object' &&
  validWorkspaceId(link.workspace) && (!ownWorkspace || link.workspace !== ownWorkspace) &&
  typeof link.target === 'string' && /^[^:\s]+:[^:\s]+$/.test(link.target));

const currentPin = (pin, current, contract) => Number.isSafeInteger(pin) &&
  Number.isSafeInteger(current) && Number.isSafeInteger(contract) &&
  contract >= 1 && contract <= pin && pin <= current;

const remoteLinkReady = link => {
  const status = link.status;
  if (!status || typeof status !== 'object') return false;
  if (status.access !== true || status.present !== true || status.satisfied !== true) return false;
  if (status.review_required !== false) return false;
  return currentPin(link.revision, status.current_revision,
    status.contract_revision === undefined ? status.current_revision : status.contract_revision);
};

export function remoteDependencyBlocker(object, ownWorkspace = object?.workspace_key) {
  if (!object || typeof object !== 'object') throw invalid('Dependency object is invalid');
  if (ownWorkspace !== undefined && ownWorkspace !== null && !validWorkspaceId(ownWorkspace)) {
    throw invalid('Dependency object workspace_key is invalid');
  }
  if (object.remote_links === undefined || object.remote_links === null) return null;
  if (!Array.isArray(object.remote_links)) throw invalid('Dependency remote_links must be an array');
  for (const link of object.remote_links) {
    if (!link || typeof link !== 'object') throw invalid('Dependency remote link is invalid');
    if (link.blocking === true && link.relation !== 'depends_on') {
      throw invalid('Blocking remote link must use depends_on');
    }
    if (link.relation !== 'depends_on' || link.blocking !== true) continue;
    if (!validRemoteLink(link, ownWorkspace)) throw invalid('Dependency remote link target is invalid');
    if (!remoteLinkReady(link)) return `@${link.workspace}/${link.target}`;
  }
  return null;
}

export function dependencyCheck(read) {
  const objects = new Map(), satisfied = new Map(), checked = new Map();
  let schema, branches, workspaceKey;
  const checkWorkspaceKey = value => {
    if (value === undefined || value === null) return;
    if (!validWorkspaceId(value)) throw invalid('Dependency workspace_key is invalid');
    if (workspaceKey && workspaceKey !== value) throw invalid('Dependency read crossed workspace boundary');
    workspaceKey = value;
  };
  const types = async () => (schema ||= read('joppa_tree', {}).then(result => {
    checkWorkspaceKey(result?.workspace_key);
    return result.schema.types;
  }));
  const object = async address => {
    if (!objects.has(address)) objects.set(address, read('joppa_objects', {address}));
    const value = await objects.get(address);
    if (!value?.address || value.address !== address || !value.document || value.historical !== false ||
        !Number.isSafeInteger(value.current_revision)) {
      throw invalid('Dependency read did not return a current object');
    }
    checkWorkspaceKey(value.workspace_key);
    return value;
  };
  const present = value => value.document.present === true && value.document.data?.archived !== true;
  const role = async value => {
    const configured = (await types())[value.kind];
    if (!configured) throw invalid('Dependency object type is absent from the schema');
    return configured.role;
  };
  async function criterionBranches() {
    if (branches) return branches;
    const definitions = await types();
    branches = new Set(Object.keys(definitions).filter(kind => definitions[kind].role === 'ac'));
    let before;
    do {
      before = branches.size;
      for (const kind of [...branches]) for (const parent of definitions[kind]?.parents || []) {
        if (parent === '*') for (const name of Object.keys(definitions)) branches.add(name);
        else branches.add(parent);
      }
    } while (branches.size !== before);
    return branches;
  }
  async function criteria(address, seen = new Set()) {
    const value = await object(address);
    if (seen.has(value.address)) return null;
    seen.add(value.address);
    if (!present(value)) return [];
    if (await role(value) === 'ac') return [value.address];
    if (!(await criterionBranches()).has(value.kind)) return [];
    const result = [];
    let cursor;
    do {
      const page = await read('joppa_objects', {parent: value.address, limit: 25,
        fields: ['kind', 'present'], ...(cursor ? {cursor} : {})});
      for (const child of page.items) {
        if (child.present !== true) continue;
        if (!(await criterionBranches()).has(child.kind)) continue;
        const nested = await criteria(child.address, seen);
        if (!nested) return null;
        result.push(...nested);
      }
      cursor = page.next_cursor;
    } while (cursor);
    return result;
  }
  async function isSatisfied(value) {
    if (!present(value)) return false;
    if (satisfied.has(value.address)) return satisfied.get(value.address);
    let result;
    if (await role(value) === 'task') {
      result = Boolean(value.process?.done) && !value.process?.retired &&
        value.review_required === false && value.process?.review_required !== true;
    } else {
      const acs = await role(value) === 'ac' ? [value.address] : await criteria(value.address);
      result = Boolean(acs?.length);
      for (let index = 0; result && index < acs.length; index += 100) {
        const batch = acs.slice(index, index + 100);
        const tests = await read('joppa_tests', {ac: batch.join(','), summary: true});
        const statuses = new Map((tests.items || [tests]).map(item => [item.address, item.status]));
        result = batch.every(ac => statuses.get(ac) === 'green');
      }
    }
    satisfied.set(value.address, result);
    return result;
  }
  async function blockedBy(address, trail = new Set()) {
    const start = await object(address);
    if (trail.has(start.address)) return start.address;
    if (checked.has(start.address)) return checked.get(start.address);
    const next = new Set(trail).add(start.address), parents = new Set();
    let node = start;
    while (node) {
      if (!present(node) || parents.has(node.address)) return node.address;
      parents.add(node.address);
      for (const link of node.document.links || []) {
        if (link.relation !== 'depends_on' || link.blocking !== true) continue;
        if (link.workspace !== undefined) throw invalid('Dependency workspace link must use remote_links');
        const target = await object(link.target);
        if (!present(target)) continue;
        const task = await role(target) === 'task';
        const pin = link.revision == null || currentPin(link.revision, target.current_revision, task ? target.process?.origin_revision :
          target.contract_revision === undefined ? target.current_revision : target.contract_revision);
        if (!pin || !await isSatisfied(target)) return target.address;
        const blocker = await blockedBy(target.address, next);
        if (blocker) return blocker;
      }
      const remoteBlocker = remoteDependencyBlocker(node, workspaceKey);
      if (remoteBlocker) return remoteBlocker;
      node = node.document.parent ? await object(node.document.parent) : null;
    }
    checked.set(start.address, null);
    return null;
  }
  return async address => {
    const blocker = await blockedBy(address);
    return {ready: blocker === null, blocker};
  };
}
