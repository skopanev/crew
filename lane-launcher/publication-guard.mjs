// Check dependency delivery before a new worker runs any repository code.
import {requirementBranch} from './requirement-delivery.mjs';
import {remoteDependencyBlocker} from './dependencies.mjs';
import {taskContract, taskRepositoryChoice} from './task-contract.mjs';
import {execFile} from 'node:child_process';
import path from 'node:path';
import {quote} from './runtime.mjs';

export function repositoryGit(config, repo, args) {
  const ssh = config.sshDir;
  const env = {...process.env, ...(ssh ? {GIT_SSH_COMMAND: `ssh -F /dev/null -i ${quote(path.join(ssh, 'id_ed25519'))} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=${quote(path.join(ssh, 'known_hosts'))}`} : {})};
  return new Promise((resolve, reject) => execFile('git', ['-C', repo.path, ...args],
    {env, encoding: 'utf8', timeout: 120_000}, (error, output) => error ? reject(error) : resolve(output.trim())));
}

export function publicationReader(config, read) {
  const objects = new Map(), heads = new Map();
  const cached = (tool, args) => {
    const key = JSON.stringify([tool, args]);
    if (!objects.has(key)) objects.set(key, read(tool, args));
    return objects.get(key);
  };
  return run => guardPublications(run, cached, async (repo, sha, branch) => {
    const git = args => repositoryGit(config, repo, args), key = `${repo.id}\n${branch}`;
    if (!heads.has(key)) heads.set(key, (async () => {
      const head = (await git(['ls-remote', 'origin', `refs/heads/${branch}`])).split(/\s/)[0];
      if (head) await git(['fetch', '--no-write-fetch-head', 'origin', head]);
      return head;
    })());
    const head = await heads.get(key);
    if (!head) return false;
    try { await git(['cat-file', '-e', `${sha}^{commit}`]); }
    catch (error) { if (error.code === 1 || error.code === 128) return false; throw error; }
    try { await git(['merge-base', '--is-ancestor', sha, head]); return true; }
    catch (error) { if (error.code === 1) return false; throw error; }
  });
}

export async function guardPublications(run, read, ancestor) {
  const schema = (await read('joppa_tree', {})).schema.types;
  const invalid = message => {
    const error = new Error(`DEPENDENCY_INVALID: ${message}`);
    error.code = 'DEPENDENCY_INVALID';
    throw error;
  };
  const cache = new Map(), visited = new Set();
  let needsReader = false;
  const object = async (address, allowAbsent = false) => {
    if (!cache.has(address)) cache.set(address, read('joppa_objects', {address}));
    const value = await cache.get(address);
    if (!value || value.address !== address || value.historical !== false || !value.document ||
        !allowAbsent && value.document.present !== true) {
      invalid(`Dependency context is absent or historical: ${address}`);
    }
    if (!schema[value.kind]) invalid(`Dependency type is absent from the schema: ${address}`);
    return value;
  };
  const requirement = async value => {
    const seen = new Set();
    while (value) {
      if (seen.has(value.address)) invalid('Dependency parent cycle');
      seen.add(value.address);
      if (schema[value.kind]?.role === 'requirement') return value.address;
      value = value.document.parent ? await object(value.document.parent, true) : null;
    }
    invalid('Dependency Task has no requirement ancestor');
  };
  const pending = message => {
    const error = new Error(`DEPENDENCY_NOT_LANDED: ${message}`);
    error.code = 'DEPENDENCY_NOT_LANDED';
    throw error;
  };
  async function visit(address) {
    if (visited.has(address)) return;
    visited.add(address);
    const value = await object(address);
    needsReader ||= (value.remote_links || []).some(link => link.blocking === true);
    const remote = remoteDependencyBlocker(value);
    if (remote) pending(`${remote} is not current and satisfied`);
    for (const link of value.document.links || []) {
      if (link.relation !== 'depends_on' || link.blocking !== true) continue;
      const target = await object(link.target, true);
      if (schema[target.kind]?.role === 'task') {
        if (target.document.present === true && target.document.data?.stage !== 'done') pending(`${target.address} is not completed`);
        const sha = target.document.data.commit;
        if (!sha) continue;
        if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha)) invalid(`Dependency commit is invalid: ${target.address}`);
        let contract;
        try { contract = taskContract(target.document.data); }
        catch (error) { invalid(`Dependency Task contract is invalid: ${target.address}: ${error.message}`); }
        let repo;
        try { repo = taskRepositoryChoice(run.config, target.document.data); } catch { repo = null; }
        if (!repo) invalid(`Dependency repository is not configured: ${target.address}`);
        const internal = run.config.delivery === 'requirement' && repo.id === run.repository.id &&
          await requirement(target) === run.requirement;
        const branch = internal ? requirementBranch(run.requirement, repo.id) : repo.targetBranch;
        if (!await ancestor(repo, sha, branch)) pending(`${target.address} commit ${sha} is not on ${branch}`);
        continue;
      }
      if (target.document.present !== true) continue;
      await visit(target.address);
    }
    if (value.document.parent) await visit(value.document.parent);
  }
  for (const task of run.claim?.tasks || run.tasks || [{address: run.task}]) await visit(task.address);
  return {needsReader};
}
