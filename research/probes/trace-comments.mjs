import fs from 'node:fs';

const p = process.argv[2] || 'src/scanners/qoder.js';
const text = fs.readFileSync(p, 'utf8');

// 模拟 JS 的注释/字符串扫描，找出第一个"不该在注释里却出现代码"的位置
let i = 0;
let line = 1;
let state = 'code'; // code | block | line | sq | dq | tpl
let blockStartLine = 0;

const trace = [];

function advanceTo(pos) {
  for (let k = i; k < pos; k++) if (text[k] === '\n') line++;
  i = pos;
}

while (i < text.length) {
  const c = text[i];
  const n = text[i + 1];

  if (state === 'code') {
    if (c === '/' && n === '*') {
      state = 'block';
      blockStartLine = line;
      i += 2;
      continue;
    }
    if (c === '/' && n === '/') {
      state = 'line';
      i += 2;
      continue;
    }
    if (c === "'") {
      state = 'sq';
      i++;
      continue;
    }
    if (c === '"') {
      state = 'dq';
      i++;
      continue;
    }
    if (c === '`') {
      state = 'tpl';
      i++;
      continue;
    }
    if (c === '\n') line++;
    i++;
    continue;
  }

  if (state === 'block') {
    if (c === '*' && n === '/') {
      trace.push(`注释 ${blockStartLine} → ${line}`);
      state = 'code';
      i += 2;
      continue;
    }
    if (c === '\n') line++;
    i++;
    continue;
  }

  if (state === 'line') {
    if (c === '\n') {
      state = 'code';
      line++;
    }
    i++;
    continue;
  }

  if (state === 'sq' || state === 'dq') {
    const q = state === 'sq' ? "'" : '"';
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === q) {
      state = 'code';
      i++;
      continue;
    }
    if (c === '\n') line++;
    i++;
    continue;
  }

  if (state === 'tpl') {
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '`') {
      state = 'code';
      i++;
      continue;
    }
    if (c === '\n') line++;
    i++;
    continue;
  }
}

console.log('注释块配对：');
for (const t of trace) console.log('  ', t);
console.log();
console.log('最终状态:', state, '（应为 code）');
if (state === 'block') {
  console.log(`⚠ 第 ${blockStartLine} 行开始的注释没有闭合，一直吃到文件末尾`);
}
