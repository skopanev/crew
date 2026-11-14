import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {requirementBranch, requirementPlan, assertRequirementHead, parsePublication} from '../requirement-delivery.mjs';
import {publicationReader} from '../publication-guard.mjs';
import {dependencyCheck, remoteDependencyBlocker} from '../dependencies.mjs';

function fixture() {
  const branch = requirementBranch('spec:r', 'repo');
  const types = {spec: {role: 'requirement', parents: []},
    measure: {role: 'ac', parents: ['spec']}, work: {role: 'task', parents: ['measure']}};
  const objects = new Map();
  function add(address, parent, status) {
    const value = {address, kind: address.split(':')[0], historical: false, current_revision: 1,
      document: {present: true, parent, links: [], data: {title: address,
        ...(status ? {body: 'Repository: repo\nImplement the selected behavior.'} : {})}},
      process: {}};
    if (status === 'in_progress') value.document.data.assignee = 'crew-lane:host:run';
    if (status === 'blocked') value.document.data.hold = 'GATE_FAIL';
    if (status === 'done' || status === 'retired') value.document.present = false;
    if (status === 'done') value.document.data.commit = 'a'.repeat(40);
    objects.set(address, value);
    return value;
  }
  add('spec:r', null);
  add('measure:a', 'spec:r');
  add('work:one', 'measure:a', 'in_progress');
  const sibling = add('work:two', 'measure:a', 'done');
  const read = async (tool, args) => {
    if (tool === 'joppa_tree') return {schema: {types}};
    if (tool === 'joppa_objects' && args.address) return structuredClone(objects.get(args.address));
    if (tool === 'joppa_objects') {
      const kinds = args.kind && [args.kind].flat(), tones = args.status && [args.status].flat();
      const descendant = value => {
        if (!args.parent || args.parent === '*') return true;
        let parent = value.document.parent, depth = 1;
        while (parent) {
          if (parent === args.parent) return !args.depth || depth <= args.depth;
          parent = objects.get(parent)?.document.parent;
          depth++;
        }
        return false;
      };
      const rows = [...objects.values()].filter(x => descendant(x) && (!kinds || kinds.includes(x.kind)))
        .map(x => ({address: x.address, kind: x.kind, parent: x.document.parent,
          present: x.document.present, revision: x.current_revision, title: x.document.data.title,
          status: x.document.present ? x.status?.tone || 'grey' : 'purple',
          'data.assignee': x.document.data.assignee ?? null, 'data.commit': x.document.data.commit ?? null,
          'data.stage': x.document.data.stage ?? null,
          'data.hold': x.document.data.hold ?? null}))
        .filter(x => tones ? tones.includes(x.status) : x.present)
        .sort((a, b) => a.address.localeCompare(b.address));
      const after = rows.filter(row => !args.cursor || row.address > args.cursor), page = after.slice(0, args.limit || 25);
      return {items: page.map(row => Object.fromEntries(Object.entries(row)
        .filter(([key]) => key === 'address' || args.fields?.includes(key)))), total: rows.length,
        ...(after.length > page.length ? {next_cursor: page.at(-1).address} : {})};
    }
    throw new Error(`Unexpected read ${tool}`);
  };
  const run = {requirement: 'spec:r', repository: 'repo', tasks: [{address: 'work:one', revision: 1}],
    config: {repositories: [{id: 'repo'}], taskFields: {repository: 'body:Repository', module: 'body:Module'}}};
  return {objects, add, read, run, branch};
}


export {fixture};
