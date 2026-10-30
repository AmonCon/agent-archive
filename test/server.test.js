import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import zlib from 'node:zlib';

import { startServer } from '../src/server.js';
import { sandbox } from './helpers.js';

/**
 * 只读服务的最小契约：内容类型、gzip、安全头。
 *
 * 这里不测页面内容——页面渲染有各自的用例。这里锁的是"传输层没有把
 * 大页面原样丢给外部网络"，以及 CSP 等硬约束没有在重构里丢掉。
 */

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ res, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
  });
}

test('server: 声明 gzip 时压缩静态资源，未声明时发原文', async () => {
  const box = sandbox();
  try {
    await box.run(async () => {
      const started = await startServer({ port: 0, warm: false });
      try {
        const plain = await get(`${started.url}/assets/theme.css`);
        assert.equal(plain.res.headers['content-encoding'], undefined);

        const gz = await get(`${started.url}/assets/theme.css`, { 'accept-encoding': 'gzip' });
        assert.equal(gz.res.headers['content-encoding'], 'gzip');
        assert.equal(zlib.gunzipSync(gz.body).toString('utf8'), plain.body.toString('utf8'));
      } finally {
        await new Promise((r) => started.server.close(r));
      }
    });
  } finally {
    box.cleanup();
  }
});

test('server: 动态页面同样压缩，并保留 CSP', async () => {
  const box = sandbox();
  try {
    await box.run(async () => {
      const started = await startServer({ port: 0, warm: false });
      try {
        const gz = await get(`${started.url}/env`, { 'accept-encoding': 'gzip' });
        assert.equal(gz.res.headers['content-encoding'], 'gzip');
        assert.match(String(gz.res.headers['content-security-policy']), /default-src 'none'/);
        assert.match(zlib.gunzipSync(gz.body).toString('utf8'), /<html/i);
      } finally {
        await new Promise((r) => started.server.close(r));
      }
    });
  } finally {
    box.cleanup();
  }
});
