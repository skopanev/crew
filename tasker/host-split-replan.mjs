// A confirmed host SPLIT permits replanning the same Task without claiming completed code.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';

const require = (ok, message) => { if (!ok) throw new Error(message); };
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sha = value => /^[0-9a-f]{40}$/.test(value || '');
// publication.jq decides the AC and Test checks with the supported findings (crew m_49e4475b). The host rechecks the Task checks.
const checks = ['gate', 'size', 'reporter_names', 'outside_files', 'already_in_develop'];
const plainDirectory = file => {
  require(fs.lstatSync(file).isDirectory() && fs.realpathSync(file) === file, 'not a plain directory');
  return file;
};
const plain = (file, root) => {
  require(file.startsWith(root + path.sep) && fs.realpathSync(file) === file && fs.lstatSync(file).isFile(), 'not a plain run file');
  return fs.readFileSync(file);
};

function receipt(input, trees, config, id, noteId) {
  require(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(config.id || ''), 'invalid dispatcher id');
  const runs = path.join(path.resolve(config.stateDir), 'crew-dispatchers', config.id.toLowerCase(), 'runs');
  const outer = plainDirectory(path.join(plainDirectory(runs), id));
  const hashes = {}, read = relative => {
    const bytes = plain(path.join(outer, relative), outer);
    hashes[relative] = hash(bytes);
    return JSON.parse(bytes);
  };
  const run = read('launch.json'), task = input.selected, parent = input.context.parent;
  const note = task.annotations.comments[noteId];
  require(run.workspace === input.workspace && run.workspace === config.workspace && run.task === task.address &&
    run.result?.status === 'failed' && run.result.blockConfirmed === true && run.result.code === 2 &&
    typeof run.result.finishedAt === 'string' && !run.result.completed && !run.result.held &&
    !run.result.publicationUncertain, 'not a confirmed Task failure');
  require((run.claim?.tasks?.length ?? 0) === 1 && run.claim.runId === id && run.claim.claimed === true, 'not one host claim');
  const claim = run.claim.tasks[0], ticket = run.claim.ticket, repository = run.repository?.id, tree = trees[repository];
  require(claim.address === task.address && claim.digest === run.claim.digest && claim.ticket && same(claim.ticket, ticket), 'claim differs');
  require(run.repository.path === tree?.repo && sha(tree.sha) && ticket.repository === repository &&
    ticket.revision === claim.revision && ticket.address === task.address && ticket.parent === parent.address &&
    ticket.title === task.document.data.title && ticket.body === task.document.data.body &&
    (!task.document.data.repository || task.document.data.repository === repository), 'Task contract differs');
  require(same([ticket.parentContext?.data?.title, ticket.parentContext?.data?.body],
    [parent.document.data.title, parent.document.data.body]), 'AC text differs');
  const blocked = run.result.tasks;
  require(blocked?.length === 1 && blocked[0].address === task.address && blocked[0].status === 'blocked' &&
    blocked[0].revision === task.current_revision && task.current_revision === claim.revision + 1 &&
    input.claim_revision === task.current_revision + 1, 'Task revision differs');
  const commands = run.blockRequest?.operations?.map(row => row.command) || [];
  const failure = commands.find(command => command.op === 'note' && command.target === task.address && command.id === noteId);
  const save = commands.find(command => command.op === 'save_object' && `${command.kind}:${command.id}` === task.address);
  require(run.blockRequest.workspace === input.workspace && failure?.text === note.text && note.actor === run.joppaWorker?.actor &&
    note.withdrawn !== true && save?.revision === claim.revision && save.data?.assignee === null &&
    save.data.stage === task.document.data.stage && save.reason === 'Crew lane failed: SPLIT.', 'host failure note differs');
  require(run.runFolder === path.join(outer, 'lane'), 'foreign run folder');
  const laneRoot = plainDirectory(run.runFolder);
  const lanes = fs.readdirSync(laneRoot).filter(name => /^\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d-[0-9a-f]{8}$/.test(name));
  require(lanes.length === 1, 'ambiguous lane');
  const lane = plainDirectory(path.join(laneRoot, lanes[0])), prefix = path.relative(outer, lane);
  const hostClaim = read('lane/launch-claim.json'), laneClaim = read(prefix + '/artifacts/claim.json');
  for (const saved of [hostClaim, laneClaim]) {
    require(saved.runId === id && same(saved.tasks, run.claim.tasks) && same(saved.ticket, ticket) &&
      saved.digest === run.claim.digest && saved.revision === run.claim.revision, 'saved claim differs');
  }
  require(same(read(prefix + '/artifacts/ticket.json'), ticket), 'saved ticket differs');
  const state = read(prefix + '/artifacts/plan-state.json'), outcome = read(prefix + '/artifacts/plan-outcome.json');
  const origin = read(prefix + '/artifacts/origin.json'), terminal = read(prefix + '/outcome.json');
  const journalBytes = plain(path.join(lane, 'journal.jsonl'), outer);
  hashes[prefix + '/journal.jsonl'] = hash(journalBytes);
  const journal = journalBytes.toString().trim().split('\n').map(JSON.parse), split = journal.at(-2), stop = journal.at(-1);
  require(['plan_task', 'plan_review_synthesis'].includes(split?.node) && split.signal === 'SPLIT' && split.next === 'plan_stop' &&
    split.kind === 'decision' && stop?.node === 'plan_stop' && stop.kind === 'decision' &&
    stop.next === '__exit_fail__' && terminal.outcome === 'failed' && terminal.exit_code === 2 &&
    terminal.error?.node === 'plan_stop' && origin.node === split.node && origin.signal === 'SPLIT' &&
    outcome.status === 'blocked' && outcome.splitFile === 'split.md' && outcome.reason === state.reason &&
    state.reason === origin.message && typeof state.reason === 'string' && failure.text.includes(state.reason) &&
    state.approved === false, 'not a host planning SPLIT');
  // Accept the current host limits and signal format only. A changed protocol keeps ordinary repair.
  require(state.maxFiles === 8 && state.maxLines === 300 && state.plan?.verdict === 'SPLIT' &&
    sha(state.source?.head) && /^[0-9a-f]{64}$/.test(state.source?.digest || '') &&
    /^[0-9a-f]{64}$/.test(state.digest || ''), 'invalid host plan binding');
  const oversized = Number.isSafeInteger(state.plan.files) && Number.isSafeInteger(state.plan.lines) &&
    (state.plan.files > state.maxFiles || state.plan.lines > state.maxLines);
  require(oversized || state.plan.gateSelection?.split === true, 'SPLIT has no host size or gate decision');
  require(oversized ? state.reason.startsWith(`разбить: ${state.plan.lines} lines, ${state.plan.files} files`) :
    state.reason === 'разбить: ' + (state.plan.gateSelection.splitReason ??
      'The planned gate runs the full suite or more than 200 Test files.'), 'host SPLIT reason differs');
  const plan = plain(path.join(lane, 'artifacts/plan.md'), outer);
  hashes[prefix + '/artifacts/plan.md'] = hash(plan);
  require(hash(plan) === state.digest, 'plan digest differs');
  const workflow = plain(path.join(lane, 'workflow.yaml'), outer);
  hashes[prefix + '/workflow.yaml'] = hash(workflow);
  require(hash(workflow) === run.workflow?.digest, 'workflow differs');
  const git = (...args) => execFileSync('git', ['--no-optional-locks', '-C', tree.path, '-c', 'core.fsmonitor=false', ...args],
    {encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe']}).trim();
  require(git('rev-parse', 'HEAD') === tree.sha && !git('status', '--porcelain', '--untracked-files=all'), 'snapshot changed');
  git('merge-base', '--is-ancestor', state.source.head, tree.sha);
  return {run: id, task: task.address, revision: task.current_revision, repository, develop: tree.sha,
    source: {head: state.source.head, digest: state.source.digest}, contract_digest: claim.digest, plan_digest: state.digest, files: hashes};
}

// Notes supply only a UUID. Every path comes from the configured dispatcher state directory.
export function hostSplitReceipt({input, repair, trees, configFile = process.env.DOLBER_CONFIG ||
  (process.env.CREW_WORKFLOW_DIR && path.join(process.env.CREW_WORKFLOW_DIR, '..', 'dolber.json'))}) {
  try {
    if (repair.ac_text_changed !== false || input.context.incoming?.length !== 0 || !configFile) return null;
    const configBytes = fs.readFileSync(configFile), config = JSON.parse(configBytes);
    require(typeof config.stateDir === 'string' && path.isAbsolute(config.stateDir), 'missing configured runs root');
    const notes = input.selected.annotations?.comments || {}, found = [];
    for (const [noteId, note] of Object.entries(notes)) {
      const match = /^CREW_FAILURE\nTask: ([^\n]+)\nRun: ([^\n]+)\nReason: SPLIT\n/.exec(note.text || '');
      if (!match || match[1] !== input.selected.address || !uuid.test(match[2])) continue;
      try { found.push({...receipt(input, trees, config, match[2], noteId), config_digest: hash(configBytes)}); }
      catch { /* Keep ordinary repair when evidence differs. */ }
    }
    return found.length === 1 ? found[0] : null;
  } catch { return null; }
}

// Recheck the host evidence at both the machine check and publication boundaries.
export function verifiedSplitReplan({input, repair, draft, trees, reviews, digest}) {
  if (draft?.verdict !== 'STALE' || draft.needs_code !== true || draft.done_commit != null ||
    draft.retirement_proof != null || !repair.split_replan) return false;
  const current = hostSplitReceipt({input, repair, trees});
  if (!current || !same(current, repair.split_replan)) return false;
  if (reviews !== undefined && (!/^[0-9a-f]{64}$/.test(digest || '') || !Array.isArray(reviews) || reviews.length !== 2 ||
    !reviews.every(review => review.draft_digest === digest &&
      checks.every(key => review.checks?.[key]?.ok === true && typeof review.checks[key].evidence === 'string' &&
        review.checks[key].evidence.trim())))) return false;
  return true;
}
