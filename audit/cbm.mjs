import fs from 'node:fs';
import path from 'node:path';
import {command, require, text} from './common.mjs';

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
  const searches = new Set();
  const names = ['search_graph', 'search_code'];
  if (harness === 'codex') {
    for (const event of events) {
      const call = event.item;
      if (event.type === 'item.completed' && call?.type === 'mcp_tool_call' && call.server === 'codebase-memory'
        && names.includes(call.tool) && call.status === 'completed' && !call.error && !call.result?.isError) {
        searches.add(call.arguments?.project);
      }
    }
  } else if (harness === 'claude-code') {
    const used = new Map();
    for (const event of events) for (const block of event.message?.content || []) {
      if (event.type === 'assistant' && block.type === 'tool_use'
        && names.some(name => block.name === `mcp__codebase-memory__${name}`)) used.set(block.id, block.input?.project);
      if (event.type === 'user' && block.type === 'tool_result' && !block.is_error && used.has(block.tool_use_id)) {
        searches.add(used.get(block.tool_use_id));
      }
    }
  }
  require(repositories.every(repo => searches.has(repo.cbm_project)), 'Audit agent has no successful scoped CBM search for every inspected repository');
}
