/**
 * init-vault.test.mjs
 *
 * Tests for init-vault.mjs — pure-function units.
 *
 * Run with: node --test scripts/init-vault.test.mjs
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ensureDir, copyIfMissing } from './init-vault.mjs';

let tmpRoot;
before(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'init-vault-test-'));
});
after(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

async function makeVault(name = 'vault') {
  const p = join(tmpRoot, name);
  await mkdir(p, { recursive: true });
  return p;
}

describe('ensureDir', () => {
  test('creates non-existing directory', async () => {
    const vault = await makeVault('d1');
    const target = join(vault, '01_知识库');
    const result = await ensureDir(target);
    assert.equal(result.created, true);
    assert.equal(result.path, target);
  });

  test('skips existing directory', async () => {
    const vault = await makeVault('d2');
    const target = join(vault, '01_知识库');
    await mkdir(target);
    const result = await ensureDir(target);
    assert.equal(result.created, false);
    assert.equal(result.path, target);
  });

  test('throws when parent path is invalid', async () => {
    // 在 Windows 上,试图在空字符串路径下创建目录会抛
    await assert.rejects(
      () => ensureDir(''),
      (err) => err && (err.code === 'ENOENT' || err.code === 'EEXIST' || err.code === 'ERR_INVALID_ARG_VALUE')
    );
  });
});

describe('copyIfMissing', () => {
  test('copies when dst missing', async () => {
    const vault = await makeVault('c1');
    const src = join(vault, 'src.md');
    const dst = join(vault, 'dst.md');
    await writeFile(src, 'hello', 'utf8');
    const result = await copyIfMissing(src, dst);
    assert.equal(result.action, 'copied');
    assert.equal(result.src, src);
    assert.equal(result.dst, dst);
    assert.equal(await readFile(dst, 'utf8'), 'hello');
  });

  test('skips when dst exists, preserves existing content', async () => {
    const vault = await makeVault('c2');
    const src = join(vault, 'src.md');
    const dst = join(vault, 'dst.md');
    await writeFile(src, 'NEW', 'utf8');
    await writeFile(dst, 'OLD', 'utf8');
    const result = await copyIfMissing(src, dst);
    assert.equal(result.action, 'skipped');
    assert.equal(result.src, src);
    assert.equal(result.dst, dst);
    assert.equal(await readFile(dst, 'utf8'), 'OLD');
  });

  test('returns failed (copy-failed) when src missing', async () => {
    const vault = await makeVault('c3');
    const src = join(vault, 'never.md'); // 不创建
    const dst = join(vault, 'dst.md');
    const result = await copyIfMissing(src, dst);
    assert.equal(result.action, 'failed');
    assert.equal(result.src, src);
    assert.equal(result.dst, dst);
    assert.equal(result.error.kind, 'copy-failed');
    assert.equal(result.error.code, 'ENOENT');
  });

  test('auto-creates missing parent directory of dst', async () => {
    const vault = await makeVault('c4');
    const src = join(vault, 'src.md');
    const dst = join(vault, 'subdir/nested/dst.md');
    await writeFile(src, 'nested-hello', 'utf8');
    const result = await copyIfMissing(src, dst);
    assert.equal(result.action, 'copied');
    assert.equal(result.src, src);
    assert.equal(result.dst, dst);
    assert.equal(await readFile(dst, 'utf8'), 'nested-hello');
  });

  test('returns failed (mkdir-failed) when dst parent is a file', async () => {
    const vault = await makeVault('c5');
    // 用一个普通文件作为 dst 的"父目录"——mkdir 会抛 ENOTDIR
    const blocker = join(vault, 'blocker');
    await writeFile(blocker, 'i am a file', 'utf8');
    const src = join(vault, 'src.md');
    await writeFile(src, 'content', 'utf8');
    const dst = join(blocker, 'sub', 'dst.md'); // blocker 是文件不是目录

    const result = await copyIfMissing(src, dst);
    assert.equal(result.action, 'failed');
    assert.equal(result.error.kind, 'mkdir-failed');
    // Windows 上是 ENOTDIR 或 EEXIST,POSIX 是 ENOTDIR
    assert.ok(['ENOTDIR', 'EEXIST'].includes(result.error.code),
      `unexpected errno ${result.error.code}`);
  });
});
