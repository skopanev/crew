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
        ...(status ? {purpose: 'implementation', body: 'Repository: repo\nImplement the selected behavior.'} : {})}},
      process: status ? {status, revision: 1} : {}};
    objects.set(address, value);
    return value;
  }
  add('spec:r', null);
  add('measure:a', 'spec:r');
  add('work:one', 'measure:a', 'in_progress');
  const sibling = add('work:two', 'measure:a', 'done');
  sibling.process.done = `Landed SHA: ${'a'.repeat(40)}\nTarget: ${branch}\n`;
  const read = async (tool, args) => {
    if (tool === 'joppa_tree') return {schema: {types}};
    if (tool === 'joppa_objects' && args.address) return structuredClone(objects.get(args.address));
    if (tool === 'joppa_objects') return {items: [...objects.values()].filter(x => x.document.parent === args.parent)
      .map(x => ({address: x.address, kind: x.kind, present: x.document.present})), next_cursor: null};
    if (tool === 'joppa_tasks') return {tasks: [...objects.values()].filter(x => x.kind === 'work')
      .map(x => ({address: x.address, revision: x.current_revision, status: x.process.status})), next_cursor: null};
    throw new Error(`Unexpected read ${tool}`);
  };
  const run = {requirement: 'spec:r', repository: 'repo', tasks: [{address: 'work:one', revision: 1}],
    config: {repositories: [{id: 'repo'}]}};
  return {objects, add, read, run, branch};
}


export {fixture};
