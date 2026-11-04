// Read live delivery state for one run. Keep public imports stable.
import {createHash} from 'node:crypto';
import {remoteDependencyBlocker} from './dependencies.mjs';
import {taskBody} from './task-contract.mjs';
import {require, validAddress, requirementBranch,
  collectRequirementCriteria, taskRepository, taskStatus, taskRecord} from './requirement-state.mjs';
import {nodeAssignee, taskPages, NODE_TONES} from './joppa-nodes.mjs';
export {requirementBranch, parsePublication, assertRequirementHead} from './requirement-state.mjs';

export async function requirementPlan(run, read) {
  require(run && typeof run === 'object' && typeof read === 'function', 'Requirement delivery needs run and read');
  const requirement = run.requirement;
  const repository = typeof run.repository === 'string'
    ? run.repository
    : (run.repository?.id || run.repositoryId || run.claim?.ticket?.repository);
  const branch = requirementBranch(requirement, repository);
  if (Array.isArray(run.config?.repositories)) {
    require(run.config.repositories.some(repo => repo?.id === repository), 'Requirement delivery repository is not configured');
  }
  const rawOwn = run.claim?.tasks || run.tasks || (run.task ? [{address: run.task, revision: run.taskRevision}] : []);
  require(Array.isArray(rawOwn) && (rawOwn.length > 0 || run.finalizeOnly === true),
    'Requirement delivery needs current run Tasks or finalizeOnly');
  const ownByAddress = new Map();
  for (const item of rawOwn) {
    const entry = typeof item === 'string' ? {address: item} : item;
    require(entry && validAddress(entry.address), 'Current run Task needs a valid address');
    require(!ownByAddress.has(entry.address), 'Current run contains duplicate Tasks');
    require(entry.revision === undefined || (Number.isSafeInteger(entry.revision) && entry.revision > 0),
      'Current run Task needs a valid revision');
    ownByAddress.set(entry.address, entry);
  }
  const types = (await read('joppa_tree', {}))?.schema?.types;
  require(types && typeof types === 'object', 'Joppa schema types are missing');
  const cache = new Map(), relevant = new Map();
  const object = async address => {
    require(validAddress(address), 'Joppa object address is invalid');
    if (!cache.has(address)) cache.set(address, read('joppa_objects', {address}));
    const value = await cache.get(address);
    require(value && value.address === address && value.historical === false &&
      value.document && typeof value.document.present === 'boolean' &&
      Number.isSafeInteger(value.current_revision) && value.current_revision > 0 &&
      Boolean(types[value.kind]), `Joppa object is absent, historical, or invalid: ${address}`);
    return value;
  };
  const remember = async value => {
    const seen = new Set();
    while (value && !relevant.has(value.address)) {
      require(!seen.has(value.address), 'Remote dependency parent cycle');
      seen.add(value.address);
      const remote = remoteDependencyBlocker(value);
      require(!remote, `Remote dependency is not current and satisfied: ${remote}`);
      relevant.set(value.address, value);
      value = value.document.parent ? await object(value.document.parent) : null;
    }
  };
  const present = value => value.document.present === true;
  const reqObject = await object(requirement);
  require(present(reqObject) && types[reqObject.kind]?.role === 'requirement',
    'Requirement object is not a current present requirement');
  await remember(reqObject);
  const reqAssignee = nodeAssignee(reqObject);

  const criteriaByAddress = await collectRequirementCriteria(requirement, reqObject.kind, types, read, object, present);
  const requirementAncestor = async (value, strict = false) => {
    require(types[value.kind]?.role === 'task', `Object is not a Task: ${value.address}`);
    const seen = new Set([value.address]);
    let parentAddress = value.document.parent;
    while (parentAddress) {
      require(!seen.has(parentAddress), `Task parent context contains a cycle: ${value.address}`);
      seen.add(parentAddress);
      const parent = await object(parentAddress);
      if (!present(parent)) {
        require(!strict, `Task parent context is absent or historical: ${parentAddress}`);
        return null;
      }
      if (types[parent.kind]?.role === 'requirement') return parent.address;
      parentAddress = parent.document.parent;
    }
    require(!strict, `Task has no requirement ancestor: ${value.address}`);
    return null;
  };
  const publications = [];
  const manifestByAddress = new Map();
  const requirementTasksByAddress = new Map();
  for (const [address, own] of ownByAddress) {
    const current = await object(address);
    require(present(current), `Current run Task is absent or archived: ${address}`);
    require(own.revision === undefined || current.current_revision >= own.revision, `Current run Task revision is invalid: ${address}`);
    const status = taskStatus(current);
    require(status !== 'done' && status !== 'retired', `Current run Task is already ${status}: ${address}`);
    require(await requirementAncestor(current, true) === requirement, `Current run Task belongs to a different requirement: ${address}`);
    require(taskRepository(current, types) === repository, `Current run Task belongs to a different repository: ${address}`);
    await remember(current);
    manifestByAddress.set(address, {address, revision: current.current_revision, status: 'finishing', finishing: true});
    requirementTasksByAddress.set(address, taskRecord(current, status, true));
  }
  for await (const page of taskPages(read, {parent: requirement, status: NODE_TONES})) {
    for (const item of page.items) {
      require(item && validAddress(item.address) && Number.isSafeInteger(item.revision) && item.revision > 0,
        'Joppa task list returned an invalid Task');
      if (ownByAddress.has(item.address)) {
        require(item.present === true && (await object(item.address)).current_revision === item.revision,
          `Current run Task changed while reading delivery state: ${item.address}`);
        continue;
      }
      const current = await object(item.address);
      require(current.current_revision === item.revision, `Task changed while reading delivery state: ${item.address}`);
      if (await requirementAncestor(current, false) !== requirement) continue;
      const status = taskStatus(current);
      if (status === 'retired' && (!taskBody(current.document.data) ||
          !Object.hasOwn(current.document.data, 'steps') &&
          [...String(taskBody(current.document.data)).matchAll(/^Repository:[ \t]*(\S[^\r\n]*)$/gm)].length !== 1)) {
        continue;
      }
      if (taskRepository(current, types) !== repository) continue;
      requirementTasksByAddress.set(current.address, taskRecord(current, status, false));
      if (status === 'retired') continue;
      await remember(current);
      if (status === 'done') {
        publications.push({task: current.address, sha: current.document.data.commit, target: branch});
        continue;
      }
      manifestByAddress.set(current.address, {
        address: current.address,
        revision: current.current_revision,
        status,
        finishing: false,
      });
    }
  }
  const criteria = [...criteriaByAddress.values()].sort((a, b) => a.address.localeCompare(b.address));
  const requirementTasks = [...requirementTasksByAddress.values()].sort((a, b) => a.address.localeCompare(b.address));
  const manifest = [...manifestByAddress.values()].sort((a, b) => a.address.localeCompare(b.address));
  const planningHeld = Boolean(reqAssignee) || criteria.some(item => Boolean(item.assignee));
  const final = !planningHeld && manifest.every(item => item.finishing) &&
    (ownByAddress.size > 0 || requirementTasks.some(item => item.status === 'done'));
  publications.sort((a, b) => a.task.localeCompare(b.task));
  const remoteLinks = [...relevant.values()].filter(item => item.remote_links?.length || item.remote_links_revision > 0)
    .map(item => ({address: item.address, revision: item.remote_links_revision || 0,
      links: (item.remote_links || []).map(({status, ...link}) => link)}))
    .sort((a, b) => a.address.localeCompare(b.address));
  const fingerprint = createHash('sha256').update(JSON.stringify({
    requirement: {address: requirement, revision: reqObject.current_revision, assignee: reqAssignee},
    repository,
    criteria,
    tasks: requirementTasks,
    publications,
    ...(remoteLinks.length ? {remote_links: remoteLinks} : {}),
  })).digest('hex');
  return {branch, requirement, repository, final, planningHeld, fingerprint, manifest, publications};
}
