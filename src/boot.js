/**
 * 入口引导：在**任何会用到 SQLite / zstd 的模块之前**做环境自检。
 *
 * ## 为什么单独一个文件
 *
 * ES 模块的求值顺序遵循 import 列表的深度优先顺序：`import './boot.js'` 写在
 * 最前面，它就会比后面的 `./query.js` 先求值。而 `./query.js` 一路静态
 * import 到 `sqlite-read.js` 的 `node:sqlite`——在老 Node 上那是**链接期错误**，
 * 整个进程直接挂掉，任何写在函数体里的检查都来不及跑。
 *
 * 所以检查必须发生在模块求值阶段，而不是某个函数被调用时。
 * 单独一个文件是为了让测试能 import `preflight.js` 而不触发退出。
 */

import { assertEnvironment } from './preflight.js';

assertEnvironment();
