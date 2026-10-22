import os from 'node:os';
import path from 'node:path';

/**
 * 状态目录。
 *
 * 缓存、索引、衍生数据、模型配置都放在这里，统一一个入口。
 * 支持 `AGENT_ARCHIVE_HOME` 重定向，两个用途：
 *
 *   1. 测试时指到临时目录，不污染真实状态
 *   2. 用户想把索引放到别的盘（索引有 90 MB 量级）
 *
 * 这些是工具自己的运行态数据，不该写进被归档的项目里。
 */
export function stateHome() {
  const override = process.env.AGENT_ARCHIVE_HOME;
  if (override && String(override).trim()) return path.resolve(String(override).trim());
  return path.join(os.homedir(), '.agent-archive');
}

/** 状态目录下的路径。 */
export function statePath(...parts) {
  return path.join(stateHome(), ...parts);
}
