// Read live requirement delivery state for one run and parse publication evidence.
import {createHash} from 'node:crypto';
import {repositoryDeclarations} from './task-contract.mjs';
import {nodeAssignee, nodeHold, nodeWaiting} from './joppa-nodes.mjs';

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
      const page = await read('joppa_objects', {parent: parentAddress, depth: 1, limit: 25,
        fields: ['kind', 'present'], ...(cursor ? {cursor} : {})});
      require(page && Array.isArray(page.items), `Joppa child object page is invalid for ${parentAddress}`);
      for (const item of page.items) {
        require(item && validAddress(item.address) && Boolean(types[item.kind]), 'Joppa child object is invalid');
        const itemPresent = typeof item.present === 'boolean' ? item.present : item.document?.present;
        require(typeof itemPresent === 'boolean', `Joppa child presence is missing: ${item.address}`);
        if (!itemPresent) continue;
        if (!criterionBranches.has(item.kind)) continue;
        const full = await object(item.address);
        if (!present(full)) continue;
        require(!visitedTree.has(item.address), `Criterion tree contains a cycle: ${item.address}`);
        visitedTree.add(item.address);
        if (types[item.kind]?.role === 'ac') {
          criteriaByAddress.set(item.address, {
            address: item.address,
            revision: full.current_revision,
            assignee: nodeAssignee(full),
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

export function taskRepository(value, types, expected) {
  require(types[value.kind]?.role === 'task', `Object is not a Task: ${value.address}`);
  const declarations = repositoryDeclarations(value.document.data);
  if (expected && !declarations.includes(expected)) return null;
  require(declarations.length === 1 && Boolean(declarations[0]) && !/\s/.test(declarations[0]),
    `Task needs an unambiguous Repository line: ${value.address}`);
  return declarations[0];
}
export const taskStatus = value => {
  if (value.document.present === false) {
    const commit = value.document.data.commit;
    if (!commit) return 'retired';
    require(typeof commit === 'string' && /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit),
      `Archived Task has an invalid commit: ${value.address}`);
    return 'done';
  }
  if (nodeWaiting(value)) return 'blocked';
  return nodeAssignee(value) ? 'in_progress' : 'open';
};
export const taskRecord = (value, status, finishing) => ({
  address: value.address,
  revision: value.current_revision,
  status,
  assignee: nodeAssignee(value),
  hold: nodeHold(value),
  commit: value.document.data.commit ?? null,
  finishing,
});
