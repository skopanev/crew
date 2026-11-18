import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {recordRetained, retainedCheckout, retainedLine, prepareReuse} from '../retained-checkout.mjs';
import {resumeArguments} from '../retained-landing.mjs';
import {writeLaunchClaim} from '../joppa-claims.mjs';
import {git, reuseFixture} from '../test-support/retained-checkout.fixture.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function landingFixture(t) {
  const x = await reuseFixture(t, {node: 'git_landing', signal: 'OVER_TIME'});
  const folder = path.dirname(x.artifacts), head = git(x.checkout, 'rev-parse', 'HEAD');
  const tree = git(x.checkout, 'rev-parse', 'HEAD^{tree}'), base = git(x.checkout, 'rev-parse', 'HEAD^');
  const remote = path.join(x.f.root, 'remote.git');
  git(x.f.root, 'clone', '-q', '--bare', x.checkout, remote);
  git(remote, 'update-ref', 'refs/heads/main', base);
  git(x.checkout, 'remote', 'set-url', 'origin', remote);
  git(x.run.repository.path, 'remote', 'set-url', 'origin', remote);
  fs.copyFileSync(x.run.workflow.file, path.join(folder, 'workflow.yaml'));
  fs.writeFileSync(path.join(folder, 'vars.yaml'), 'MARK: old\n');
  fs.writeFileSync(path.join(folder, 'outcome.json'), JSON.stringify({outcome: 'failed'}));
  fs.writeFileSync(path.join(folder, 'journal.jsonl'), JSON.stringify({step: 9, node: 'expert_review_synthesis',
    kind: 'decision', signal: 'CLEAR', next: 'git_landing'}) + '\n');
  fs.writeFileSync(path.join(x.artifacts, 'reviewed-tree.txt'), `${tree}\n${head}\n`);
  const gates = path.join(x.artifacts, 'gates'), checks = path.join(gates, 'pass');
  fs.mkdirSync(checks, {recursive: true});
  const log = path.join(checks, '1.log'); fs.writeFileSync(log, 'passed\n');
  const receipt = {passed: true, task: x.run.executionId, run: folder, tree, base, candidate_sha: head,
    commands: ['true'], checks: [{command: 'true', exit_code: 0, log, sha256: hash(fs.readFileSync(log))}]};
  const receiptFile = path.join(checks, 'receipt.json'); fs.writeFileSync(receiptFile, JSON.stringify(receipt));
  const pointer = path.join(gates, 'current.json');
  fs.writeFileSync(pointer, JSON.stringify({receipt: receiptFile, sha256: hash(fs.readFileSync(receiptFile))}));
  x.prior.result.publicationUncertain = true;
  const record = () => {
    x.prior.retained = recordRetained(x.prior, x.artifacts);
    x.note.text = x.note.text.replace(/^Checkout:.*$/m, retainedLine(x.prior.retained));
    x.f.objects.get('task:t1').annotations.comments[x.note.id].text = x.note.text;
    x.savePrior();
  };
  record();
  return {...x, folder, head, tree, base, remote, receiptFile, log, pointer, record};
}

test('a cleared landing re-enters the original run with a fresh claim and unchanged receipts', async t => {
  const x = await landingFixture(t), receipt = fs.readFileSync(x.receiptFile);
  const oldClaim = {assignee: 'crew-lane:old'};
  fs.writeFileSync(path.join(x.artifacts, 'claim.json'), JSON.stringify(oldClaim));
  fs.writeFileSync(path.join(x.prior.runFolder, 'launch-claim.json'), JSON.stringify(oldClaim));
  fs.writeFileSync(path.join(x.artifacts, 'landing-log.txt'), 'old failed landing\n');
  const reuse = await retainedCheckout(x.run, x.dir);
  assert.equal(reuse.retained.route, 'landing');
  assert.equal(reuse.resume.run, x.folder);
  assert.equal(reuse.resume.node, 'git_landing');
  const lines = [];
  assert.equal(await prepareReuse(x.run, x.dir, l => lines.push(l), () => {}), x.head);
  assert.equal(x.run.runFolder, x.prior.runFolder);
  assert.equal(x.run.resume.run, x.folder);
  assert.match(lines[0], /node git_landing$/);
  assert.deepEqual(fs.readFileSync(x.receiptFile), receipt);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(x.dir, 'resume-prior/claim.json'))), oldClaim);
  const claim = JSON.parse(fs.readFileSync(path.join(x.artifacts, 'claim.json')));
  assert.equal(claim.assignee, 'crew-lane:new');
  assert.equal(claim.run_dir, x.folder);
  const launch = writeLaunchClaim(x.run, x.dir);
  assert.notEqual(launch, path.join(x.prior.runFolder, 'launch-claim.json'));
  assert.equal(JSON.parse(fs.readFileSync(launch)).assignee, 'crew-lane:new');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(x.prior.runFolder, 'launch-claim.json'))), oldClaim);
  assert.equal(fs.existsSync(path.join(x.artifacts, 'failure.txt')), false);
  assert.equal(fs.readFileSync(path.join(x.dir, 'resume-prior/landing-log.txt'), 'utf8'), 'old failed landing\n');
});

test('an unchanged Task patch after rebase restores the actual reviewed commit and keeps the rebased head', async t => {
  const x = await landingFixture(t);
  git(x.checkout, 'checkout', '-q', '-b', 'incoming', x.base);
  fs.writeFileSync(path.join(x.checkout, 'incoming.txt'), 'new target code\n');
  git(x.checkout, 'add', 'incoming.txt'); git(x.checkout, 'commit', '-qm', 'incoming');
  const target = git(x.checkout, 'rev-parse', 'HEAD');
  git(x.checkout, 'push', '-q', x.remote, 'HEAD:main');
  git(x.checkout, 'checkout', '-q', `ticket-${x.run.executionId}`);
  git(x.checkout, 'rebase', target);
  const rebased = git(x.checkout, 'rev-parse', 'HEAD');
  assert.notEqual(rebased, x.head);
  x.record();
  assert.ok(x.prior.retained.landing);
  assert.equal((await retainedCheckout(x.run, x.dir)).retained.route, 'landing');
  assert.equal(await prepareReuse(x.run, x.dir, () => {}, () => {}), x.head);
  assert.equal(git(x.checkout, 'rev-parse', 'HEAD'), x.head);
  assert.equal(git(x.checkout, 'rev-parse', x.run.resume.recovery), rebased);
  assert.equal(fs.existsSync(path.join(x.checkout, 'incoming.txt')), false);
  // The actual landing fetches and rebases normally; no old receipt is assigned to the rebased tree.
  assert.equal(JSON.parse(fs.readFileSync(x.receiptFile)).tree, x.tree);
});

test('a Task commit already on the remote re-enters cleanup without another push', async t => {
  const x = await landingFixture(t);
  git(x.checkout, 'push', '-q', x.remote, 'HEAD:main');
  const reuse = await retainedCheckout(x.run, x.dir);
  assert.equal(reuse.retained.route, 'landing');
  assert.equal(reuse.resume.node, 'cleanup');
  assert.equal(reuse.resume.head, x.head);
});

test('branch delivery keeps its existing review route instead of resuming a different publication branch', async t => {
  const x = await landingFixture(t);
  x.run.config.delivery = 'branch'; x.prior.config.delivery = 'branch';
  x.run.deliveryBranch = 'new-branch'; x.prior.deliveryBranch = 'old-branch'; x.savePrior();
  const reuse = await retainedCheckout(x.run, x.dir);
  assert.equal(reuse.retained.route, 'review');
  assert.equal(reuse.resume, undefined);
});

test('missing approval or changed gate evidence requires review again', async t => {
  const x = await landingFixture(t);
  fs.appendFileSync(x.log, 'changed');
  assert.equal((await retainedCheckout(x.run, x.dir)).retained.route, 'review');
  fs.writeFileSync(x.log, 'passed\n');
  fs.appendFileSync(path.join(x.folder, 'journal.jsonl'), JSON.stringify({step: 10,
    node: 'expert_review_synthesis', signal: 'REJECT', next: 'reject_gate'}) + '\n');
  assert.equal((await retainedCheckout(x.run, x.dir)).retained.route, 'review');
});

test('a changed Task patch receives no landing approval and unpublished predecessors refuse reuse', async t => {
  const x = await landingFixture(t);
  fs.writeFileSync(path.join(x.checkout, 'a.txt'), 'different implementation\n');
  git(x.checkout, 'commit', '-qam', 'changed', '--amend');
  x.record();
  assert.equal((await retainedCheckout(x.run, x.dir)).retained.route, 'review');
  fs.writeFileSync(path.join(x.checkout, 'a.txt'), 'extra work\n');
  git(x.checkout, 'commit', '-qam', 'extra'); x.record();
  assert.match((await retainedCheckout(x.run, x.dir)).reason, /unpublished work before its Task commit/);
});

test('resume strips fresh-only CLI vars and updates saved vars atomically without a new parser', async t => {
  const x = await landingFixture(t), file = path.join(x.folder, 'vars.yaml');
  const args = ['--docker', '-w', 'lane', '--runs-folder', x.prior.runFolder,
    '--var', 'LAUNCH_CLAIM_FILE=/new/claim.json', '--var', 'JSON={"a":"x\\ny"}'];
  assert.deepEqual(resumeArguments(x.folder, 'git_landing', args), ['--docker', '-w', 'lane',
    '--runs-folder', x.prior.runFolder, '--run', x.folder, '--node', 'git_landing']);
  assert.equal(fs.readFileSync(file, 'utf8'),
    '<<:\n  MARK: old\n"LAUNCH_CLAIM_FILE": "/new/claim.json"\n"JSON": "{\\"a\\":\\"x\\\\ny\\"}"\n');
  const before = fs.readFileSync(file);
  for (const value of [['--var', 'bad'], ['--var-file', 'KEY=file'], ['--run', '/other']]) {
    assert.throws(() => resumeArguments(x.folder, 'git_landing', value));
    assert.deepEqual(fs.readFileSync(file), before);
  }
  assert.throws(() => resumeArguments(x.folder, 'implement_code', args));
});

test('failed or partial jq decoding never starts Medulla', async t => {
  const x = await landingFixture(t), root = fileURLToPath(new URL('../../', import.meta.url));
  for (const mode of ['failed', 'partial']) {
    const folder = path.join(x.f.root, 'jq-' + mode), marker = path.join(folder, 'started');
    fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'vars.yaml'), 'MARK: old\n');
    const script = `set -eu
say() { printf '%s\\n' "$*"; }
source "$TOOLING_ROOT/lane/startup/workflow.sh"
medulla() { touch "$MARKER"; }
jq() {
  if [[ "$MODE" == failed ]]; then return 23; fi
  if [[ "$1" == -er ]]; then command jq "$@"; else printf '%s\\0' '-w'; return 23; fi
}
launch_medulla -w lane --runs-folder "$LANE_RESUME_RUN" --var MARK=new
`;
    const result = spawnSync('bash', ['-c', script], {encoding: 'utf8', env: {...process.env,
      TOOLING_ROOT: root, WORKFLOW_DIR: path.join(root, 'lane'), LANE_RESUME_RUN: folder,
      LANE_RESUME_NODE: 'git_landing', LANE_WORKFLOW_FILE: '', LANE_REVIEWERS_JSON: '', MARKER: marker, MODE: mode}});
    assert.equal(result.status, mode === 'failed' ? 23 : 2, result.stderr);
    assert.equal(fs.existsSync(marker), false);
  }
});
