// Highlight engine events without treating every stderr line as an error.
export function formatLaneLine(line, color) {
  if (!color || line.includes('\x1b[')) return line;
  let tone;
  if (/^\[lane\] (?:FAILED|STOPPED)\b/.test(line)) tone = '1;31';
  else if (/^\[lane\] EXIT\b/.test(line)) tone = '1;32';
  else if (/^\[lane\] START\b/.test(line)) tone = '1;36';
  else if (/^\[medulla\]/.test(line) && /\bstep \d+ \|/.test(line)) {
    tone = /-> __exit_fail__\b/.test(line) ? '1;31'
      : /-> __exit_ok__\b/.test(line) ? '1;32'
      : line.includes(' -> ') ? '33' : '1;36';
  } else if (/^run\.sh:/.test(line)) tone = '33';
  return tone ? `\x1b[${tone}m${line}\x1b[0m` : line;
}
