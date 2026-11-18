// Re-enter Medulla's existing run. Keep every check receipt under its original run identity.
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {repositoryGit} from './publication-guard.mjs';
import {save} from './runtime.mjs';

const require = (condition, message) => { if (!condition) throw new Error(message); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const inside = (child, root) => child.startsWith(root + path.sep);
const plain = (file, root) => {
  require(fs.lstatSync(file).isFile() && inside(fs.realpathSync(file), fs.realpathSync(root)), 'resume evidence is outside its run');
  return fs.readFileSync(file);
};
const json = (file, root) => JSON.parse(plain(file, root));
const parent = (git, head) => {
  const parents = git('show', '-s', '--format=%P', head).split(' ').filter(Boolean);
  require(parents.length === 1, 'landing reuse needs one Task commit');
  return parents[0];
};

// The host records this proof before it releases the failed Task claim.
export function reviewedLanding(run, state, artifacts, git) {
  try {
    const folder = path.dirname(artifacts);
    require(inside(fs.realpathSync(folder), fs.realpathSync(run.runFolder)), 'resume run escaped its folder');
    require(hash(plain(path.join(folder, 'workflow.yaml'), folder)) === run.workflow.digest, 'workflow snapshot changed');
    const journal = plain(path.join(folder, 'journal.jsonl'), folder);
    const decisions = journal.toString().trim().split('\n').filter(Boolean).map(JSON.parse);
    const clear = decisions.findLast(row => row.node === 'expert_review_synthesis');
    require(clear?.signal === 'CLEAR' && clear.next === 'git_landing', 'review did not clear landing');
    require(!decisions.some(row => row.step > clear.step &&
      ['implement_code', 'prepare_review', 'expert_review', 'git_fix'].includes(row.node)), 'work continued after review');
    const snapshot = plain(path.join(artifacts, 'reviewed-tree.txt'), folder);
    const [tree, head] = snapshot.toString().trim().split('\n');
    require(/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(head) && git('rev-parse', head + '^{tree}') === tree,
      'reviewed snapshot differs from Git');
    const base = parent(git, head);
    if (state.head !== head) {
      parent(git, state.head);
      require(git('show', '--format=', '--binary', state.head) === git('show', '--format=', '--binary', head),
        'Task patch changed after review');
    }
    const gates = path.join(artifacts, 'gates');
    const pointer = json(path.join(gates, 'current.json'), folder);
    const receiptBytes = plain(pointer.receipt, gates), receipt = JSON.parse(receiptBytes);
    require(hash(receiptBytes) === pointer.sha256 && receipt.passed === true && receipt.tree === tree &&
      receipt.task === run.executionId && receipt.run === folder, 'gate receipt does not cover the reviewed run');
    require(receipt.commands?.length && receipt.checks?.length === receipt.commands.length &&
      receipt.checks.every((check, i) => check.exit_code === 0 && check.stdout_matches !== false &&
        JSON.stringify(check.command) === JSON.stringify(receipt.commands[i]) &&
        hash(plain(check.log, path.dirname(pointer.receipt))) === check.sha256), 'gate checks are incomplete');
    require(git('rev-parse', receipt.candidate_sha + '^{tree}') === tree, 'checked Git object is missing');
    return {head, tree, base, snapshot: hash(snapshot), journal: hash(journal), receipt: pointer.sha256};
  } catch { return null; }
}

// A rebase can add incoming commits to lane-base..HEAD. Its single Task commit remains the scope.
export async function landingReuse(run, prior, state, artifacts, git) {
  const canonical = args => repositoryGit(run.config, run.repository, args);
  const branch = run.config.delivery === 'branch' ? prior.deliveryBranch : run.repository.targetBranch;
  require(branch, 'landing reuse has no target branch');
  const remote = (await canonical(['ls-remote', 'origin', `refs/heads/${branch}`])).split(/\s/)[0];
  require(/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(remote), 'landing target is absent');
  await canonical(['fetch', '--no-write-fetch-head', 'origin', remote]);
  const proof = reviewedLanding(prior, state, artifacts, git);
  const candidateBase = parent(git, state.head);
  await canonical(['fetch', '--no-write-fetch-head', state.checkout, state.head, ...(proof ? [proof.head] : [])]);
  const landed = async sha => {
    try { await canonical(['merge-base', '--is-ancestor', sha, remote]); return true; }
    catch (error) { if (error.code === 1) return false; throw error; }
  };
  require(await landed(candidateBase), 'retained candidate has unpublished work before its Task commit');
  const files = git('diff', '-z', '--no-renames', '--name-only', candidateBase, state.head).split('\0').filter(Boolean);
  if (!proof || JSON.stringify(proof) !== JSON.stringify(prior.retained.landing)) return {files, route: 'review'};
  require(await landed(proof.base), 'reviewed Task parent is not on target');
  const published = await landed(state.head) ? state.head : await landed(proof.head) ? proof.head : null;
  return {files, route: 'landing', resume: {folder: prior.runFolder, run: path.dirname(artifacts),
    node: published ? 'cleanup' : 'git_landing', head: published || proof.head, proof, remote}};
}

export function prepareLanding(run, dir, reuse, git) {
  const {resume} = reuse, artifacts = path.join(resume.run, 'artifacts');
  require(git('rev-parse', 'HEAD') === reuse.retained.head &&
    !git('status', '--porcelain', '--untracked-files=all'), 'retained candidate changed before resume');
  const archive = path.join(dir, 'resume-prior');
  fs.mkdirSync(archive, {mode: 0o700});
  for (const name of ['claim.json', 'ticket.json', 'origin.json', 'failure.txt', 'landing-log.txt',
    'landing.txt', 'verification.txt', 'outcome.txt']) {
    const source = path.join(artifacts, name);
    if (fs.existsSync(source)) fs.writeFileSync(path.join(archive, name), plain(source, resume.run), {flag: 'wx', mode: 0o600});
  }
  for (const name of ['vars.yaml', 'outcome.json']) {
    fs.writeFileSync(path.join(archive, name), plain(path.join(resume.run, name), resume.run), {flag: 'wx', mode: 0o600});
  }
  const recovery = `refs/heads/recovery/retained-${path.basename(dir)}`;
  const checkout = path.join(run.config.worktreeRoot, run.executionId);
  plain(path.join(checkout, '.git/lane-base'), checkout);
  git('update-ref', recovery, reuse.retained.head, '0'.repeat(reuse.retained.head.length));
  git('reset', '--hard', resume.head);
  const base = parent(git, resume.head);
  fs.writeFileSync(path.join(checkout, '.git/lane-base'), base + '\n');
  run.runFolder = resume.folder;
  run.resume = {run: resume.run, node: resume.node, previousRun: reuse.retained.previousRun, recovery};
  run.claim.ticket = {...run.claim.ticket, retained: {...reuse.retained, head: resume.head,
    tree: git('rev-parse', 'HEAD^{tree}'), base, landing: resume.proof}};
  save(path.join(artifacts, 'claim.json'), {...run.claim, workspace: run.workspace,
    joppa_url: run.config.joppa.url, run_dir: resume.run});
  for (const name of ['origin.json', 'failure.txt', 'landing.txt', 'verification.txt', 'outcome.txt']) {
    fs.rmSync(path.join(artifacts, name), {force: true});
  }
  return resume.head;
}

// YAML merge keys preserve all old values without another parser. Medulla flattens this map on entry.
export function resumeArguments(runDir, node, args) {
  require(['git_landing', 'cleanup'].includes(node), 'invalid retained resume node');
  const file = path.join(runDir, 'vars.yaml'), old = plain(file, runDir).toString();
  require(old.trim() && !/^---|^\.\.\./m.test(old), 'unsupported vars document');
  const updates = {}, filtered = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--var') {
      const value = args[++i], match = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(value || '');
      require(match, 'invalid resume variable');
      updates[match[1]] = match[2];
    } else {
      require(!['--run', '--resume', '--node', '--var-file'].includes(args[i]), 'resume arguments contain another run or variable file');
      filtered.push(args[i]);
    }
  }
  const text = '<<:\n' + old.trimEnd().split('\n').map(line => '  ' + line).join('\n') + '\n' +
    Object.entries(updates).map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join('\n') + '\n';
  const temporary = file + '.resume-' + randomUUID();
  try { fs.writeFileSync(temporary, text, {flag: 'wx', mode: 0o600}); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, {force: true}); }
  return [...filtered, '--run', runDir, '--node', node];
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(resumeArguments(process.argv[2], process.argv[3], process.argv.slice(4)))); }
  catch (error) { console.error(`retained resume: ${error.message}`); process.exitCode = 2; }
}
