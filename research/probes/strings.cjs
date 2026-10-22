// Extract printable ASCII/UTF-8 runs from a binary, keep those matching session-related patterns.
const fs = require('node:fs');

const file = process.argv[2];
const pattern = new RegExp(process.argv[3] || 'session', 'i');
const minLen = Number(process.argv[4] || 8);

const buf = fs.readFileSync(file);
const out = [];
let start = -1;
const isPrintable = (b) => (b >= 0x20 && b < 0x7f) || b === 0x09;

for (let i = 0; i <= buf.length; i++) {
  const b = i < buf.length ? buf[i] : 0;
  if (isPrintable(b)) {
    if (start < 0) start = i;
  } else {
    if (start >= 0) {
      const len = i - start;
      if (len >= minLen) {
        const s = buf.toString('latin1', start, i);
        if (pattern.test(s)) out.push(s);
      }
      start = -1;
    }
  }
}
const uniq = [...new Set(out)];
console.log('matches:', uniq.length);
for (const s of uniq.slice(0, 1500)) console.log(s);
