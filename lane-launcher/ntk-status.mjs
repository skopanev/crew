#!/usr/bin/env node
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {claimTicket, updateStatus} from './ntk.mjs';

export const usage = 'ntk-status <id> -W <workspace> -s <status> [--force | --claim]';

export function parseStatus(argv) {
  const args = {};
  const fields = {'-W': 'workspace', '--workspace': 'workspace', '-s': 'status', '--status': 'status'};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--force') { args.force = true; continue; }
    if (arg === '--claim') { args.claim = true; continue; }
    if (fields[arg]) {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) throw new Error(`${arg} needs a value`);
      if (args[fields[arg]]) throw new Error(`${arg} supplied twice`);
      args[fields[arg]] = argv[++i]; continue;
    }
    if (!arg.startsWith('-') && !args.id) { args.id = arg; continue; }
    throw new Error(`unsupported argument: ${arg}`);
  }
  if (!args.id || !args.workspace || !args.status) throw new Error(`usage: ${usage}`);
  if (args.claim && (args.status !== 'in_progress' || args.force)) {
    throw new Error('--claim requires -s in_progress and cannot be combined with --force');
  }
  if (args.status === 'in_progress' && !args.claim) {
    throw new Error('in_progress requires --claim; a status PATCH would bypass dependency checks');
  }
  return args;
}

export async function main(argv) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    console.log(usage); return;
  }
  // Force is explicit; a failed or uncertain write is never retried here.
  const args = parseStatus(argv);
  console.log(JSON.stringify(await (args.claim ? claimTicket(args.id, args.workspace) : updateStatus(args))));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
