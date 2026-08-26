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
import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises';
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
  test('empty vault: 10 dirs + 5 placeholders + 4 assets + CLAUDE.md created', async () => {
    const vault = await makeVault('r1');
    const report = await runInit({ vaultRoot: vault, pluginRoot: PLUGIN_ROOT });
    assert.equal(report.exitCode, 0);
    assert.equal(report.counters.dirsCreated, 10);
    assert.equal(report.counters.dirsSkipped, 0);
    assert.equal(report.counters.filesCopied, 4);
    assert.equal(report.counters.filesSkipped, 0);
    assert.equal(report.counters.placeholdersCreated, 5);
    assert.equal(report.counters.placeholdersSkipped, 0);
    assert.equal(report.claudeMd.status, 'created');
    assert.equal(report.counters.scriptsWritten, 4);  // 4 个脚本被拷贝/覆盖到 vault
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
    assert.equal(report.counters.dirsCreated, 8);    // 10 - 2 已存在 (01_知识库 + 00_模板 都被预创建了)
    assert.equal(report.counters.dirsSkipped, 2);
    assert.equal(report.counters.filesCopied, 3);    // 4 - 1 已存在 (读书笔记模板.md 已存在)
    assert.equal(report.counters.filesSkipped, 1);
    assert.equal(report.counters.placeholdersCreated, 4); // 5 - 1 (Index.md 已存在)
    assert.equal(report.claudeMd.status, 'created');
    assert.equal(await readFile(join(vault, '00_模板/读书笔记模板.md'), 'utf8'), 'USER CONTENT');
    assert.equal(report.counters.scriptsWritten, 4);  // 脚本总是覆盖写,与资产不同
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

  test('idempotent: second runInit on same vault → claudeMd.status === refreshed, no content duplication', async () => {
    const vault = await makeVault('r5');
    const r1 = await runInit({ vaultRoot: vault, pluginRoot: PLUGIN_ROOT });
    assert.equal(r1.claudeMd.status, 'created');

    // 记录首次 CLAUDE.md 字节数
    const claudePath = join(vault, 'CLAUDE.md');
    const size1 = (await readFile(claudePath, 'utf8')).length;

    // 第二次跑
    const r2 = await runInit({ vaultRoot: vault, pluginRoot: PLUGIN_ROOT });
    assert.equal(r2.claudeMd.status, 'refreshed', 'second run should refresh (replace block in place), not skip or append');
    assert.equal(r2.counters.dirsCreated, 0);  // 10 个都已存在
    assert.equal(r2.counters.dirsSkipped, 10);
    assert.equal(r2.counters.filesCopied, 0);  // 4 个都已存在
    assert.equal(r2.counters.filesSkipped, 4);
    assert.equal(r2.counters.placeholdersCreated, 0);  // 5 个都已存在
    assert.equal(r2.counters.placeholdersSkipped, 5);
    assert.equal(r2.counters.scriptsWritten, 4);  // 第二次也覆盖写 4 个
    assert.equal(r2.errors.length, 0);
    assert.equal(r2.exitCode, 0);

    // 关键:CLAUDE.md 字节数必须不变(refresh 是 in-place 替换,不会膨胀)
    const size2 = (await readFile(claudePath, 'utf8')).length;
    assert.equal(size2, size1, 'CLAUDE.md must not grow on second run');
  });

  test('03_问答区/ + _cross/.gitkeep created on empty vault', async () => {
    const vault = await makeVault('r6');
    const report = await runInit({ vaultRoot: vault, pluginRoot: PLUGIN_ROOT });
    assert.equal(report.exitCode, 0);
    // 03_问答区/ 目录存在
    const qaDirStat = await stat(join(vault, '03_问答区'));
    assert.ok(qaDirStat.isDirectory(), '03_问答区/ must be a directory');
    // _cross/.gitkeep 占位存在
    const keepStat = await stat(join(vault, '03_问答区/_cross/.gitkeep'));
    assert.ok(keepStat.isFile(), '03_问答区/_cross/.gitkeep must be a file');
  });

  test('copies 4 plugin scripts to vault/scripts/ on empty vault (scriptsWritten=4)', async () => {
    const vault = await makeVault('rs1');
    const report = await runInit({ vaultRoot: vault, pluginRoot: PLUGIN_ROOT });
    assert.equal(report.counters.scriptsWritten, 4);
    assert.equal(report.errors.length, 0);
    // 4 个文件确实存在
    for (const rel of [
      'scripts/init-vault.mjs',
      'scripts/sync-pdf-notes.mjs',
      'scripts/check-update.mjs',
      'scripts/lint-wiki.mjs',
    ]) {
      const s = await stat(join(vault, rel));
      assert.ok(s.isFile(), `${rel} must exist in vault/scripts/`);
    }
  });

  test('overwrites user-modified scripts in vault/scripts/ on re-init (no copyIfMissing)', async () => {
    const vault = await makeVault('rs2');
    // 用户手工预放一个"被改过"的脚本
    await mkdir(join(vault, 'scripts'), { recursive: true });
    await writeFile(join(vault, 'scripts/init-vault.mjs'), '// USER MODIFIED CONTENT', 'utf8');

    const report = await runInit({ vaultRoot: vault, pluginRoot: PLUGIN_ROOT });
    assert.equal(report.exitCode, 0);
    assert.equal(report.counters.scriptsWritten, 4);  // 含覆盖的那 1 个
    // 用户修改**确实被覆盖**(断言内容哈希 == 源哈希)
    const pluginSrc = await readFile(join(PLUGIN_ROOT, 'scripts/init-vault.mjs'), 'utf8');
    const vaultDst = await readFile(join(vault, 'scripts/init-vault.mjs'), 'utf8');
    assert.equal(vaultDst, pluginSrc, 'user-modified script must be overwritten by plugin source');
    assert.ok(!vaultDst.includes('USER MODIFIED CONTENT'), 'user content must be gone');
  });

  test('missing one plugin script source: exitCode 3 + asset-missing error, other 3 still copied', async () => {
    const vault = await makeVault('rs3');
    // 临时把 sync-pdf-notes.mjs 移走,模拟"plugin 资产缺失"
    const original = join(PLUGIN_ROOT, 'scripts/sync-pdf-notes.mjs');
    const stash = join(PLUGIN_ROOT, 'scripts/sync-pdf-notes.mjs.stash');
    const { rename } = await import('node:fs/promises');
    await rename(original, stash);
    try {
      const report = await runInit({ vaultRoot: vault, pluginRoot: PLUGIN_ROOT });
      assert.equal(report.exitCode, 3);  // asset-missing 优先于 copy-failed
      const err = report.errors.find((e) => e.kind === 'asset-missing');
      assert.ok(err, 'must have asset-missing error');
      assert.equal(err.src, original);
      // 其他 3 个脚本仍被拷贝
      assert.equal(report.counters.scriptsWritten, 3);
      assert.equal(
        (await stat(join(vault, 'scripts/init-vault.mjs'))).isFile(),
        true,
        'init-vault.mjs must still be copied'
      );
      assert.equal(
        (await stat(join(vault, 'scripts/lint-wiki.mjs'))).isFile(),
        true,
        'lint-wiki.mjs must still be copied'
      );
    } finally {
      // 还原:无论 case pass/fail 都要把脚本放回去,避免污染后续测试
      await rename(stash, original);
    }
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

  test('already injected with stale template: refreshed (block replaced, outer context preserved)', async () => {
    const vault = await makeVault('i3');
    // 模拟"用户升级 plugin 后老 vault":开头 + 旧 begin/end 块 + 末尾
    const userHead = '# 用户自定义\n\nDO NOT DELETE.\n';
    const userTail = '\n## 用户尾部段落\n\n- 自定义项 A\n- 自定义项 B\n';
    const stale = `${userHead}\n${CLAUDE_BEGIN_MARKER}\n旧模板内容(已过期)\n${CLAUDE_END_MARKER}\n${userTail}`;
    await writeFile(join(vault, 'CLAUDE.md'), stale, 'utf8');

    const result = await injectClaudeMd(vault, join(PLUGIN_ROOT, '00_模板/CLAUDE_Template.md'));
    assert.equal(result.status, 'refreshed');
    const content = await readFile(join(vault, 'CLAUDE.md'), 'utf8');

    // 开头 + 结尾一字不动
    assert.ok(content.startsWith(userHead), 'user head must be preserved');
    assert.ok(content.endsWith(userTail), 'user tail must be preserved');
    // 旧模板内容已消失
    assert.ok(!content.includes('旧模板内容(已过期)'), 'stale template body must be gone');
    // 新模板特征内容出现
    assert.ok(content.includes('仓库性质'), 'new template body must be present');
    // begin/end 仍然唯一一份
    const beginCount = (content.match(new RegExp(CLAUDE_BEGIN_MARKER, 'g')) || []).length;
    const endCount = (content.match(new RegExp(CLAUDE_END_MARKER, 'g')) || []).length;
    assert.equal(beginCount, 1, 'exactly one begin marker');
    assert.equal(endCount, 1, 'exactly one end marker');
  });

  test('refresh does not duplicate the block even when run repeatedly', async () => {
    const vault = await makeVault('i3b');
    await writeFile(join(vault, 'CLAUDE.md'), '# User\n', 'utf8');
    await injectClaudeMd(vault, join(PLUGIN_ROOT, '00_模板/CLAUDE_Template.md'));
    const size1 = (await readFile(join(vault, 'CLAUDE.md'), 'utf8')).length;

    const r2 = await injectClaudeMd(vault, join(PLUGIN_ROOT, '00_模板/CLAUDE_Template.md'));
    assert.equal(r2.status, 'refreshed');
    const size2 = (await readFile(join(vault, 'CLAUDE.md'), 'utf8')).length;
    assert.equal(size2, size1, 'second run must not grow file');
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