import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ac = 'ac:sample0000';
const items = ['G', 'A', 'U', 'M', 'V', 'R'];
const audit = (zero = []) => ({summary: 'S', scores: Object.fromEntries(items.map(item =>
  [item, zero.includes(item) ? {score: 0, evidence: `${item} quote`, fix: `${item} fix`} : {score: 1, evidence: `${item} quote`}]))});
const review = (disagree = []) => ({draft_digest: 'd1', verdict: disagree.length ? 'REWORK' : 'APPROVE',
  scores: Object.fromEntries(items.map(item => [item, {agree: !disagree.includes(item), evidence: 'e'}])),
  findings: disagree.map(item => ({problem: `${item} is wrong`, advice: 'a'})), summary: 's'});

// publication.jq turns the audit and two critic reviews into the publication envelope.
function verdict(draft, reviews, {dry = 'false', stages, tests = 1, notes = []} = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-auditor-'));
  try {
    const write = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
    write('draft.json', draft);
    write('input.json', {selected: {address: ac, kind: 'ac', current_revision: 30, document: {data: {tags: ['wallet']}}, annotations: {comments: Object.fromEntries(notes.map(item => [item.id,item]))}},
      claim_revision: 31, children: Array.from({length: tests}, (_, index) => ({kind: 'test', address: `test:t${index}`}))});
    write('codex.json', reviews[0]);
    write('second.json', reviews[1]);
    return JSON.parse(execFileSync('jq', ['-L', here, '-nc', '--arg', 'digest', 'd1', '--arg', 'run', '2026-11-21_17-30-00-abcdef12',
      '--arg', 'date', '2026-11-21', '--arg', 'dry', dry, ...(stages ? ['--arg', 'stages', stages] : []),
      '--slurpfile', 'draft', 'draft.json', '--slurpfile', 'input', 'input.json',
      '--slurpfile', 'codex', 'codex.json', '--slurpfile', 'second', 'second.json',
      '-f', path.join(here, 'publication.jq')], {cwd: dir, encoding: 'utf8'}));
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
}
const commands = result => result.publication.operations.map(row => row.command);

test('while the schema computes the AC stage, an agreed audit publishes only the audit note and no tag', () => {
  const result = verdict(audit(['A']), [review(), review()], {stages: 'false'});
  assert.equal(result.approved, true);
  const [note] = commands(result);
  assert.equal(commands(result).length, 1);
  assert.equal(note.op, 'note');
  assert.equal(note.id, '11111r-audit-2026-11-21-abcdef12');
  assert.match(note.text, /^11111r-audit-2026-11-21\nG=1 A=0 U=1 M=1 V=1 R=1 -> fail, stage to_decide \(not written: STAGE_WRITES is false\)\n/);
  assert.match(note.text, /- A=0: A quote\n {2}Fix: A fix/);
  assert.equal(result.publication.outcome.reason_code, 'FAIL');
  // A workflow without the stages argument keeps stage writes off.
  assert.equal(commands(verdict(audit(), [review(), review()])).length, 1);
});

test('with stage writes, a failed AC goes to to_decide, every passed AC to to_prepare', () => {
  const stage = (draft, tests) => commands(verdict(draft, [review(), review()], {stages: 'true', tests}))[0];
  assert.deepEqual(stage(audit(['V']), 1), {op: 'save_object', kind: 'ac', id: 'sample0000', revision: 31,
    data: {stage: 'to_decide'}, reason: '11111+R audit 2026-11-21: G=1 A=1 U=1 M=1 V=0 R=1'});
  assert.deepEqual(stage(audit(), 2).data, {stage: 'to_prepare'});
  assert.deepEqual(stage(audit(), 0).data, {stage: 'to_prepare'});
  assert.equal(commands(verdict(audit(), [review(), review()], {stages: 'true'}))[1].op, 'note');
});

test('a disagreement, a stale digest or a malformed review publishes nothing and returns the critique', () => {
  const refused = verdict(audit(), [review(), review(['V'])]);
  assert.equal(refused.approved, false);
  assert.deepEqual(refused.critique.second.disputed, [{item: 'V', evidence: 'e'}]);
  assert.match(verdict(audit(), [review(), {...review(), draft_digest: 'old'}]).critique.second.invalid, /another audit/);
  assert.match(verdict(audit(), [review(), {...review(), scores: {G: {agree: true, evidence: 'e'}}}]).critique.second.invalid, /output contract/);
});

test('a dry run publishes nothing and keeps the would-be operations', () => {
  const result = verdict(audit(['M']), [review(), review()], {dry: 'true', stages: 'true'});
  assert.deepEqual(result.publication.operations, []);
  assert.match(result.publication.outcome.reason, /^Dry run, nothing published\. Would be G=1 A=1 U=1 M=0 V=1 R=1 -> fail, stage to_decide$/);
  assert.equal(result.would_publish.operations.length, 2);
});

test('shape.jq names each problem of an audit draft', () => {
  const shape = draft => JSON.parse(execFileSync('jq', ['-c', '-f', path.join(here, 'shape.jq')], {input: JSON.stringify(draft), encoding: 'utf8'}));
  assert.deepEqual(shape(audit(['A'])), []);
  const long = audit(['A']);
  long.scores.G.evidence = 'x'.repeat(1001);
  long.scores.A.fix = 'y'.repeat(601);
  delete long.scores.R;
  long.scores.X = {score: 1, evidence: 'e'};
  assert.deepEqual(shape(long), ['G: evidence has 1001 characters, at most 1000. Shorten it.',
    'A: fix has 601 characters, at most 600. Shorten it.', 'R: the score is missing.', 'Unknown score keys: X. Use only G, A, U, M, V and R.']);
  assert.deepEqual(shape({scores: {...audit().scores, V: {score: 0, evidence: 'e'}}, summary: ''}), ['V: a 0 needs a fix.', 'summary is required.']);
});

test('a disputed audit returns the AC to to_decide with the scores and the objections', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-auditor-disputed-'));
  try {
    fs.writeFileSync(path.join(dir, 'input.json'), JSON.stringify({selected: {address: ac, kind: 'ac', current_revision: 30}, claim_revision: 31}));
    fs.writeFileSync(path.join(dir, 'draft.json'), JSON.stringify(audit(['U'])));
    const run = (draft, stages = 'true') => JSON.parse(execFileSync('jq', ['-L', here, '-n', '--arg', 'reason', 'codex: U: the evidence is wrong',
      '--slurpfile', 'input', 'input.json', '--slurpfile', 'draft', draft, '--arg', 'run', '2026-11-21_18-30-00-abcdef12',
      '--arg', 'date', '2026-11-21', '--arg', 'stages', stages, '-f', path.join(here, 'disputed.jq')], {cwd: dir, encoding: 'utf8'}));
    const result = run('draft.json');
    const [save, note] = result.operations.map(row => row.command);
    assert.deepEqual(save.data, {stage: 'to_decide'});
    assert.equal(save.revision, 31);
    assert.equal(note.id, '11111r-audit-2026-11-21-abcdef12');
    assert.match(note.text, /^11111r-audit-2026-11-21\nG=1 A=1 U=0 M=1 V=1 R=1 -> disputed, stage to_decide\n/);
    assert.match(note.text, /Objections: codex: U: the evidence is wrong/);
    assert.match(note.text, /- U=0: U quote\n {2}Fix: U fix/);
    assert.equal(result.outcome.reason_code, 'DISPUTED');
    // An invalid or missing draft still returns the AC, with the objections only.
    const empty = run('/dev/null');
    assert.deepEqual(empty.operations[0].command.data, {stage: 'to_decide'});
    assert.match(empty.operations[1].command.text, /no valid scores -> disputed/);
    assert.equal(run('draft.json', 'false').operations.length, 1);
  } finally {
    fs.rmSync(dir, {recursive: true, force: true});
  }
});


test('only the third completed FAIL or DISPUTED adds manual-check, without losing tags', () => {
  const note=(id,result)=>({id:'11111r-audit-'+id,text:`11111r-audit-date\nG=0 A=1 -> ${result}, stage to_decide`});
  const old=[note('1','fail'),note('2','disputed'),{...note('3','pass'),text:note('3','pass').text+'\nEvidence quotes: -> fail, stage to_decide'}, {id:'other',text:' -> fail, stage to_decide'}];
  const data=notes=>commands(verdict(audit(['U']),[review(),review()],{stages:'true',notes}))[0].data;
  assert.deepEqual(data([old[0],old[2]]),{stage:'to_decide'});
  assert.deepEqual(data(old.slice(0,1)),{stage:'to_decide'});
  assert.deepEqual(data(old),{stage:'to_decide',tags:['manual-check','wallet']});
  assert.deepEqual(commands(verdict(audit(),[review(),review()],{stages:'true',notes:old}))[0].data,{stage:'to_prepare'});
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'audit-manual-'));
  try {
    const input={selected:{address:ac,kind:'ac',current_revision:4,document:{data:{tags:['wallet']}},
      annotations:{comments:Object.fromEntries(old.map(item=>[item.id,item]))}},claim_revision:5};
    for(const [name,value] of Object.entries({input,draft:audit(['U'])}))fs.writeFileSync(path.join(dir,name+'.json'),JSON.stringify(value));
    const output=JSON.parse(execFileSync('jq',['-L',here,'-n','--arg','stages','true','--arg','run','r3',
      '--arg','date','2026-11-22','--arg','reason','Still disputed','--slurpfile','input',path.join(dir,'input.json'),
      '--slurpfile','draft',path.join(dir,'draft.json'),'-f',path.join(here,'disputed.jq')],{encoding:'utf8'}));
    assert.deepEqual(output.operations[0].command.data,{stage:'to_decide',tags:['manual-check','wallet']});
  } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
