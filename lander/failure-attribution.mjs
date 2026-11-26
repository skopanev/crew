// Read repository paths only from failed native test evidence.
export function failurePaths(nativeLog, junit, knownPaths) {
  const failed = [];
  let active = false;
  for (const raw of nativeLog.replace(/\x1b\[[0-9;]*m/g, '').split('\n')) {
    const line = raw.replace(/^[^|]*:test\s*\|\s?/, '');
    if (/^\s*(?:[✖✗] failing tests:|test at |FAIL\s|not ok\s|✗\s|\(fail\)\s)/.test(line)) active = true;
    else if (/^(?:\[test\]|[✔✓]|\(pass\)|▶|ℹ|TAP version|\s*Test Files)/.test(line)) active = false;
    if (active) failed.push(line);
    if (/^\[test\] file .*: rc=[1-9]\d*\b/.test(line)) failed.push(line);
  }
  for (const match of junit.matchAll(/<testcase\b(?![^>]*\/>)[^>]*>[\s\S]*?<\/testcase\s*>/g)) {
    if (/<(?:failure|error)\b/.test(match[0])) failed.push(match[0]);
  }
  const text = failed.join('\n').replace(/&(?:quot|apos|lt|gt|amp);/g, value =>
    ({'&quot;':'"', '&apos;':"'", '&lt;':'<', '&gt;':'>', '&amp;':'&'}[value]));
  const paths = new Set();
  for (const match of text.matchAll(/[^\s"'`<>:]+/g)) {
    const token = match[0].replace(/[.,;)\]]+$/, '');
    const parts = token.split('/');
    if (parts.includes('node_modules')) continue;
    for (let index = 0; index < parts.length; index++) {
      const file = parts.slice(index).join('/');
      if (knownPaths.has(file)) { paths.add(file); break; }
    }
  }
  return [...paths].sort();
}
