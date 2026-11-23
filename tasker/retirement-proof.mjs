// Check supplied retirement facts. Critics must still verify their semantic completeness.
import {execFileSync} from 'node:child_process';
import path from 'node:path';

const sha = value => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const safePath = value => typeof value === 'string' && value.length > 0 && !path.isAbsolute(value) &&
  !/[\\\0\r\n\t:]/.test(value) && !value.split('/').some(part => ['', '.', '..', '.git'].includes(part));
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args],
  {encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe']});
const trivia = String.raw`(?:\s|/\*[\s\S]*?\*/|//[^\r\n\u2028\u2029]*(?:[\r\n\u2028\u2029]|$))*`;
// A raw veto can reject valid comments or strings. It never establishes completeness.
const unsupported = new RegExp(String.raw`\bexport${trivia}(?:\{|\*|type\b|interface\b|import\b)`);
const scanner = `const source=await Bun.stdin.text();
console.log(JSON.stringify(new Bun.Transpiler({loader:process.argv[1]}).scan(source).exports));`;

function repository(input, trees) {
  const node = input?.selected, data = node?.document?.data || {};
  const field = input?.schema?.types?.[node?.kind]?.fields?.repository;
  const allowed = field?.type === 'enum' ? field.values : Object.keys(trees || {});
  if (!Array.isArray(allowed)) return null;
  if (typeof data.repository === 'string' && data.repository && allowed.includes(data.repository)) return data.repository;
  if (data.repository != null && data.repository !== '') return null;
  const lines = String(data.body || '').split(/\r?\n/).filter(line => line.startsWith('Repository:'));
  const value = lines.length === 1 ? lines[0].slice('Repository: '.length) : '';
  return value && lines[0] === 'Repository: ' + value && allowed.includes(value) ? value : null;
}

function obligations(input) {
  const lines = String(input?.selected?.document?.data?.body || '').split(/\r?\n/);
  const starts = lines.flatMap((line, index) => line.trim() === 'Do:' ? [index] : []);
  if (starts.length !== 1) return [];
  const end = lines.findIndex((line, index) => index > starts[0] && /^Checks:/.test(line));
  return lines.slice(starts[0] + 1, end < 0 ? undefined : end).filter(line => line.trim());
}

export function retirementRequired(repair, draft) {
  return draft?.verdict === 'STALE' && (!repair?.ac_text_changed || draft.needs_code === false);
}

export function retirementBinding(input, trees) {
  const repo = repository(input, trees);
  return {task: input?.selected?.address ?? null, revision: input?.selected?.current_revision ?? null,
    repository: repo, develop: trees?.[repo]?.sha ?? null, obligations: obligations(input)};
}

function exportNames(source, file) {
  if (unsupported.test(source)) throw new Error('unsupported export clause, re-export or type declaration');
  const extension = path.extname(file).toLowerCase();
  const loader = ['.ts', '.mts', '.cts'].includes(extension) ? 'ts' : extension === '.tsx' ? 'tsx' :
    extension === '.jsx' ? 'jsx' : ['.js', '.mjs', '.cjs'].includes(extension) ? 'js' : null;
  if (!loader) throw new Error('unsupported export language');
  return JSON.parse(execFileSync(process.env.TASKER_BUN || 'bun', ['-e', scanner, loader],
    {input: source, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe']}));
}

export function retirementProblems({input, repair, draft, trees, reviews, digest}) {
  if (!retirementRequired(repair, draft)) return [];
  const problems = [], fail = message => problems.push('Retirement proof: ' + message);
  const binding = retirementBinding(input, trees), proof = draft?.retirement_proof;
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return ['Retirement proof: retirement_proof is required'];
  for (const key of ['task', 'revision', 'repository', 'develop']) {
    if (binding[key] == null || proof[key] !== binding[key]) fail('wrong or unavailable ' + key + ' binding');
  }
  if (!Number.isSafeInteger(binding.revision) || binding.revision < 1) fail('original Task revision is invalid');
  if (!sha(binding.develop)) fail('develop must name an exact snapshot commit');
  if (!binding.obligations.length || !same(proof.obligations, binding.obligations)) fail('copy every captured Do obligation verbatim');
  if (typeof draft.needs_code !== 'boolean') fail('needs_code must be boolean');
  if (reviews !== undefined) {
    if (!/^[0-9a-f]{64}$/.test(digest || '') || !Array.isArray(reviews) || reviews.length !== 2) {
      fail('two digest-bound completeness reviews are required');
    } else for (const [index, review] of reviews.entries()) {
      const checked = review?.checks?.already_in_develop;
      if (review?.draft_digest !== digest || review?.verdict !== 'APPROVE' || checked?.ok !== true ||
          checked.task_deliverables_complete !== true) fail('review ' + (index + 1) + ' does not confirm all Task deliverables');
    }
  }
  const files = proof.files;
  if (!Array.isArray(files) || files.length < 1 || files.length > 32) fail('files must contain 1 to 32 deliverable files');
  else {
    const seen = new Set();
    for (const file of files) {
      if (!file || !safePath(file.path) || seen.has(file.path)) fail('deliverable paths must be safe, relative and unique');
      seen.add(file?.path);
      if (!Array.isArray(file?.exports) || file.exports.length > 64 || new Set(file.exports).size !== file.exports.length ||
          file.exports.some(name => typeof name !== 'string' || !/^[A-Za-z_$][\w$]*$/.test(name))) {
        fail('exports must list unique runtime export names');
      }
    }
  }
  if (typeof draft.done_commit !== 'string' || !/^[0-9a-f]{7,40}$/.test(draft.done_commit)) fail('done_commit is required');
  if (problems.length) return problems;
  const tree = trees[binding.repository], repo = tree.repo || tree.path;
  try {
    const done = git(repo, 'rev-parse', '--verify', draft.done_commit + '^{commit}').trim();
    git(repo, 'merge-base', '--is-ancestor', done, binding.develop);
    for (const commit of new Set([done, binding.develop])) for (const file of files) {
      try {
        const entry = git(repo, 'ls-tree', '-z', commit, '--', file.path);
        if (!/^100(?:644|755) blob /.test(entry)) throw new Error('not a tracked regular file');
        const source = git(repo, 'show', commit + ':' + file.path);
        if (file.exports.length) {
          const names = exportNames(source, file.path);
          const missing = file.exports.filter(name => !names.includes(name));
          if (missing.length) throw new Error('missing runtime exports ' + missing.join(', '));
        }
      } catch (error) {
        const detail = error instanceof Error && !('status' in error) ? error.message : 'Git or source scanner failed';
        fail(file.path + ' at ' + commit + ': ' + detail);
      }
    }
  } catch { fail('done_commit is absent or is not an ancestor in the selected repository'); }
  return problems;
}
