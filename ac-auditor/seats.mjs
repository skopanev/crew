#!/usr/bin/env node
// The three finder seats, each with its own read-only reader from the shared agent-reader.mjs.
// A seat without its reader config or AGY profile is an error: a finder must not audit links blind.
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const env = process.env;
const {agentArgs} = await import(pathToFileURL(path.join(path.dirname(env.CREW_FLOW_STAGES), 'agent-reader.mjs')).href);
const pack = values => Object.fromEntries(values.map((value, index) => ['a' + (index + 1), value]));
if (!env.auditor_finder_three_reader_home) throw new Error('finder three needs its private AGY reader profile');
console.log(JSON.stringify([
  {slug: 'one', harness: 'codex', model: env.FINDER_ONE_MODEL, ...pack(agentArgs('codex', env.auditor_finder_one_reader_config))},
  {slug: 'two', harness: 'codex', model: env.FINDER_TWO_MODEL, ...pack(agentArgs('codex', env.auditor_finder_two_reader_config))},
  {slug: 'three', harness: 'agy', model: env.FINDER_THREE_MODEL,
    env: {BROKER_AGY_HOME: env.auditor_finder_three_reader_home, BROKER_ISOLATE_MCP: '1'}}]));
