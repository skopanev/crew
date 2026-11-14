#!/usr/bin/env node
import path from 'node:path';
import {read} from '../lane-launcher/runtime.mjs';
import {api} from '../lane-launcher/joppa-common.mjs';
import {approvedCriteria} from './selection.mjs';

try {
  const [file, mode, ...extra] = process.argv.slice(2);
  if (!file || mode !== '--dry-run' || extra.length) {
    throw new Error('Usage: test-author-joppa.sh <config.json> --dry-run');
  }
  const config = read(path.resolve(file));
  if (typeof config.workspace !== 'string' || !config.workspace.trim() || !config.joppa?.url) {
    throw new Error('Config needs workspace and joppa.url');
  }
  const worker = config.joppa.workers?.[0] || {};
  const result = await approvedCriteria(config, (tool, args) =>
    api(config, worker, tool, {workspace: config.workspace, ...args}));
  console.log(JSON.stringify({mode: 'preview', workspace: config.workspace, ...result}, null, 2));
} catch (error) {
  console.error(`Test-author selection: ${error.message}`);
  process.exitCode = 2;
}
