import fs from 'node:fs';

/**
 * 扫描期的「只读头尾」。
 *
 * ## 为什么需要它
 *
 * 会话文件是 **append-only 的 JSONL**：一行一个事件，越往后越新。扫描期要
 * 的只有四样东西——开始时间、结束时间、项目路径、标题——它们几乎都在文件
 * 的头尾；中间那几十兆是整段对话，对「这场会话是什么」没有增量信息。
 *
 * 但很多扫描器的写法是「整文件 readFileSync → split('\n') → 每行 JSON.parse」，
 * 于是扫描成本随文件大小线性增长，而且吃掉的是内存和主线程。本机实测：
 * qoder 448 个文件要 42 秒，其中 39 个 >100ms 的文件吃掉了绝大部分；
 * 最慢的单个文件 1.9 秒（13 MB）。
 *
 * 上游也是同一个结论：cc-switch 的 Grok 解析器从「整文件 >50 MiB 就跳过」
 * 改成逐行流式 + 单行上限，并写明**上限要加在记录粒度，不能加在文件粒度**
 * （整文件封顶会把后面的内容整段漏记）。MAGPIE 的 `calls.go` 同样是先读
 * 文件头判断行类型，而不是整份反序列化。
 *
 * ## 这个模块保证什么、不保证什么
 *
 * 保证：头段从字节 0 开始（第一行完整），尾段到文件末尾（最后一行完整）；
 * 中间被切掉的半行由 `headLines()` / `tailLines()` 丢弃。
 *
 * 不保证：头尾之间还有东西。所以调用方必须写「头尾里没找到就退回整读」的
 * 兜底。**这个兜底不是可选项**：没有它，一条只出现在中段的真人消息会让整场
 * 会话被误判成工具会话而丢掉——那正是我们最不想要的静默丢数据。
 *
 * 小文件（<= headBytes + tailBytes）直接整读：两段会重叠，拼起来反而要处理
 * 接缝，不如一次读掉。
 */

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 64 * 1024;

/**
 * 读文件头尾。
 *
 * @param {string} file
 * @param {{headBytes?: number, tailBytes?: number}} [opts]
 * @returns {{head: string, tail: string, size: number, whole: boolean}}
 *   `whole` 为 true 时 `tail` 为空、`head` 是全文，边界不需要丢弃。
 */
export function readHeadTail(file, { headBytes = HEAD_BYTES, tailBytes = TAIL_BYTES } = {}) {
  const st = fs.statSync(file);
  const size = st.size;

  // 小文件：整读。既省掉拼接，也避免"头尾各切一半"这种没必要的最坏情况。
  if (size <= headBytes + tailBytes) {
    return { head: fs.readFileSync(file, 'utf8'), tail: '', size, whole: true };
  }

  const fd = fs.openSync(file, 'r');
  try {
    const headBuf = Buffer.allocUnsafe(headBytes);
    const hn = fs.readSync(fd, headBuf, 0, headBytes, 0);

    const tailStart = size - tailBytes;
    const tailBuf = Buffer.allocUnsafe(tailBytes);
    const tn = fs.readSync(fd, tailBuf, 0, tailBytes, tailStart);

    return {
      head: headBuf.subarray(0, hn).toString('utf8'),
      // 尾段起点可能落在一个 UTF-8 多字节字符中间，toString 会得到一个
      // 替换字符。它一定落在被丢弃的第一行里，所以无害——但别把这个
      // 半行当成数据用。
      tail: tailBuf.subarray(0, tn).toString('utf8'),
      size,
      whole: false,
    };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * 头段的完整行（丢掉被切断的最后一行）。
 *
 * 为什么头和尾要分开返回：**标题和「是不是真人会话」只能看头段**。
 * 标题的定义是"第一句真人输入"，它按定义在开头；尾段里的 user 消息是
 * 对话后段的内容（常常是工具回显），拿它当标题会得到一行 tool output。
 * 尾段只负责补结束时间。
 *
 * @param {{head: string, tail: string, whole: boolean}} ht
 * @returns {string[]}
 */
export function headLines(ht) {
  if (ht.whole) return ht.head.split('\n');
  const lines = ht.head.split('\n');
  lines.pop(); // 最后一行是半行
  return lines;
}

/** 尾段的完整行（丢掉被切断的第一行）。小文件整读时为空数组。 */
export function tailLines(ht) {
  if (ht.whole) return [];
  const lines = ht.tail.split('\n');
  lines.shift(); // 第一行是半行
  return lines;
}

/**
 * 逐行产出解析后的 JSON 对象，坏行与半行跳过。
 *
 * @param {string[]} lines
 * @returns {Generator<object>}
 */
export function* jsonLines(lines) {
  for (const line of lines) {
    if (!line || !line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o && typeof o === 'object') yield o;
  }
}

/**
 * 整文件逐行读（兜底路径）。
 *
 * 只在「头尾里没找到必要字段」时调用——那时我们已经知道这个文件不能走快
 * 路径，整读一次是唯一正确的选择。不要用它替代 `readHeadTail()`。
 *
 * @param {string} file
 * @returns {string[]}
 */
export function allLines(file) {
  return fs.readFileSync(file, 'utf8').split('\n');
}
