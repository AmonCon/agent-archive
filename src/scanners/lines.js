import fs from 'node:fs';

/**
 * 同步逐行读。
 *
 * ## 为什么需要它
 *
 * 读会话正文的地方以前都是「`readFileSync` 整份读成字符串 → `split('\n')`」。
 * 实测有 **254 MB 的明文会话文件、单行最长 8.45 MB**，那种写法会同时持有
 * 一整份字符串和一整个字符串数组（V8 里 split 出来的每一行都是新字符串），
 * 内存峰值约等于两倍文件大小。它不一定崩，但会在读一个大文件时把整个进程
 * 拖慢，同时把内存抬到没必要的高度。
 *
 * ## 单行上限为什么必须加在「行」上
 *
 * cc-switch 的 Grok 解析器把「整文件 >50 MiB 就跳过」改成了逐行 + 单行上限，
 * 并在注释里写明原因：整文件封顶会把后面的内容**整段漏记**（`session_usage_grokbuild.rs:148-152`）。
 * 所以这里的语义是：
 *
 *   - 某一行超过 `maxLineBytes` → 丢掉**这一行**的内容，但字节照常消费、
 *     继续读下一行；
 *   - **绝不**因为一行超长就放弃整个文件。
 *
 * 工具结果的单行可能有几 MB（截图 base64、超长命令输出），它们本来也不是
 * 给人看的对话，丢掉是合理的；但同一场会话后面的话必须还在。
 *
 * ## 同步
 *
 * 扫描器与 readMessages 都是同步 API（CLI 里直接调用、要立刻拿结果），
 * 所以这里用 `fs.readSync` 分块读，不引入异步/流。分块大小取 64 KiB：
 * 足够摊薄系统调用，又不会让 carry 缓冲过大。
 */

const CHUNK_BYTES = 64 * 1024;
const DEFAULT_MAX_LINE = 8 * 1024 * 1024;

/**
 * 逐行产出文件内容（不含换行符）。
 *
 * @param {string} file
 * @param {{maxLineBytes?: number, chunkBytes?: number, onOversize?: (bytes: number) => void}} [opts]
 * @returns {Generator<string>}
 */
export function* lineIterator(file, opts = {}) {
  const maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE;
  const chunkBytes = opts.chunkBytes ?? CHUNK_BYTES;
  const onOversize = typeof opts.onOversize === 'function' ? opts.onOversize : null;

  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(chunkBytes);
    let pending = []; // 当前行已读到的各段
    let pendingLen = 0;
    let skipping = false; // 正在跳过一条超长行
    let skipBytes = 0;

    for (;;) {
      const n = fs.readSync(fd, buf, 0, chunkBytes, null);
      if (n === 0) break;
      const chunk = buf.subarray(0, n);

      let start = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== 0x0a) continue; // '\n'
        const piece = chunk.subarray(start, i);
        start = i + 1;

        if (skipping) {
          // 这一行的尾巴，丢弃，恢复正常读取
          skipBytes += piece.length;
          skipping = false;
          pending = [];
          pendingLen = 0;
          if (onOversize) onOversize(skipBytes);
          skipBytes = 0;
          continue;
        }

        pendingLen += piece.length;
        if (pendingLen > maxLineBytes) {
          skipping = true;
          pending = [];
          pendingLen = 0;
          continue;
        }
        if (piece.length) pending.push(Buffer.from(piece));
        yield finishLine(pending);
        pending = [];
        pendingLen = 0;
      }

      // 本块剩下的半行留到下一块
      const rest = chunk.subarray(start);
      if (skipping) {
        skipBytes += rest.length;
      } else if (rest.length) {
        pendingLen += rest.length;
        if (pendingLen > maxLineBytes) {
          skipping = true;
          pending = [];
          pendingLen = 0;
        } else {
          pending.push(Buffer.from(rest));
        }
      }
    }

    // 文件末尾没有换行符时，最后一行也要产出
    if (skipping) {
      skipBytes += 0;
      if (onOversize) onOversize(skipBytes);
    } else if (pendingLen > 0) {
      yield finishLine(pending);
    }
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* 忽略 */
    }
  }
}

/** 把一段 Buffer 拼成字符串，去掉行尾的 \r（Windows 换行）。 */
function finishLine(parts) {
  const buf = parts.length === 1 ? parts[0] : Buffer.concat(parts);
  let s = buf.toString('utf8');
  if (s.endsWith('\r')) s = s.slice(0, -1);
  return s;
}

/**
 * 逐行回调版本（不需要自己管迭代器时用它）。
 *
 * @param {string} file
 * @param {(line: string) => void} onLine
 * @param {{maxLineBytes?: number, chunkBytes?: number}} [opts]
 * @returns {{lines: number, oversize: number}}
 */
export function forEachLine(file, onLine, opts = {}) {
  let lines = 0;
  let oversize = 0;
  for (const line of lineIterator(file, {
    ...opts,
    onOversize: () => {
      oversize++;
    },
  })) {
    lines++;
    onLine(line);
  }
  return { lines, oversize };
}