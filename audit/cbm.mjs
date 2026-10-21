import fs from 'node:fs';
import path from 'node:path';
import {command, require, successfulCalls, text} from './common.mjs';

export const readTools = ['list_projects', 'search_graph', 'search_code', 'get_code_snippet', 'query_graph',
  'trace_path', 'get_graph_schema', 'get_architecture', 'index_status', 'check_index_coverage'];

export function server(config) {
  return {command: config.cbm_command || process.env.CBM_BIN || 'codebase-memory-mcp', args: [],
    env: {CBM_CACHE_DIR: config.cbm_store, CBM_ALLOWED_ROOT: config.cbm_root}};
}

export function preflight(config) {
  const cbm = server(config);
  require(fs.statSync(config.cbm_store).isDirectory(), 'Shared CBM store is not a directory');
  const root = fs.realpathSync(config.cbm_root);
  for (const repo of config.repositories) {
    const location = fs.realpathSync(repo.path);
    require(text(repo.cbm_project) && (location === root || location.startsWith(root + path.sep)),
      `Repository ${repo.id} needs a CBM project inside cbm_root`);
    const reply = JSON.parse(command(cbm.command, ['cli', '--json', 'index_status',
      '--project', repo.cbm_project, '--format', 'json'], {env: {...process.env, ...cbm.env}}));
    require(!reply.isError, `Shared CBM refused ${repo.cbm_project}`);
    const status = reply.structuredContent || JSON.parse(reply.content.find(item => item.type === 'text').text);
    require(status.status === 'ready' && status.project === repo.cbm_project
      && fs.realpathSync(status.root_path) === location, `Shared CBM is not ready for ${repo.id}`);
  }
}

export function verifySearches(events, harness, repositories) {
  const searches = new Set(successfulCalls(events, harness).filter(call => call.server === 'codebase-memory'
    && ['search_graph', 'search_code'].includes(call.tool)).map(call => call.arguments?.project));
  const missing = repositories.filter(repo => !searches.has(repo.cbm_project)).map(repo => repo.cbm_project);
  require(!missing.length, `Missing successful CBM search. Call codebase-memory search_graph or search_code with project: ${missing.join(', ')}`);
}
