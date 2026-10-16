// Read live requirement delivery state for one run and parse publication evidence.
import {createHash} from 'node:crypto';

const require = (condition, message) => {
  if (!condition) throw Object.assign(new Error(message), {code: 'CANDIDATE_INVALID'});
};
const text = value => typeof value === 'string' && value.trim();
const validAddress = value => Boolean(text(value)) && value === value.trim() && value.includes(':') &&
  !/[\0-\x1f\x7f\s]/.test(value) && value.split(':').every(Boolean);
const validBranch = value => Boolean(text(value)) && value === value.trim() && value !== 'HEAD' &&
  !value.startsWith('refs/') && !value.startsWith('-') && !value.startsWith('/') && !value.endsWith('/') &&
  !value.endsWith('.') && !value.endsWith('.lock') && !value.includes('..') && !value.includes('//') &&
  !value.includes('@{') && !/[\0-\x20\x7f~^:?*[\\]/.test(value) &&
  !value.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.lock'));

export function requirementBranch(requirement, repository) {
  require(validAddress(requirement), 'Requirement delivery needs a valid requirement address');
  const repoId = typeof repository === 'string' ? repository : repository?.id;
  require(Boolean(text(repoId)) && repoId === repoId.trim() && !/[\0-\x20\x7f]/.test(repoId),
    'Requirement delivery needs a valid repository ID');
  const branch = 'req/' + createHash('sha256').update(`${requirement}\n${repoId}`).digest('hex').slice(0, 32);
  require(validBranch(branch), 'Generated requirement branch is invalid');
  return branch;
}

export function parsePublication(evidence) {
  require(typeof evidence === 'string' && evidence.trim(), 'Publication evidence is missing');
  const shaLines = [...evidence.matchAll(/^(Landed SHA|Verified existing SHA):(.*)$/gm)];
  const targetLines = [...evidence.matchAll(/^Target:(.*)$/gm)];
  require(shaLines.length === 1 && targetLines.length === 1, 'Publication evidence is missing or ambiguous');
  const [, label, rawSha] = shaLines[0];
  const [, rawTarget] = targetLines[0];
  const shaMatch = /^[ \t]+([0-9a-f]{40}|[0-9a-f]{64})$/.exec(rawSha);
  const targetMatch = /^[ \t]+(\S+)$/.exec(rawTarget);
  require(shaMatch && targetMatch && validBranch(targetMatch[1]), 'Publication evidence SHA or Target is invalid');
  return {
    sha: shaMatch[1],
    target: targetMatch[1],
    kind: label === 'Landed SHA' ? 'landed' : 'verified',
    verified: label === 'Verified existing SHA',
  };
}

export function assertRequirementHead(plan, head) {
  if (!head || plan.publications.some(item => item.sha === head && item.target === plan.branch)) return;
  const error = new Error(`REQUIREMENT_HEAD_UNCONFIRMED: ${plan.branch} at ${head} has no current DONE Task publication`);
  error.code = 'REQUIREMENT_HEAD_UNCONFIRMED';
  throw error;
}

function normalizeClaim(raw) {
  if (raw === null || raw === undefined || raw === false) return null;
  if (typeof raw === 'string') {
    require(Boolean(raw.trim()), 'Planning claim actor is empty');
    return {actor: raw.trim()};
  }
  require(typeof raw === 'object' && !Array.isArray(raw) && Boolean(text(raw.actor)), 'Planning claim is invalid');
  require(raw.position === undefined || (Number.isSafeInteger(raw.position) && raw.position >= 0),
    'Planning claim position is invalid');
  return {actor: raw.actor.trim(), ...(raw.position !== undefined ? {position: raw.position} : {})};
}

function normalizeBlocked(raw) {
  if (!raw) return null;
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return {
      ...(typeof raw.actor === 'string' ? {actor: raw.actor} : {}),
      ...(typeof raw.reason === 'string' ? {reason: raw.reason} : {}),
      ...(Number.isSafeInteger(raw.position) ? {position: raw.position} : {}),
    };
  }
  return Boolean(raw);
}

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
  const cache = new Map();
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
  const present = value => value.document.present === true && value.document.data?.archived !== true;
  const reqObject = await object(requirement);
  require(present(reqObject) && types[reqObject.kind]?.role === 'requirement',
    'Requirement object is not a current present requirement');
  const reqClaim = normalizeClaim(reqObject.process?.planning_claim ?? reqObject.planning_claim);
  const reqProcessRev = Number.isSafeInteger(reqObject.process?.revision) ? reqObject.process.revision : null;

  const criterionBranches = new Set(Object.keys(types).filter(kind => types[kind]?.role === 'ac'));
  const canParentCriteria = new Set();
  let before;
  do {
    before = criterionBranches.size;
    for (const kind of [...criterionBranches]) {
      for (const parent of types[kind]?.parents || []) {
        if (parent === '*') {
          for (const name of Object.keys(types)) {
            criterionBranches.add(name);
            canParentCriteria.add(name);
          }
        } else if (types[parent]) {
          criterionBranches.add(parent);
          canParentCriteria.add(parent);
        }
      }
    }
  } while (criterionBranches.size !== before);

  const criteriaByAddress = new Map();
  const visitedTree = new Set([requirement]);
  async function collectCriteria(parentAddress, parentKind) {
    if (!canParentCriteria.has(parentKind)) return;
    let cursor;
    const cursors = new Set();
    do {
      const page = await read('joppa_objects', {parent: parentAddress, limit: 100, ...(cursor ? {cursor} : {})});
      require(page && Array.isArray(page.items), `Joppa child object page is invalid for ${parentAddress}`);
      for (const item of page.items) {
        require(item && validAddress(item.address) && Boolean(types[item.kind]), 'Joppa child object is invalid');
        const itemPresent = typeof item.present === 'boolean' ? item.present : item.document?.present;
        require(typeof itemPresent === 'boolean', `Joppa child presence is missing: ${item.address}`);
        if (!itemPresent || item.document?.data?.archived === true) continue;
        if (!criterionBranches.has(item.kind)) continue;
        require(!visitedTree.has(item.address), `Criterion tree contains a cycle: ${item.address}`);
        visitedTree.add(item.address);
        if (types[item.kind]?.role === 'ac') {
          const full = await object(item.address);
          if (!present(full)) continue;
          criteriaByAddress.set(item.address, {
            address: item.address,
            revision: full.current_revision,
            process_revision: Number.isSafeInteger(full.process?.revision) ? full.process.revision : null,
            planning_claim: normalizeClaim(full.process?.planning_claim ?? full.planning_claim),
          });
        }
        await collectCriteria(item.address, item.kind);
      }
      cursor = page.next_cursor;
      if (cursor) {
        require(typeof cursor === 'string' && !cursors.has(cursor), 'Joppa child pagination cursor repeated');
        cursors.add(cursor);
      }
    } while (cursor);
  }
  await collectCriteria(requirement, reqObject.kind);

  const taskRepository = value => {
    require(types[value.kind]?.role === 'task', `Object is not a Task: ${value.address}`);
    const data = value.document.data;
    require(data && typeof data.contract === 'string' && data.contract.trim(), `Task contract is missing: ${value.address}`);
    require(data.purpose === undefined || data.purpose === 'implementation', `Task is not an implementation Task: ${value.address}`);
    const declarations = [...data.contract.matchAll(/^Repository:[ \t]*(\S[^\r\n]*)$/gm)].map(match => match[1].trim());
    require(declarations.length === 1 && Boolean(declarations[0]) && !/\s/.test(declarations[0]),
      `Task needs an unambiguous Repository line: ${value.address}`);
    return declarations[0];
  };
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
  const taskStatus = (value, listedStatus) => {
    if (listedStatus === 'done' || listedStatus === 'retired' ||
        value.process?.status === 'done' || value.process?.status === 'retired' ||
        Boolean(value.process?.done) || Boolean(value.process?.retired)) {
      return listedStatus === 'retired' || value.process?.status === 'retired' || Boolean(value.process?.retired) ? 'retired' : 'done';
    }
    if (value.process?.status === 'blocked' || listedStatus === 'blocked' || Boolean(value.process?.blocked)) return 'blocked';
    if (value.process?.status === 'in_progress' || listedStatus === 'in_progress') return 'in_progress';
    if (value.process?.status === 'open' || listedStatus === 'open') return 'open';
    throw Object.assign(new Error(`Task has an invalid process status: ${value.address}`), {code: 'CANDIDATE_INVALID'});
  };
  const taskRecord = (value, status, reviewRequired, finishing) => ({
    address: value.address,
    revision: value.current_revision,
    process_revision: Number.isSafeInteger(value.process?.revision) ? value.process.revision : null,
    origin_revision: Number.isSafeInteger(value.process?.origin_revision) ? value.process.origin_revision : null,
    status,
    blocked: normalizeBlocked(value.process?.blocked),
    review_required: reviewRequired,
    finishing,
  });

  const publications = [];
  const manifestByAddress = new Map();
  const requirementTasksByAddress = new Map();
  for (const [address, own] of ownByAddress) {
    const current = await object(address);
    require(present(current), `Current run Task is absent or archived: ${address}`);
    require(own.revision === undefined || current.current_revision >= own.revision, `Current run Task revision is invalid: ${address}`);
    const status = taskStatus(current);
    const reviewRequired = current.review_required === true || current.process?.review_required === true;
    require(status !== 'done' && status !== 'retired', `Current run Task is already ${status}: ${address}`);
    require(!reviewRequired, `Current run Task needs review: ${address}`);
    require(await requirementAncestor(current, true) === requirement, `Current run Task belongs to a different requirement: ${address}`);
    require(taskRepository(current) === repository, `Current run Task belongs to a different repository: ${address}`);
    manifestByAddress.set(address, {address, revision: current.current_revision, status: 'finishing', finishing: true});
    requirementTasksByAddress.set(address, taskRecord(current, status, false, true));
  }
  let cursor;
  const cursors = new Set();
  do {
    const page = await read('joppa_tasks', {purpose: 'implementation', view: 'all', limit: 100, ...(cursor ? {cursor} : {})});
    require(page && Array.isArray(page.tasks), 'Joppa task page is invalid');
    for (const item of page.tasks) {
      require(item && validAddress(item.address) && Number.isSafeInteger(item.revision) && item.revision > 0,
        'Joppa task list returned an invalid Task');
      if (ownByAddress.has(item.address)) {
        require(item.status !== 'done' && item.status !== 'retired', `Current run Task is already ${item.status}: ${item.address}`);
        require(item.review_required !== true, `Current run Task needs review: ${item.address}`);
        require(item.req == null || item.req === requirement, `Current run Task belongs to a different requirement: ${item.address}`);
        continue;
      }
      if (item.req != null) {
        require(validAddress(item.req), `Joppa task list returned an invalid req address: ${item.address}`);
        if (item.req !== requirement) continue;
      }
      if (item.ac != null && validAddress(item.ac) && !criteriaByAddress.has(item.ac)) continue;
      const current = await object(item.address);
      if (!present(current)) continue;
      if (await requirementAncestor(current, false) !== requirement) continue;
      const status = taskStatus(current, item.status);
      const reviewRequired = current.review_required === true || current.process?.review_required === true || item.review_required === true;
      if (status === 'retired' && (!current.document.data?.contract ||
          [...String(current.document.data.contract).matchAll(/^Repository:[ \t]*(\S[^\r\n]*)$/gm)].length !== 1)) {
        continue;
      }
      if (taskRepository(current) !== repository) continue;
      requirementTasksByAddress.set(current.address, taskRecord(current, status, reviewRequired, false));
      if (status === 'retired') continue;
      if (status === 'done') {
        if (!reviewRequired && current.process?.status === 'done' && !current.process?.retired) {
          try {
            const {sha, target} = parsePublication(current.process.done);
            publications.push({task: current.address, sha, target});
          }
          catch { /* A DONE Task without exact evidence cannot confirm a Requirement head. */ }
        }
        if (reviewRequired) {
          manifestByAddress.set(current.address, {
            address: current.address,
            revision: current.current_revision,
            status: 'review_required',
            review_required: true,
            finishing: false,
          });
        }
        continue;
      }
      manifestByAddress.set(current.address, {
        address: current.address,
        revision: current.current_revision,
        status,
        ...(reviewRequired ? {review_required: true} : {}),
        finishing: false,
      });
    }
    cursor = page.next_cursor;
    if (cursor) {
      require(typeof cursor === 'string' && !cursors.has(cursor), 'Joppa task pagination cursor repeated');
      cursors.add(cursor);
    }
  } while (cursor);
  const criteria = [...criteriaByAddress.values()].sort((a, b) => a.address.localeCompare(b.address));
  const requirementTasks = [...requirementTasksByAddress.values()].sort((a, b) => a.address.localeCompare(b.address));
  const manifest = [...manifestByAddress.values()].sort((a, b) => a.address.localeCompare(b.address));
  const planningHeld = Boolean(reqClaim) || criteria.some(item => Boolean(item.planning_claim));
  const final = !planningHeld && manifest.every(item => item.finishing) &&
    (ownByAddress.size > 0 || requirementTasks.some(item => item.status === 'done'));
  publications.sort((a, b) => a.task.localeCompare(b.task));
  const fingerprint = createHash('sha256').update(JSON.stringify({
    requirement: {address: requirement, revision: reqObject.current_revision, process_revision: reqProcessRev, planning_claim: reqClaim},
    repository,
    criteria,
    tasks: requirementTasks,
    publications,
  })).digest('hex');
  return {branch, requirement, repository, final, planningHeld, fingerprint, manifest, publications};
}
