/**
 * init-vault.test.mjs
 *
 * Tests for init-vault.mjs — pure-function units + integration scenarios
 * against a synthetic vault in a temp directory.
 *
 * Run with: node --test scripts/init-vault.test.mjs
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ensureDir,
  copyIfMissing,
  ensureFileIfMissing,
  ensureVaultRoot,
  injectClaudeMd,
  runInit,
  DIRECTORIES,
  TOP_LEVEL_MD,
  PLACEHOLDER_FILES,
  CLAUDE_BEGIN_MARKER,
  CLAUDE_END_MARKER,
} from './init-vault.mjs';

// 测试 pluginRoot = plugin 仓根 = 脚本的父目录
const __test_filename = fileURLToPath(import.meta.url);
const __test_dirname = dirname(__test_filename);
const PLUGIN_ROOT = resolve(__test_dirname, '..');

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

describe('runInit (integration)', () => {
  test('empty vault: 8 dirs + 3 placeholders + 3 assets + CLAUDE.md created', async () => {
    const vault = await makeVault('r1');
    const report = await runInit({ vaultRoot: vault, pluginRoot: PLUGIN_ROOT });
    assert.equal(report.exitCode, 0);
    assert.equal(report.counters.dirsCreated, 8);
    assert.equal(report.counters.dirsSkipped, 0);
    assert.equal(report.counters.filesCopied, 3);
    assert.equal(report.counters.filesSkipped, 0);
    assert.equal(report.counters.placeholdersCreated, 3);
    assert.equal(report.counters.placeholdersSkipped, 0);
    assert.equal(report.claudeMd.status, 'created');
    assert.equal(report.errors.length, 0);
  });

  test('half-init vault: partial create + partial skip, no overwrite', async () => {
    const vault = await makeVault('r2');
    await mkdir(join(vault, '01_知识库'));
    await writeFile(join(vault, 'Index.md'), '# Index', 'utf8');
    await mkdir(join(vault, '00_模板'), { recursive: true });
    await writeFile(join(vault, '00_模板/读书笔记模板.md'), 'USER CONTENT', 'utf8');

    const report = await runInit({ vaultRoot: vault, pluginRoot: PLUGIN_ROOT });
    assert.equal(report.exitCode, 0);
    assert.equal(report.counters.dirsCreated, 6);    // 8 - 2 已存在 (01_知识库 + 00_模板 都被预创建了)
    assert.equal(report.counters.dirsSkipped, 2);
    assert.equal(report.counters.filesCopied, 2);    // 3 - 1 已存在 (读书笔记模板.md 已存在)
    assert.equal(report.counters.filesSkipped, 1);
    assert.equal(report.counters.placeholdersCreated, 2); // 3 - 1 (Index.md 已存在)
    assert.equal(report.claudeMd.status, 'created');
    assert.equal(await readFile(join(vault, '00_模板/读书笔记模板.md'), 'utf8'), 'USER CONTENT');
  });

  test('non-existent vault: exitCode 2 + vault-not-found error', async () => {
    const report = await runInit({
      vaultRoot: join(tmpRoot, 'never-existed'),
      pluginRoot: PLUGIN_ROOT,
    });
    assert.equal(report.exitCode, 2);
    assert.equal(report.errors[0].kind, 'vault-not-found');
  });

  test('file-as-vault: exitCode 2 + vault-is-file error', async () => {
    const vault = await makeVault('r3');
    const filePath = join(vault, 'i-am-a-file');
    await writeFile(filePath, 'x', 'utf8');
    const report = await runInit({
      vaultRoot: filePath,
      pluginRoot: PLUGIN_ROOT,
    });
    assert.equal(report.exitCode, 2);
    assert.equal(report.errors[0].kind, 'vault-is-file');
  });

  test('idempotent: second runInit on same vault → claudeMd.status === already-injected, no content duplication', async () => {
    const vault = await makeVault('r5');
    const r1 = await runInit({ vaultRoot: vault, pluginRoot: PLUGIN_ROOT });
    assert.equal(r1.claudeMd.status, 'created');

    // 记录首次 CLAUDE.md 字节数
    const claudePath = join(vault, 'CLAUDE.md');
    const size1 = (await readFile(claudePath, 'utf8')).length;

    // 第二次跑
    const r2 = await runInit({ vaultRoot: vault, pluginRoot: PLUGIN_ROOT });
    assert.equal(r2.claudeMd.status, 'already-injected', 'second run should report already-injected');
    assert.equal(r2.counters.dirsCreated, 0);  // 8 个都已存在
    assert.equal(r2.counters.dirsSkipped, 8);
    assert.equal(r2.counters.filesCopied, 0);  // 3 个都已存在
    assert.equal(r2.counters.filesSkipped, 3);
    assert.equal(r2.counters.placeholdersCreated, 0);  // 3 个都已存在
    assert.equal(r2.counters.placeholdersSkipped, 3);
    assert.equal(r2.errors.length, 0);
    assert.equal(r2.exitCode, 0);

    // 关键:CLAUDE.md 字节数必须不变
    const size2 = (await readFile(claudePath, 'utf8')).length;
    assert.equal(size2, size1, 'CLAUDE.md must not grow on second run');
  });
});

describe('injectClaudeMd', () => {
  test('empty vault: creates CLAUDE.md with template content wrapped in begin/end block (idempotency-ready)', async () => {
    const vault = await makeVault('i1');
    const result = await injectClaudeMd(vault, join(PLUGIN_ROOT, '00_模板/CLAUDE_Template.md'));
    assert.equal(result.status, 'created');
    const content = await readFile(join(vault, 'CLAUDE.md'), 'utf8');
    assert.ok(content.includes('仓库性质'));  // CLAUDE_Template.md 的特征内容
    assert.ok(content.includes(CLAUDE_BEGIN_MARKER));  // 首次创建也带 begin/end,确保幂等
    assert.ok(content.includes(CLAUDE_END_MARKER));
    // begin 必须在 end 之前
    assert.ok(content.indexOf(CLAUDE_BEGIN_MARKER) < content.indexOf(CLAUDE_END_MARKER));
  });

  test('existing CLAUDE.md (no block): appends begin/end block, preserves original', async () => {
    const vault = await makeVault('i2');
    await writeFile(join(vault, 'CLAUDE.md'), '# User Rules\n\nDO NOT DELETE.\n', 'utf8');
    const result = await injectClaudeMd(vault, join(PLUGIN_ROOT, '00_模板/CLAUDE_Template.md'));
    assert.equal(result.status, 'appended');
    const content = await readFile(join(vault, 'CLAUDE.md'), 'utf8');
    assert.ok(content.startsWith('# User Rules\n\nDO NOT DELETE.\n'),
      'original content should be preserved at start');
    assert.ok(content.includes(CLAUDE_BEGIN_MARKER));
    assert.ok(content.includes(CLAUDE_END_MARKER));
    // end 必须在 begin 之后
    assert.ok(content.indexOf(CLAUDE_BEGIN_MARKER) < content.indexOf(CLAUDE_END_MARKER));
  });

  test('already injected: skipped, file unchanged', async () => {
    const vault = await makeVault('i3');
    await writeFile(join(vault, 'CLAUDE.md'), '# User\n', 'utf8');
    await injectClaudeMd(vault, join(PLUGIN_ROOT, '00_模板/CLAUDE_Template.md'));
    const first = await readFile(join(vault, 'CLAUDE.md'), 'utf8');
    const result = await injectClaudeMd(vault, join(PLUGIN_ROOT, '00_模板/CLAUDE_Template.md'));
    assert.equal(result.status, 'already-injected');
    const second = await readFile(join(vault, 'CLAUDE.md'), 'utf8');
    assert.equal(first, second);
  });

  test('block manually removed: re-injects (appended status)', async () => {
    const vault = await makeVault('i4');
    await writeFile(join(vault, 'CLAUDE.md'), '# User\n', 'utf8');
    await injectClaudeMd(vault, join(PLUGIN_ROOT, '00_模板/CLAUDE_Template.md'));
    const before = await readFile(join(vault, 'CLAUDE.md'), 'utf8');
    const stripped = before.replace(
      new RegExp(`${CLAUDE_BEGIN_MARKER}[\\s\\S]*?${CLAUDE_END_MARKER}\\n?`),
      ''
    );
    await writeFile(join(vault, 'CLAUDE.md'), stripped, 'utf8');
    const result = await injectClaudeMd(vault, join(PLUGIN_ROOT, '00_模板/CLAUDE_Template.md'));
    assert.equal(result.status, 'appended');
  });
});

describe('ensureFileIfMissing', () => {
  test('creates empty file when missing', async () => {
    const vault = await makeVault('f1');
    const target = join(vault, 'Index.md');
    const result = await ensureFileIfMissing(target);
    assert.equal(result.created, true);
    assert.equal(result.path, target);
    assert.equal(await readFile(target, 'utf8'), '');
  });

  test('skips existing file, preserves content', async () => {
    const vault = await makeVault('f2');
    const target = join(vault, 'Index.md');
    await writeFile(target, 'EXISTING', 'utf8');
    const result = await ensureFileIfMissing(target);
    assert.equal(result.created, false);
    assert.equal(await readFile(target, 'utf8'), 'EXISTING');
  });

  test('creates missing parent directories', async () => {
    const vault = await makeVault('f3');
    const target = join(vault, 'deep/nested/Inbox/.gitkeep');
    const result = await ensureFileIfMissing(target);
    assert.equal(result.created, true);
    assert.equal(await readFile(target, 'utf8'), '');
  });
});