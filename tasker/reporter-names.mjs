#!/usr/bin/env node
// Compare the Reporter names of the Task criterion Tests with the results of one test run (crew m_2ffa5efc).
// Usage: ac-reporter-names.mjs check TICKET REPO RESULTS. Run it from the root of the checkout that ran the tests.
//        ac-reporter-names.mjs tests-line TICKET: print each Task whose body has no "Tests:" line. It exits 0 for a
//        readable ticket, so an error of this script cannot pass for a refusal.
//        ac-reporter-names.mjs restriction-line TICKET: print each Task whose body has a restriction line, with that line.
//        It exits 0 for a readable ticket, as tests-line does.
// Crew m_dfa249cc, owner m_0505cc75: check checks only the Tests that a Task names in its "Tests:" line or in the list
// right below that line. A Test of the same criterion that the Task does not name belongs to another Task. A Task
// without a "Tests:" line is not taken into work: the prepare step refuses it with NO_TESTS_LINE (tests-line).
// Crew m_b932ce41: a restriction line that is not an AC condition ends a lane at review with SCOPE_MISMATCH. The prepare
// step refuses such a Task with RESTRICTION_LINE (restriction-line). The Criterion, Source, Tests, Reporter and Command
// lines and the Test list lines carry the AC and its Tests, so this check skips them.
// TICKET is the lane artifacts/ticket.json: each Task carries every Test of its criterion (acceptanceTests) with its body.
// RESULTS has one JSON line {test, status} for each result of the run.
// A result binds to a Test only by the exact body line "Repository: <repo>. Reporter name: <name>"
// (example-backend scripts/joppa-upload-results.ts, readTests). A name that the run does not report leaves the Test blue.
// check refuses a name of REPO that does not start with the path of a test file from the checkout root, and a name that
// its test file did not report in this run. It skips a file that is not in the tree (the Test is not written yet) and a
// file that this run did not run.
import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Use the same binding line in Writer, Tasker and the result checker.
export function reporterNames(body) {
  return [...(typeof body === 'string' ? body : '').matchAll(/^Repository: ([A-Za-z0-9][A-Za-z0-9._-]*)\. Reporter name: ([^\r\n]+)\r?$/gm)]
    .map(([, repo, name]) => ({repo, name}));
}

export function testBindings(test) {
  const repo = test?.repository, name = test?.reporter_name, lines = reporterNames(test?.body);
  if (repo == null && name == null) return lines;
  if (typeof repo !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repo) ||
      typeof name !== 'string' || !name || name.length > 400 || /[\r\n]/.test(name))
    throw new Error('Invalid Test repository or reporter_name fields');
  if (lines.length && (lines.length !== 1 || lines[0].repo !== repo || lines[0].name !== name))
    throw new Error('Test Reporter fields conflict with its body');
  return [{repo, name}];
}

export function reporterFile(name) {
  if (typeof name !== 'string' || !name.includes(' > ') || /[\r\n\0]/.test(name)) return null;
  const [file, ...parts] = name.split(' > ');
  return /^[^/ ][^ ]*\/[^/ ]+\.(test|itest|spec)(-[a-z]+)?\.[cm]?[jt]sx?$/.test(file) &&
    !path.isAbsolute(file) && !path.win32.isAbsolute(file) && !/[\\\0\r\n\t]/.test(file) &&
    !file.split('/').some(part => ['', '.', '..', '.git'].includes(part)) && parts.every(part => part.trim()) ? file : null;
}

// The Test addresses of the "Tests:" lines of a Task body, with the list lines right below each, or null without one.
// A note in brackets before the colon is part of the line: "Tests (approved text): test:a, test:b."
export function namedTests(body) {
  const sections = [...(typeof body === 'string' ? body : '').matchAll(/^Tests(?:[ \t]*\([^)\r\n]*\))?:([^\r\n]*(?:\r?\n[ \t]*[-*][^\r\n]*)*)/gm)];
  return sections.length ? new Set(sections.flatMap(section => section[1].match(/\btest:[A-Za-z0-9]+/g) ?? [])) : null;
}
// "do not change" and "keep ... unchanged" restrict only when their object is code scope (crew m_75e90ff6): product or
// production code, a file, a module, Tests or a path with an extension. "Keep the payload unchanged" is behaviour.
const scope = String.raw`(?:(?:the|any|other|its|their|this|these|that|those|existing|current|all|every|each)\s+)*`
  + String.raw`(?:product(?:ion)? code|test code|code|(?:test |source |support |other )?files?|modules?|tests?`
  + String.raw`|[\w@/-]+(?:\.[\w-]+)*\.(?:[cm]?[jt]sx?|sql|json|sh|ya?ml|md|tf|py|css|html))`
  + String.raw`(?=\s*(?:[.,;:)!]|$)|\s+(?:and|or|in|of|for|outside|except|beyond|unless|when|if|that|which|as|unchanged)\b)`;
const restrictions = [
  /^\s*read[ -]only\s*:/i,
  new RegExp(String.raw`\bdo not change\s+${scope}`, 'i'),
  /\bchange no product code\b/i,
  new RegExp(String.raw`\bkeep\s+${scope}[^.]*\b(?:unchanged|as (?:it is|they are))\b`, 'i'),
  /\btest[- ]support(?: code)? only\b/i,
  /^\s*module\s*:.*\bonly\b/i,
  /\bkeep (?:the|this|each|every) files? (?:within|under|below|at most) \d+ (?:effective )?lines\b/i,
  // A size line reads as a scope limit (task:sample0002 SCOPE_MISMATCH, crew m_32989b3a): "Size:" at the start of a line or
  // of a sentence, or a file and line count ("three files, about 179 lines").
  /(?:^|[.!?]\s+)size(?:\s*\([^)]*\))?\s*:/i,
  new RegExp(String.raw`\b(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+files?`
    + String.raw`(?:,|\s+and)\s*(?:about|around|roughly|at most|up to|under|~)?\s*\d+\s+lines\b`, 'i'),
  // The size, gate and line count values belong in the files array of the Task only (crew m_81ce8d2f). A Gate line with
  // a Test file count is a forecast. A Gate line with check commands stays.
  /(?:^|[.!?]\s+)(?:test\s+)?gate\s*:.*\b\d+\s+test\s+files?\b/i,
  /(?:^|[.!?]\s+)(?:lines|line count|(?:changed|counted) lines)\s*:/i,
  // A line count or estimate of one file (crew m_81ce8d2f): "(~155 lines)", "(243 effective lines)", "(63):" or
  // "file.ts about 30".
  /[\w@/-]\.[a-z]{1,5}(?:\s*\(\s*(?:~\s*|about\s+)?\d+(?:\s+(?:effective\s+|counted\s+|changed\s+)?lines?)?\s*\)|\s+(?:~\s*|about\s+)\d+\b)/i,
];
const acLine = /^\s*(?:(?:criterion|sources?|tests(?:\s*\([^)]*\))?|reporter|command)\s*:|[-*]\s*test:)/i;
// The first line of a Task body that restricts the scope and is not an AC condition, or undefined. Tasker check imports
// it, so the prepare step and Tasker share one definition (crew m_81ce8d2f).
export function restrictionLine(body) {
  return (typeof body === 'string' ? body : '').split(/\r?\n/)
    .find(text => !acLine.test(text) && restrictions.some(pattern => pattern.test(text)));
}
function main() {
  const [mode, ticketFile, repo, resultsFile] = process.argv.slice(2);
  if (!(mode === 'check' && ticketFile && repo && resultsFile && process.argv.length === 6)
      && !(['tests-line', 'restriction-line'].includes(mode) && ticketFile && process.argv.length === 4)) {
    console.error('usage: ac-reporter-names.mjs check TICKET REPO RESULTS | tests-line TICKET | restriction-line TICKET');
    process.exit(2);
  }
  const ticket = JSON.parse(fs.readFileSync(ticketFile, 'utf8'));
  const tasks = ticket.tasks ?? [ticket];
  if (mode === 'tests-line') {
    const missing = tasks.filter(task => !namedTests(task.body)).map(task => task.address ?? task.id ?? '?');
    if (missing.length) {
      console.log(`${missing.join(', ')}: the Task body has no "Tests:" line that names its Tests. A Task without it is not taken into work.`);
    }
    process.exit(0);
  }
  if (mode === 'restriction-line') {
    for (const task of tasks) {
      const line = restrictionLine(task.body);
      if (line) {
        console.log(`${task.address ?? task.id ?? '?'}: the Task body has a restriction line that is not an AC condition: `
          + `"${line.trim()}". A Task with it is not taken into work.`);
      }
    }
    process.exit(0);
  }
  const tests = new Map();
  let unnamed = 0;
  for (const task of tasks) {
    const named = namedTests(task.body);
    for (const test of task.acceptanceTests ?? []) {
      if (typeof test?.address !== 'string') continue;
      if (named?.has(test.address)) tests.set(test.address, test);
      else unnamed += 1;
    }
  }
  if (unnamed) console.log(`ac-reporter-names: ${unnamed} criterion Test(s) that the Task does not name in its Tests: line, not checked`);
  const expected = [];
  for (const test of tests.values()) {
    for (const binding of reporterNames(test.body)) {
      if (binding.repo === repo) expected.push({address: test.address, name: binding.name});
    }
  }
  const rows = fs.readFileSync(resultsFile, 'utf8').split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
  const reported = new Set(rows.map(row => row.test));
  // A test entry file or a shared case file (*.itest-cases.ts), with its path from the checkout root.
  // Node names each case by the file that defines it.
  const tracked = file => {
    try {
      execFileSync('git', ['--literal-pathspecs', 'ls-files', '--error-unmatch', '--', file], {stdio: 'ignore'});
      return true;
    } catch {
      return false;
    }
  };
  const problems = [];
  for (const {address, name} of expected) {
    if (reported.has(name)) continue;
    const file = name.split(' > ')[0];
    if (!reporterFile(name)) {
      problems.push(`${address}: Reporter name "${name}" does not start with the path of a test file from the checkout root`);
    } else if (!tracked(file)) {
      console.log(`ac-reporter-names: ${address}: ${file} is not in this tree; the Test is not written yet, not checked`);
    } else {
      const ran = rows.map(row => row.test).filter(test => test.startsWith(`${file} > `));
      if (!ran.length) {
        console.log(`ac-reporter-names: ${address}: ${file} did not run here, not checked`);
        continue;
      }
      const near = ran.find(test => test.endsWith(` > ${name.split(' > ').pop()}`));
      problems.push(`${address}: expected Reporter name "${name}", but the run of ${file} has no such name`
        + (near ? `; it has "${near}"` : ''));
    }
  }
  for (const problem of problems) console.error(`ac-reporter-names: ${problem}`);
  if (problems.length) {
    console.error(`ac-reporter-names: ${problems.length} Reporter name(s) of the Task criterion Tests do not match this run, `
      + `so these Tests get no result. Name the test as the Reporter name says, or ask P2 to correct it. First: ${problems[0]}`);
    process.exit(1);
  }
  console.log(`ac-reporter-names: ${expected.length} Reporter name(s) of ${repo} checked`);
}

// Run the CLI only as the entry script. Compare real paths: the prepare step can call it through a linked workflow
// directory, and an import (Tasker check) must not run it.
if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) main();
