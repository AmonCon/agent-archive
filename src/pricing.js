import fs from 'node:fs';
import path from 'node:path';
import { statePath } from './paths.js';

/**
 * 价目表：把 token 换算成钱的**估算**。
 *
 * ## 为什么单独一层，不塞进用量层
 *
 * 用量是事实（Agent 自己记的账），价格是外部参考（今天多少钱、哪家供应商）。
 * 两者会独立变化：换个中转站价格就变了，而历史 token 不会变。
 * 混在一起之后，就再也说不清"这个数字是当时记的，还是按今天的价重算的"。
 *
 * 所以这里只做三件事：同步一份目录、按模型查价、算钱。
 * 谁用、怎么标"估算"，由调用方决定。
 *
 * ## 数据来源
 *
 * models.dev 的 `api.json`（5.9 MB，233 个 provider，8909 个模型，其中 7946 个带价）。
 * 同一个模型在不同 provider 下价格不同（官方目录 vs 中转站加价），
 * 所以建索引时**优先厂商自己的目录**，中转站只作为兜底——否则一个转售商的
 * 加价会变成你对全部历史成本的估算基准。
 *
 * ## 不联网也能用
 *
 * `sync` 才发请求，读的时候只读本地缓存。没有缓存就明确返回"没有价目表"，
 * 不去猜、也不会在你看报告时悄悄发一次网络请求。
 */

const CATALOG_SOURCE = 'https://models.dev/api.json';

/** 厂商自己的目录。同一个模型有多家报价时，优先用这些。 */
const MAKERS = new Set([
  'anthropic',
  'openai',
  'google',
  'google-vertex',
  'deepseek',
  'zhipuai',
  'moonshotai',
  'moonshotai-cn',
  'minimax',
  'minimax-cn',
  'xai',
  'meta',
  'mistral',
  'alibaba',
  'qwen',
]);

/** 目录缓存文件。放进状态目录，与会话归档分开。 */
export function catalogPath() {
  return statePath('pricing.json');
}

/**
 * 模型名的归一化，两边都用它，匹配才对称。
 *
 * 处理过的情况：大小写、前导 `~`（openrouter 的别名写法）、
 * `vendor/model` 前缀（中转站的写法，厂商目录里没有前缀）。
 * **不**去掉 `:free` 之类的后缀——那种模型是真免费，按付费价估算反而错。
 */
export function normalizeId(id) {
  if (!id) return '';
  return String(id)
    .toLowerCase()
    .trim()
    .replace(/^~/, '')
    .replace(/^[a-z0-9._-]+\//, '');
}

/** 去掉日期后缀（`-20250929` / `@20250514`），用于二次匹配。 */
export function stripDateSuffix(id) {
  return String(id).replace(/[-@]\d{8}$/, '');
}

/**
 * 把 models.dev 的原始 JSON 压成我们自己的索引。
 *
 * 输出形状刻意用数组而不是对象：4416 个模型存成对象会有几十万字节的键重复，
 * 存盘和读取都更慢；数组的字段顺序在这里是契约，见 toEntry/fromEntry。
 */
export function buildCatalog(raw, { fetchedAt = new Date().toISOString() } = {}) {
  const models = new Map();

  for (const [providerId, provider] of Object.entries(raw || {})) {
    for (const [modelId, model] of Object.entries(provider.models || {})) {
      const cost = model.cost;
      if (!cost || cost.input == null || cost.output == null) continue;
      const entry = {
        input: Number(cost.input),
        output: Number(cost.output),
        // 有的模型没有缓存价。留 null，由调用方决定怎么兜底，
        // 不要在这里编一个 0——0 会让"有缓存但没价"算成免费。
        cacheRead: cost.cache_read == null ? null : Number(cost.cache_read),
        cacheWrite: cost.cache_write == null ? null : Number(cost.cache_write),
        provider: providerId,
        id: modelId,
      };

      const key = normalizeId(modelId);
      if (!key) continue;
      const prev = models.get(key);
      // 厂商目录优先；同级保留先出现的（models.dev 的顺序本身稳定）
      if (!prev || (!MAKERS.has(prev.provider) && MAKERS.has(providerId))) {
        models.set(key, entry);
      }
    }
  }

  return {
    source: 'models.dev',
    fetchedAt,
    count: models.size,
    models: [...models.entries()].map(([k, e]) => [
      k,
      e.input,
      e.output,
      e.cacheRead,
      e.cacheWrite,
      e.provider,
      e.id,
    ]),
  };
}

function catalogToMap(catalog) {
  const map = new Map();
  for (const [k, input, output, cacheRead, cacheWrite, provider, id] of catalog.models || []) {
    map.set(k, { input, output, cacheRead, cacheWrite, provider, id });
  }
  return map;
}

/** 发一次请求、建索引、写盘。只有这个函数会联网。 */
export async function syncCatalog({ fetchImpl = globalThis.fetch, now = new Date() } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('这个 Node 没有 fetch，无法同步价目表');
  const res = await fetchImpl(CATALOG_SOURCE);
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  const raw = await res.json();
  const catalog = buildCatalog(raw, { fetchedAt: now.toISOString() });

  const file = catalogPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(catalog), 'utf8');
  return { file, count: catalog.count, fetchedAt: catalog.fetchedAt };
}

/**
 * 读本地缓存。没有就返回 ready:false，不抛错。
 *
 * 价目表是可选的：没有它，用量层照样能报 token，只是没有钱。
 */
export function loadCatalog({ file = catalogPath() } = {}) {
  try {
    const catalog = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(catalog.models)) throw new Error('格式不对');
    return {
      ready: true,
      file,
      source: catalog.source || 'models.dev',
      fetchedAt: catalog.fetchedAt || null,
      count: catalog.models.length,
      models: catalogToMap(catalog),
    };
  } catch (e) {
    return {
      ready: false,
      file,
      reason: e && e.code === 'ENOENT' ? '还没有同步过价目表' : e.message,
      models: new Map(),
    };
  }
}

/**
 * 查一个模型的价格。
 *
 * 先精确匹配；不中再去掉日期后缀试一次（`claude-sonnet-4-5-20250929`
 * 在不同版本目录里有时带日期、有时不带）。都没有就返回 null——
 * 返回 null 的意思是"不知道"，不是"免费"。
 */
export function priceFor(model, catalog) {
  if (!model || !catalog || !catalog.models) return null;
  const base = normalizeId(model);
  if (!base) return null;

  const direct = catalog.models.get(base);
  if (direct) return direct;

  const stripped = normalizeId(stripDateSuffix(base));
  if (stripped && stripped !== base) {
    const hit = catalog.models.get(stripped);
    if (hit) return hit;
  }
  return null;
}

/**
 * 按价格算一条记录的钱。
 *
 * 单价单位是「美元 / 百万 token」，models.dev 就是这么定的。
 *
 * 缓存价缺失时退回输入价，并标记 `approximated`：宁可高估也不要当免费。
 * 这个标记会一路带到汇总结果里，让人能看出"这个估算里有多少是猜的"。
 */
export function estimateCost(row, price) {
  if (!price) return null;
  const fresh = Number(row.fresh) || 0;
  const output = Number(row.output) || 0;
  const cacheRead = Number(row.cacheRead) || 0;
  const cacheWrite = Number(row.cacheWrite) || 0;

  let approximated = false;
  let cacheReadPrice = price.cacheRead;
  let cacheWritePrice = price.cacheWrite;
  if (cacheRead > 0 && cacheReadPrice == null) {
    cacheReadPrice = price.input;
    approximated = true;
  }
  if (cacheWrite > 0 && cacheWritePrice == null) {
    cacheWritePrice = price.input;
    approximated = true;
  }

  const micro =
    fresh * price.input +
    output * price.output +
    cacheRead * (cacheReadPrice || 0) +
    cacheWrite * (cacheWritePrice || 0);

  return { usd: micro / 1e6, approximated };
}
