import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const entry = new URL('../ac-completion.mjs', import.meta.url);
for (const signal of ['READY', 'BLOCKED']) {
  for (const broken of [null, 'config', 'result', 'lander', 'input', 'run-dir', 'missing-config', 'missing-result', 'missing-lander', 'missing-input']) {
    test(`CLI preserves ${signal} with ${broken ?? 'valid disabled policy'}`, () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lander-ac-cli-'));
      try {
        const artifacts = path.join(root, 'artifacts'); fs.mkdirSync(artifacts);
        const configFile = path.join(root, 'config.json'); fs.writeFileSync(configFile, '{}');
        const resultText = JSON.stringify({reason_code: signal === 'READY' ? 'OTHER' : 'LANDED'});
        fs.writeFileSync(path.join(artifacts, 'result.json'), resultText);
        for (const name of ['lander', 'input']) fs.writeFileSync(path.join(artifacts, name + '.json'), '{}');
        if (broken?.startsWith('missing-')) fs.unlinkSync(broken === 'missing-config' ? configFile :
          path.join(artifacts, broken.slice(8) + '.json'));
        else if (broken && broken !== 'run-dir') fs.writeFileSync(broken === 'config' ? configFile :
          path.join(artifacts, broken + '.json'), '{malformed');
        const resultPath = path.join(artifacts, 'result.json');
        const resultBefore = fs.existsSync(resultPath) ? fs.readFileSync(resultPath, 'utf8') : null;
        const env = {...process.env, MEDULLA_RUN_DIR: root, MEDULLA_LAST_SIGNAL: signal,
          PLANNING_JOPPA_CONFIG: configFile};
        if (broken === 'run-dir') delete env.MEDULLA_RUN_DIR;
        const run = spawnSync(process.execPath, [entry.pathname], {env, encoding: 'utf8'});
        assert.equal(run.status, 0, run.stderr);
        assert.ok(run.stdout.includes(`<signal:${signal}>`), run.stdout);
        assert.equal(fs.existsSync(resultPath) ? fs.readFileSync(resultPath, 'utf8') : null, resultBefore);
      } finally { fs.rmSync(root, {recursive: true, force: true}); }
    });
  }
}
