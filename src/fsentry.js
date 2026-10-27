import fs from 'node:fs';

/**
 * 目录 / 文件的判定，**跟随符号链接与 Windows junction**。
 *
 * ## 为什么不直接用 dirent.isDirectory()
 *
 * `fs.readdirSync(dir, { withFileTypes: true })` 返回的 Dirent 对符号链接和
 * junction 一律报 `isDirectory() === false`——它是"这个目录项本身是不是目录"，
 * 不是"它指向的东西是不是目录"。实测（Windows，mklink /J 建的 junction）：
 *
 *     link     dirent.isDirectory()=false | lstat.isSymbolicLink()=true | stat.isDirectory()=true
 *     target   dirent.isDirectory()=true  | lstat.isSymbolicLink()=false | stat.isDirectory()=true
 *
 * 后果是**静默丢一整家会话**：用户把 `~/.codex/sessions` 搬到别的盘、在原处留
 * 一个 junction（这是 Windows 上最常见的腾空间做法），扫描器会一个文件都找不到，
 * 而 doctor 报的是"这个 Agent 没装"——不是报错，是安静地少一家。
 *
 * 这个坑我们在环境层已经踩过一次：技能扫描因为同样的原因漏掉 Qoder 的 3 个和
 * Kiro 的 28 个技能，症状也是"0 个技能"而不是报错。当时只修了那一处，
 * 会话扫描器里一直留着。这里统一成两个助手函数，全部替换。
 *
 * ## 环路
 *
 * 真目录不可能构成环，只有链接可以。所以调用方仍需保留自己的深度上限
 * （各扫描器本来就有），这里不做 visited 记录——那会让每次扫描都多一份
 * 路径集合，而深度上限已经够用。
 */

/** 这个目录项指向一个目录吗（跟随链接）？ */
export function isDirEntry(dirent, fullPath) {
  if (dirent.isDirectory()) return true;
  if (!dirent.isSymbolicLink()) return false;
  try {
    return fs.statSync(fullPath).isDirectory();
  } catch {
    // 断链是正常情况（目标被删/盘没挂），当它不存在
    return false;
  }
}

/** 这个目录项指向一个普通文件吗（跟随链接）？ */
export function isFileEntry(dirent, fullPath) {
  if (dirent.isFile()) return true;
  if (!dirent.isSymbolicLink()) return false;
  try {
    return fs.statSync(fullPath).isFile();
  } catch {
    return false;
  }
}

/**
 * 路径本身是不是目录（带链接跟随）。
 *
 * 给那些拿不到 Dirent 的地方用——比如从配置里读到一个候选根目录。
 */
export function isDirPath(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}