import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sandbox } from './helpers.js';
import { isDirEntry, isFileEntry, isDirPath } from '../src/fsentry.js';

/**
 * 目录项判定的契约：**必须跟随符号链接与 junction**。
 *
 * 这条救的是"整家会话静默消失"：用户把 `~/.codex/sessions` 搬到别的盘、
 * 在原处留一个链接，用 `dirent.isDirectory()` 判断的话会一个文件都读不到，
 * 而 doctor 报的是"这个 Agent 没装"——不报错，只是安静地少一家。
 *
 * 创建链接需要权限（Windows 上普通用户建符号链接要开发者模式；junction 不用），
 * 所以建不出来时跳过而不是失败——测试环境不该因为权限问题变红。
 */

/** 尽量建一个目录链接；建不出来返回 false。 */
function tryLinkDir(target, link) {
  try {
    // Windows 上 junction 不需要管理员权限
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    try {
      fs.symlinkSync(target, link, 'dir');
      return true;
    } catch {
      return false;
    }
  }
}

test('fsentry: dirent.isDirectory() 对链接返回 false，isDirEntry 跟随', () => {
  const box = sandbox();
  try {
    const real = box.mkdir('real-dir');
    fs.writeFileSync(path.join(real, 'a.txt'), 'x');
    const link = box.path('link-dir');

    if (!tryLinkDir(real, link)) {
      // 没有权限建链接：跳过（在 CI 上由 macOS/Linux 覆盖这条）
      return;
    }

    const entry = fs
      .readdirSync(box.home, { withFileTypes: true })
      .find((e) => e.name === 'link-dir');
    assert.ok(entry, '链接应该出现在目录列表里');

    // 前提：原生判定确实为 false（否则这条测试没有意义）
    assert.equal(entry.isDirectory(), false, 'dirent.isDirectory() 对链接应返回 false');
    // 我们的判定要跟随
    assert.equal(isDirEntry(entry, link), true, 'isDirEntry 必须跟随链接');
    // 直接给路径时也一样
    assert.equal(isDirPath(link), true);
  } finally {
    box.cleanup();
  }
});

test('fsentry: 文件链接同样跟随', () => {
  const box = sandbox();
  try {
    const real = box.write('real-file.jsonl', 'hi\n');
    const link = box.path('link-file.jsonl');
    try {
      fs.symlinkSync(real, link, 'file');
    } catch {
      return; // 没权限就跳过
    }

    const entry = fs
      .readdirSync(box.home, { withFileTypes: true })
      .find((e) => e.name === 'link-file.jsonl');
    assert.equal(entry.isFile(), false, 'dirent.isFile() 对链接应返回 false');
    assert.equal(isFileEntry(entry, link), true);
  } finally {
    box.cleanup();
  }
});

test('fsentry: 断链当作不存在，不抛错', () => {
  const box = sandbox();
  try {
    const target = box.mkdir('gone-dir');
    const link = box.path('dangling');
    if (!tryLinkDir(target, link)) return;
    fs.rmSync(target, { recursive: true, force: true });

    const entry = fs
      .readdirSync(box.home, { withFileTypes: true })
      .find((e) => e.name === 'dangling');
    // 断链要静默当作"没有"，而不是让扫描器抛错
    assert.equal(isDirEntry(entry, link), false);
    assert.equal(isDirPath(link), false);
  } finally {
    box.cleanup();
  }
});

test('fsentry: 普通目录与文件照常判定', () => {
  const box = sandbox();
  try {
    box.write('plain/a.txt', 'x');
    const entries = fs.readdirSync(box.home, { withFileTypes: true });
    const dir = entries.find((e) => e.name === 'plain');
    assert.equal(isDirEntry(dir, box.path('plain')), true);
    assert.equal(isDirPath(box.path('plain')), true);
    assert.equal(isDirPath(box.path('nope')), false);
  } finally {
    box.cleanup();
  }
});
