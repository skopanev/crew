import {spawn} from 'node:child_process';

export async function repeat(binary, args, intervalSeconds) {
  let stopped = false, child, timer, wake;
  const stop = signal => {
    stopped = true;
    clearTimeout(timer);
    wake?.();
    if (child?.pid) {
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
  };
  const interrupt = () => stop('SIGINT');
  const terminate = () => stop('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  try {
    while (!stopped) {
      const started = Date.now();
      console.log(`auditor: started ${new Date(started).toISOString()}`);
      const code = await new Promise(resolve => {
        child = spawn(binary, args, {stdio: 'inherit', detached: process.platform !== 'win32'});
        child.once('error', error => {
          console.error(`auditor: ${error.message}`);
          resolve(2);
        });
        child.once('close', code => resolve(code ?? 2));
      });
      child = undefined;
      if (stopped) break;
      const delay = Math.max(0, started + intervalSeconds * 1000 - Date.now());
      console.log(`auditor: exit ${code}; next audit ${new Date(Date.now() + delay).toISOString()} · Ctrl+C to stop`);
      await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, delay); });
      wake = undefined;
    }
  } finally {
    clearTimeout(timer);
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
  }
}
