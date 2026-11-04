// Watch a dispatcher process while a test edits its config between selections.
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {packageFixture} from './launcher-joppa.fixture.mjs';

export const planner = fileURLToPath(new URL('../../planning-joppa/dashboard.mjs', import.meta.url));
export const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function watch(t, script, args, env) {
  const child = spawn(process.execPath, [script, ...args], {env});
  let output = '';
  child.stdout.on('data', data => output += data);
  child.stderr.on('data', data => output += data);
  const closed = new Promise(resolve => child.once('close', resolve));
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  return {
    child,
    output: () => output,
    mark: () => output.length,
    since: mark => output.slice(mark),
    async until(predicate, timeout = 20000) {
      const deadline = Date.now() + timeout;
      while (!predicate(output)) {
        if (Date.now() > deadline || child.exitCode !== null) throw new Error(`Condition not reached. Output:\n${output.slice(-3000)}`);
        await pause(50);
      }
    },
    async stop() {
      child.kill('SIGINT');
      return closed;
    },
  };
}

// A planner dispatcher around the Joppa package server. Each pass is a fake `sh` that records its start and end.
const recordPass = '#!/bin/sh\nprintf \'start %s\\n\' "$(tr -d \'\\n\' < "$3")" >> "$TEST_PASSES"\n' +
  'sleep "$TEST_PASS_SECONDS"\nprintf \'end\\n\' >> "$TEST_PASSES"\n';
export async function plannerFixture(t, values = {}, passSeconds = 0, pass = recordPass) {
  const f = await packageFixture(t);
  f.queue.length = 0; // Both criteria are ready when no Task holds them.
  const bins = path.join(f.root, 'planner-bin'), passes = path.join(f.root, 'passes.log');
  fs.mkdirSync(bins);
  fs.writeFileSync(path.join(bins, 'sh'), pass, {mode: 0o755});
  const configFile = path.join(f.root, 'planner.json');
  const config = {workspace: 'fixture', url: f.run.config.joppa.url, token_file: path.join(f.root, 'token'),
    runs_folder: path.join(f.root, 'planning-runs'), interval_seconds: 1, ...values};
  // Replace the file in one step: a reader never sees a partly written config.
  const write = value => {
    fs.writeFileSync(`${configFile}.next`, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
    fs.renameSync(`${configFile}.next`, configFile);
  };
  write(config);
  const env = {...process.env, PATH: `${bins}:${process.env.PATH}`, TEST_PASSES: passes,
    TEST_PASS_SECONDS: String(passSeconds), NO_COLOR: '1'};
  return {...f, config, configFile, write, env,
    passes: () => fs.existsSync(passes) ? fs.readFileSync(passes, 'utf8').trim().split('\n') : [],
    start: () => watch(t, planner, ['--config', configFile], env)};
}
