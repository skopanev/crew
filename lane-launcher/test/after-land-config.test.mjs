import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {test} from 'node:test';
import {setup} from '../test-support/launcher.fixture.mjs';
import {validateJoppa} from '../joppa-config.mjs';

test('afterLand accepts an absolute host hook and contains relative hooks within the repository', async t => {
  const f = await setup(t), config = {...f.config, delivery: 'target'};
  const repo = config.repositories[0], external = path.join(f.root, 'host-hook');
  fs.writeFileSync(external, '#!/bin/sh\nexit 0\n', {mode: 0o755});
  repo.afterLand = external;
  validateJoppa(config);
  fs.symlinkSync(external, path.join(repo.path, 'escape'));
  repo.afterLand = 'escape';
  assert.throws(() => validateJoppa(config), /stay inside/);
  repo.afterLand = '../escape';
  assert.throws(() => validateJoppa(config), /absolute or repository-relative/);
  fs.writeFileSync(path.join(repo.path, 'local-hook'), '#!/bin/sh\nexit 0\n', {mode: 0o755});
  repo.afterLand = 'local-hook';
  validateJoppa(config);
  fs.chmodSync(external, 0o644);
  repo.afterLand = external;
  assert.throws(() => validateJoppa(config), /EACCES/);
});
