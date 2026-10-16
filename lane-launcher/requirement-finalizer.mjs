// Select a finalize-only candidate when all Tasks in a requirement unit are done on the requirement branch.
import {parsePublication, requirementBranch, requirementPlan, assertRequirementHead} from './requirement-delivery.mjs';
import {repositoryGit} from './publication-guard.mjs';

const text = value => typeof value === 'string' && value.trim();

function matchesConfiguredProject(config, row, current) {
  const configured = config?.joppa?.project;
  if (!text(configured)) return true;
  const trimmed = configured.trim();
  const short = trimmed.includes(':') ? trimmed.split(':').slice(1).join(':') : trimmed;
  const allowed = new Set([trimmed, short].filter(Boolean));
  for (const list of [row?.projects, current?.projects, current?.document?.data?.projects]) {
    if (Array.isArray(list) && !list.some(item => allowed.has(item))) return false;
  }
  return true;
}

function sameFailedFinalizer(runs, requirement, repository, head, targetHead, fingerprint) {
  for (const prior of runs || []) {
    if (!prior || prior.finalizeOnly !== true || prior.requirement !== requirement) continue;
    const priorRepo = prior.repositoryId || prior.repository?.id || prior.repository ||
      (prior.config?.repositories?.length === 1 ? prior.config.repositories[0]?.id : null);
    if (priorRepo !== repository) continue;
    if (!prior.result || prior.result.completed) continue;
    const failed = prior.result.finalizeFailed || prior.requirementDelivery;
    if (!failed || failed.head !== head || failed.targetHead !== targetHead || failed.fingerprint !== fingerprint) continue;
    if (['MERGE_CONFLICT', 'REQUIREMENT_GATE_FAIL'].includes(prior.result.finalizeFailed?.reasonCode)) return true;
    const finished = Date.parse(prior.result.finishedAt);
    if (Number.isFinite(finished) && Date.now() < finished + 60_000) return true;
  }
  return false;
}

async function ensureCommit(config, repo, sha, branch) {
  try {
    await repositoryGit(config, repo, ['cat-file', '-e', `${sha}^{commit}`]);
    return;
  } catch (error) {
    if (error.code !== 1 && error.code !== 128) throw error;
  }
  try {
    await repositoryGit(config, repo, ['fetch', '--no-write-fetch-head', 'origin', sha]);
  } catch {
    await repositoryGit(config, repo, ['fetch', '--no-write-fetch-head', 'origin', `refs/heads/${branch}`]);
  }
  await repositoryGit(config, repo, ['cat-file', '-e', `${sha}^{commit}`]);
}

async function isAncestor(config, repo, sha, targetHead, branch) {
  await ensureCommit(config, repo, sha, branch);
  if (sha === targetHead) return true;
  try {
    await repositoryGit(config, repo, ['merge-base', '--is-ancestor', sha, targetHead]);
    return true;
  } catch (error) {
    if (error.code === 1) return false;
    throw error;
  }
}

async function listRequirementBranches(config) {
  const byRepo = new Map();
  const allBranches = new Set();
  for (const repo of config.repositories || []) {
    if (!repo || !text(repo.id)) continue;
    const output = await repositoryGit(config, repo, ['ls-remote', 'origin', 'refs/heads/req/*']);
    const branches = new Map();
    for (const line of output.split(/\r?\n/)) {
      const match = /^([0-9a-f]{40}|[0-9a-f]{64})\s+refs\/heads\/(req\/\S+)$/.exec(line.trim());
      if (match) {
        branches.set(match[2], match[1]);
        allBranches.add(match[2]);
      }
    }
    if (branches.size) byRepo.set(repo.id, branches);
  }
  return {byRepo, allBranches};
}

export async function finalizationCandidate({config, read, object, group, rows = [], occupied = new Set(), runs = []}) {
  if (!config || config.delivery !== 'requirement' || !Array.isArray(rows) || !rows.length) return null;
  const doneRows = rows.filter(row => row && text(row.address) && row.status === 'done' &&
    row.review_required !== true && matchesConfiguredProject(config, row, null));
  if (!doneRows.length) return null;

  const {byRepo, allBranches} = await listRequirementBranches(config);
  if (!allBranches.size) return null;

  const targetHeads = new Map();
  const loadTargetHead = async repo => {
    if (!targetHeads.has(repo.id)) {
      const promise = (async () => {
        const targetHead = (await repositoryGit(config, repo, ['ls-remote', 'origin', `refs/heads/${repo.targetBranch}`])).split(/\s/)[0] || '';
        if (targetHead) {
          await repositoryGit(config, repo, ['fetch', '--no-write-fetch-head', 'origin', targetHead]);
          await repositoryGit(config, repo, ['cat-file', '-e', `${targetHead}^{commit}`]);
        }
        return targetHead;
      })();
      targetHeads.set(repo.id, promise);
    }
    return targetHeads.get(repo.id);
  };

  const seenUnits = new Set();
  for (const row of doneRows) {
    let current, context, plan;
    try {
      current = await object(row.address);
      if (!current || current.historical !== false || current.document?.present !== true ||
          current.document.data?.archived === true) continue;
      if (current.process?.status !== 'done' || current.process?.retired ||
          current.review_required === true || current.process?.review_required === true) continue;
      if (!matchesConfiguredProject(config, row, current)) continue;
      let publication;
      try {
        publication = parsePublication(current.process.done);
      } catch {
        continue;
      }
      if (!allBranches.has(publication.target)) continue;

      context = await group(row.address);
      if (!context || !text(context.requirement) || !text(context.repository)) continue;
      const {requirement, repository} = context;
      const unitKey = `${requirement}\n${repository}`;
      if (occupied?.has(unitKey) || seenUnits.has(unitKey)) continue;
      const repo = (config.repositories || []).find(item => item?.id === repository);
      if (!repo) continue;
      const expectedBranch = requirementBranch(requirement, repository);
      if (publication.target !== expectedBranch) continue;
      const head = byRepo.get(repository)?.get(expectedBranch) || '';
      if (!head) continue;
      seenUnits.add(unitKey);

      const targetHead = await loadTargetHead(repo);
      if (!targetHead) continue;
      if (await isAncestor(config, repo, head, targetHead, expectedBranch)) continue;

      plan = await requirementPlan({requirement, repository, finalizeOnly: true, tasks: [], config}, read);
      if (!plan.final || plan.planningHeld) continue;
      assertRequirementHead(plan, head);
      if (sameFailedFinalizer(runs, requirement, repository, head, targetHead, plan.fingerprint)) continue;

      const title = current.document?.data?.title || row.title || `${requirement}: ${repository}`;
      return {
        id: current.address,
        title,
        revision: current.current_revision,
        tasks: [],
        requirement,
        repository,
        finalizeOnly: true,
        requirementDelivery: {...plan, head, targetHead},
      };
    } catch (error) {
      if (['DEPENDENCY_INVALID', 'CANDIDATE_INVALID', 'REQUIREMENT_HEAD_UNCONFIRMED'].includes(error?.code)) {
        console.error(`${row.address}: ${error.message}; skipping this Requirement unit`);
        continue;
      }
      throw error;
    }
  }
  return null;
}
