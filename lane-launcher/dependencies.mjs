// Read live dependency state for one queue check. Store no persistent state.
export function dependencyCheck(read) {
  const objects = new Map(), satisfied = new Map(), checked = new Map();
  let schema, branches;
  const types = async () => (schema ||= read('joppa_tree', {})).then(result => result.schema.types);
  const object = async address => {
    if (!objects.has(address)) objects.set(address, read('joppa_objects', {address}));
    const value = await objects.get(address);
    if (!value?.address || !value.document || value.historical !== false || !Number.isSafeInteger(value.current_revision)) {
      throw new Error('Dependency read did not return a current object');
    }
    return value;
  };
  const present = value => value.document.present === true && value.document.data?.archived !== true;
  const role = async value => {
    const configured = (await types())[value.kind];
    if (!configured) throw new Error('Dependency object type is absent from the schema');
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
      const page = await read('joppa_objects', {parent: value.address, limit: 100, ...(cursor ? {cursor} : {})});
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
        const tests = await read('joppa_tests', {ac: batch.join(',')});
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
        const target = await object(link.target);
        if (!present(target)) continue;
        const task = await role(target) === 'task';
        const pin = Number.isSafeInteger(link.revision) && (task ?
          target.process?.origin_revision >= 1 && target.process.origin_revision <= link.revision &&
            link.revision <= target.current_revision : link.revision === target.current_revision);
        if (!pin || !await isSatisfied(target)) return target.address;
        const blocker = await blockedBy(target.address, next);
        if (blocker) return blocker;
      }
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
