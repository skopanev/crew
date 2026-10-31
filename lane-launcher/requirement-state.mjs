// Read live requirement delivery state for one run and parse publication evidence.
import {createHash} from 'node:crypto';
import {taskContract, taskBody} from './task-contract.mjs';

export const require = (condition, message) => {
  if (!condition) throw Object.assign(new Error(message), {code: 'CANDIDATE_INVALID'});
};
export const text = value => typeof value === 'string' && value.trim();
export const validAddress = value => Boolean(text(value)) && value === value.trim() && value.includes(':') &&
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

export function parsePublication(evidence, commit) {
  require(typeof evidence === 'string' && evidence.trim(), 'Publication evidence is missing');
  const shaLines = [...evidence.matchAll(/^(Landed SHA|Verified existing SHA):(.*)$/gm)];
  const targetLines = [...evidence.matchAll(/^Target:(.*)$/gm)];
  require(shaLines.length === 1 && targetLines.length === 1, 'Publication evidence is missing or ambiguous');
  const [, label, rawSha] = shaLines[0];
  const [, rawTarget] = targetLines[0];
  const shaMatch = /^[ \t]+([0-9a-f]{40}|[0-9a-f]{64})$/.exec(rawSha);
  const targetMatch = /^[ \t]+(\S+)$/.exec(rawTarget);
  require(shaMatch && targetMatch && validBranch(targetMatch[1]), 'Publication evidence SHA or Target is invalid');
  require(commit === undefined || commit === null || commit === shaMatch[1],
    'Task commit differs from its publication evidence');
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

export function normalizeClaim(raw) {
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

export function normalizeBlocked(raw) {
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

export async function collectRequirementCriteria(requirement, requirementKind, types, read, object, present) {
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
      const page = await read('joppa_objects', {parent: parentAddress, limit: 25,
        fields: ['kind', 'present'], ...(cursor ? {cursor} : {})});
      require(page && Array.isArray(page.items), `Joppa child object page is invalid for ${parentAddress}`);
      for (const item of page.items) {
        require(item && validAddress(item.address) && Boolean(types[item.kind]), 'Joppa child object is invalid');
        const itemPresent = typeof item.present === 'boolean' ? item.present : item.document?.present;
        require(typeof itemPresent === 'boolean', `Joppa child presence is missing: ${item.address}`);
        if (!itemPresent || item.document?.data?.archived === true) continue;
        if (!criterionBranches.has(item.kind)) continue;
        const full = await object(item.address);
        if (!present(full)) continue;
        require(!visitedTree.has(item.address), `Criterion tree contains a cycle: ${item.address}`);
        visitedTree.add(item.address);
        if (types[item.kind]?.role === 'ac') {
          criteriaByAddress.set(item.address, {
            address: item.address,
            revision: full.contract_revision ?? full.current_revision,
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
  await collectCriteria(requirement, requirementKind);
  return criteriaByAddress;
}

export function taskRepository(value, types) {
  require(types[value.kind]?.role === 'task', `Object is not a Task: ${value.address}`);
  const data = value.document.data;
  require(data && typeof taskBody(data) === 'string' && taskBody(data).trim(), `Task contract is missing: ${value.address}`);
  const declarations = [...taskContract(data).matchAll(/^Repository:[ \t]*(\S[^\r\n]*)$/gm)].map(match => match[1].trim());
  require(declarations.length === 1 && Boolean(declarations[0]) && !/\s/.test(declarations[0]),
    `Task needs an unambiguous Repository line: ${value.address}`);
  return declarations[0];
}
export const taskStatus = (value, listedStatus) => {
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
export const taskRecord = (value, status, reviewRequired, finishing) => ({
  address: value.address,
  revision: value.current_revision,
  process_revision: Number.isSafeInteger(value.process?.revision) ? value.process.revision : null,
  origin_revision: Number.isSafeInteger(value.process?.origin_revision) ? value.process.origin_revision : null,
  status,
  blocked: normalizeBlocked(value.process?.blocked),
  review_required: reviewRequired,
  finishing,
});
