/**
 * sync-pdf-notes.test.mjs
 *
 * Tests for sync-pdf-notes.mjs — both pure-function units and integration
 * scenarios against a synthetic vault in a temp directory.
 *
 * Run with: node --test scripts/sync-pdf-notes.test.mjs
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, sep, posix } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  parseArgs,
  toPosix,
  escapeYamlString,
  replaceAllPlaceholders,
  extractFrontmatter,
  buildNoteContent,
  runSync,
  exitCodeFor,
  ConfigError,
  fileExists,
  walkForPdfs,
  notePathForPdf,
} from './sync-pdf-notes.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(__dirname, 'sync-pdf-notes.mjs');

const TEMPLATE_FULL = `---
文章:
作者:
创建时间:
tags:
状态: false
source:
---


## 摘要

## 重点摘录

## 我的思考
`;

const TEMPLATE_BARE = `## 摘要

## 重点摘录
`;

function posixJoin(...parts) {
  return parts.filter(Boolean).join('/');
}

// ---------------------------------------------------------------------------
// Unit tests — pure functions, no IO
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  test('默认参数：cwd + 01_知识库 + 02_读书笔记 + 默认模板 + overwrite=true', () => {
    const args = parseArgs([]);
    assert.equal(args.vault, process.cwd());
    assert.equal(args.watch, '01_知识库');
    assert.equal(args.notes, '02_读书笔记');
    assert.equal(args.template, '00_模板/读书笔记模板.md');
    assert.equal(args.sourceField, 'source');
    assert.equal(args.overwrite, true);
  });

  test('解析 --key=value 形式', () => {
    const args = parseArgs(['--watch=99_测试', '--source-field=pdf', '--overwrite=false']);
    assert.equal(args.watch, '99_测试');
    assert.equal(args.sourceField, 'pdf');
    assert.equal(args.overwrite, false);
  });

  test('解析 --key value 形式', () => {
    const args = parseArgs(['--watch', '88_测试', '--notes', '88_笔记']);
    assert.equal(args.watch, '88_测试');
    assert.equal(args.notes, '88_笔记');
  });

  test('--overwrite 接受 true/false；其他写法视为 true', () => {
    assert.equal(parseArgs(['--overwrite=true']).overwrite, true);
    assert.equal(parseArgs(['--overwrite=false']).overwrite, false);
    assert.equal(parseArgs(['--overwrite']).overwrite, true); // 裸 flag → 'true' → true
  });

  test('已废弃的 --poll-ms 和 --backfill 被静默忽略，不影响其它参数', () => {
    const args = parseArgs(['--watch=01_知识库', '--poll-ms=500', '--backfill=false']);
    assert.equal(args.watch, '01_知识库');
    assert.equal(args.overwrite, true);
    // 不抛错即通过；具体忽略值（undefined / 'true'）不影响语义
  });
});

describe('toPosix', () => {
  test('反斜杠转斜杠', () => {
    assert.equal(toPosix('a\\b\\c'), 'a/b/c');
  });
  test('已是斜杠则不变', () => {
    assert.equal(toPosix('a/b/c'), 'a/b/c');
  });
});

describe('escapeYamlString', () => {
  test('转义反斜杠', () => {
    assert.equal(escapeYamlString('a\\b'), 'a\\\\b');
  });
  test('转义双引号', () => {
    assert.equal(escapeYamlString('say "hi"'), 'say \\"hi\\"');
  });
  test('无特殊字符则不变', () => {
    assert.equal(escapeYamlString('hello'), 'hello');
  });
  test('同时有反斜杠与双引号', () => {
    assert.equal(escapeYamlString('a\\"b'), 'a\\\\\\"b');
  });
});

describe('replaceAllPlaceholders', () => {
  test('按序替换多个占位符', () => {
    const out = replaceAllPlaceholders('hello {{name}}, age {{age}}', {
      '{{name}}': 'Alice',
      '{{age}}': '30',
    });
    assert.equal(out, 'hello Alice, age 30');
  });
  test('占位符不在文本中则不报错', () => {
    const out = replaceAllPlaceholders('nothing here', { '{{x}}': 'y' });
    assert.equal(out, 'nothing here');
  });
  test('空字符串替换', () => {
    const out = replaceAllPlaceholders('a{{x}}b', { '{{x}}': '' });
    assert.equal(out, 'ab');
  });
});

describe('extractFrontmatter', () => {
  test('正确分离 frontmatter 与正文', () => {
    const text = '---\nfoo: bar\n---\nbody content\n';
    const fm = extractFrontmatter(text);
    assert.ok(fm);
    assert.equal(fm.frontmatter, 'foo: bar');
    assert.equal(fm.body, 'body content\n');
  });
  test('无 frontmatter 返回 null', () => {
    assert.equal(extractFrontmatter('no frontmatter here'), null);
  });
  test('frontmatter 后正文为空字符串', () => {
    const fm = extractFrontmatter('---\nfoo: bar\n---\n');
    assert.ok(fm);
    assert.equal(fm.body, '');
  });
  test('支持 \\n 与 \\r\\n 行尾', () => {
    const fm = extractFrontmatter('---\r\nfoo: bar\r\n---\r\nbody');
    assert.ok(fm);
    assert.equal(fm.frontmatter, 'foo: bar');
    assert.equal(fm.body, 'body');
  });
});

describe('buildNoteContent', () => {
  test('模板为空时返回默认 frontmatter + 默认正文', () => {
    const out = buildNoteContent('', {
      title: '测试',
      pdfLink: '01_知识库/测试.pdf',
      created: '2026-06-14',
      sourceField: 'source',
    });
    assert.match(out, /^---/);
    assert.match(out, /文章: "测试"/);
    assert.match(out, /创建时间: "2026-06-14"/);
    assert.match(out, /source: "\[\[01_知识库\/测试\.pdf\]\]"/);
    assert.match(out, /## 摘要/);
  });

  test('完整模板：覆盖 frontmatter 中 文章/创建时间/source 行', () => {
    const out = buildNoteContent(TEMPLATE_FULL, {
      title: '新标题',
      pdfLink: '01_知识库/主题/新标题.pdf',
      created: '2026-06-14',
      sourceField: 'source',
    });
    assert.match(out, /文章: "新标题"/);
    assert.match(out, /创建时间: "2026-06-14"/);
    assert.match(out, /source: "\[\[01_知识库\/主题\/新标题\.pdf\]\]"/);
    // 模板中其它字段保留
    assert.match(out, /作者:/);
    assert.match(out, /tags:/);
    assert.match(out, /状态: false/);
  });

  test('模板 frontmatter 缺 source 字段时自动追加', () => {
    const tpl = `---\n文章:\n---\n\n## 摘要\n`;
    const out = buildNoteContent(tpl, {
      title: 'x',
      pdfLink: 'a.pdf',
      created: '2026-01-01',
      sourceField: 'source',
    });
    assert.match(out, /source: "\[\[a\.pdf\]\]"/);
  });

  test('sourceField 可自定义：新字段被正确写入；模板原 source 行不会被自动删除', () => {
    const out = buildNoteContent(TEMPLATE_FULL, {
      title: 'x',
      pdfLink: 'a.pdf',
      created: '2026-01-01',
      sourceField: 'pdfLink',
    });
    // 新 sourceField 行被正确写入
    assert.match(out, /pdfLink: "\[\[a\.pdf\]\]"/);
    // 模板里原有的 source: 行不会被自动覆盖或删除（与 watch 版行为一致）
    assert.match(out, /^source:/m);
  });

  test('正文模板占位符替换（{{source}} → 相对路径，[[ ]] 由模板自己包）', () => {
    // 与 watch 版一致：占位符只替换自身为相对路径，wiki 链接的 [[ ]] 由模板作者自己写。
    const tpl = '---\n---\n\n> 原文：[[{{source}}]]\n';
    const out = buildNoteContent(tpl, {
      title: 'x',
      pdfLink: '主题/书名.pdf',
      created: '2026-01-01',
      sourceField: 'source',
    });
    assert.match(out, /> 原文：\[\[主题\/书名\.pdf\]\]/);
  });
});

describe('exitCodeFor', () => {
  test('失败为 0 → 退出码 0', () => {
    assert.equal(
      exitCodeFor({ counters: { scanned: 3, created: 3, skipped: 0, failed: 0 } }),
      0
    );
  });
  test('存在失败 → 退出码 1', () => {
    assert.equal(
      exitCodeFor({ counters: { scanned: 3, created: 2, skipped: 0, failed: 1 } }),
      1
    );
  });
});

// ---------------------------------------------------------------------------
// Integration tests — synthetic vault in temp directory
// ---------------------------------------------------------------------------

/**
 * Create a fresh empty vault skeleton in a temp dir.
 * Returns { root, watch, notes, template } absolute paths + cleanup().
 */
async function makeVault() {
  const root = await mkdtemp(join(tmpdir(), 'sync-pdf-test-'));
  const watch = join(root, '01_知识库');
  const notes = join(root, '02_读书笔记');
  const template = join(root, '00_模板', '读书笔记模板.md');
  await mkdir(watch, { recursive: true });
  await mkdir(notes, { recursive: true });
  await mkdir(dirname(template), { recursive: true });
  await writeFile(template, TEMPLATE_FULL, 'utf8');
  return {
    root,
    watch,
    notes,
    template,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function touchPdf(filePath) {
  await mkdir(dirname(filePath), { recursive: true });
  // 空 PDF：脚本只读路径，不解析内容；保证大小为 0 即可。
  await writeFile(filePath, '', 'utf8');
}

describe('runSync integration', () => {
  let vault;
  beforeEach(async () => {
    vault = await makeVault();
  });
  after(async () => {
    if (vault) await vault.cleanup();
  });

  test('I1: 首次扫描：3 个新 PDF → 3 个新笔记', async () => {
    await touchPdf(join(vault.watch, 'a.pdf'));
    await touchPdf(join(vault.watch, '主题', 'b.pdf'));
    await touchPdf(join(vault.watch, '主题', '子目录', 'c.pdf'));

    const result = await runSync({
      vaultRoot: vault.root,
      watchRoot: vault.watch,
      notesDir: vault.notes,
      templatePath: vault.template,
      sourceField: 'source',
      overwrite: true,
    });

    assert.equal(result.counters.scanned, 3);
    assert.equal(result.counters.created, 3);
    assert.equal(result.counters.skipped, 0);
    assert.equal(result.counters.failed, 0);

    assert.ok(await fileExists(join(vault.notes, 'a.md')));
    assert.ok(await fileExists(join(vault.notes, '主题', 'b.md')));
    assert.ok(await fileExists(join(vault.notes, '主题', '子目录', 'c.md')));
  });

  test('I2: 重复扫描 + overwrite=true → 全部覆盖重写', async () => {
    await touchPdf(join(vault.watch, 'x.pdf'));
    const r1 = await runSync({
      vaultRoot: vault.root,
      watchRoot: vault.watch,
      notesDir: vault.notes,
      templatePath: vault.template,
      sourceField: 'source',
      overwrite: true,
    });
    assert.equal(r1.counters.created, 1);

    const notePath = join(vault.notes, 'x.md');
    const before = await readFile(notePath, 'utf8');

    const r2 = await runSync({
      vaultRoot: vault.root,
      watchRoot: vault.watch,
      notesDir: vault.notes,
      templatePath: vault.template,
      sourceField: 'source',
      overwrite: true,
    });
    assert.equal(r2.counters.scanned, 1);
    assert.equal(r2.counters.created, 1);
    assert.equal(r2.counters.skipped, 0);

    const after = await readFile(notePath, 'utf8');
    // 重写后内容应该相同（模板未变）；至少文件被覆盖写入
    assert.equal(after.length, before.length);
    assert.match(after, /文章: "x"/);
  });

  test('I3: 重复扫描 + overwrite=false → 全部跳过', async () => {
    await touchPdf(join(vault.watch, 'y.pdf'));
    await runSync({
      vaultRoot: vault.root,
      watchRoot: vault.watch,
      notesDir: vault.notes,
      templatePath: vault.template,
      sourceField: 'source',
      overwrite: true,
    });

    // 修改笔记，第二次扫描不应覆盖
    const notePath = join(vault.notes, 'y.md');
    await writeFile(notePath, 'CUSTOM CONTENT', 'utf8');

    const r2 = await runSync({
      vaultRoot: vault.root,
      watchRoot: vault.watch,
      notesDir: vault.notes,
      templatePath: vault.template,
      sourceField: 'source',
      overwrite: false,
    });
    assert.equal(r2.counters.scanned, 1);
    assert.equal(r2.counters.created, 0);
    assert.equal(r2.counters.skipped, 1);

    const after = await readFile(notePath, 'utf8');
    assert.equal(after, 'CUSTOM CONTENT');
  });

  test('I4: 嵌套子目录递归：01/子/a.pdf → 02/子/a.md', async () => {
    await touchPdf(join(vault.watch, '深度1', '深度2', '深度3', '书.pdf'));
    await runSync({
      vaultRoot: vault.root,
      watchRoot: vault.watch,
      notesDir: vault.notes,
      templatePath: vault.template,
      sourceField: 'source',
      overwrite: true,
    });
    assert.ok(await fileExists(join(vault.notes, '深度1', '深度2', '深度3', '书.md')));
  });

  test('I5: 非 PDF 文件被忽略', async () => {
    await touchPdf(join(vault.watch, 'a.pdf'));
    await writeFile(join(vault.watch, 'b.txt'), 'text', 'utf8');
    await writeFile(join(vault.watch, 'c.docx'), '', 'utf8');
    await mkdir(join(vault.watch, 'd'), { recursive: true });
    await writeFile(join(vault.watch, 'd', 'e.md'), '', 'utf8');

    const result = await runSync({
      vaultRoot: vault.root,
      watchRoot: vault.watch,
      notesDir: vault.notes,
      templatePath: vault.template,
      sourceField: 'source',
      overwrite: true,
    });
    assert.equal(result.counters.scanned, 1);
    assert.ok(await fileExists(join(vault.notes, 'a.md')));
    assert.ok(!(await fileExists(join(vault.notes, 'b.md'))));
  });

  test('I6: 跳过 .obsidian / .git / node_modules', async () => {
    await touchPdf(join(vault.watch, 'real.pdf'));
    await mkdir(join(vault.watch, '.obsidian'), { recursive: true });
    await touchPdf(join(vault.watch, '.obsidian', 'hide.pdf'));
    await mkdir(join(vault.watch, '.git'), { recursive: true });
    await touchPdf(join(vault.watch, '.git', 'hide.pdf'));
    await mkdir(join(vault.watch, 'node_modules'), { recursive: true });
    await touchPdf(join(vault.watch, 'node_modules', 'hide.pdf'));

    const result = await runSync({
      vaultRoot: vault.root,
      watchRoot: vault.watch,
      notesDir: vault.notes,
      templatePath: vault.template,
      sourceField: 'source',
      overwrite: true,
    });
    assert.equal(result.counters.scanned, 1);
  });

  test('I7: 模板缺失 → ConfigError', async () => {
    await touchPdf(join(vault.watch, 'a.pdf'));
    const badTemplate = join(vault.root, 'no-such-template.md');
    await assert.rejects(
      runSync({
        vaultRoot: vault.root,
        watchRoot: vault.watch,
        notesDir: vault.notes,
        templatePath: badTemplate,
        sourceField: 'source',
        overwrite: true,
      }),
      (err) => err instanceof ConfigError && /Template not found/.test(err.message)
    );
  });

  test('I8: watch 目录缺失 → ConfigError', async () => {
    const badWatch = join(vault.root, 'no-such-watch');
    await assert.rejects(
      runSync({
        vaultRoot: vault.root,
        watchRoot: badWatch,
        notesDir: vault.notes,
        templatePath: vault.template,
        sourceField: 'source',
        overwrite: true,
      }),
      (err) => err instanceof ConfigError && /Watch directory not found/.test(err.message)
    );
  });

  test('I9: 文件名含中文与空格', async () => {
    await touchPdf(join(vault.watch, '深度学习 入门指南.pdf'));
    await runSync({
      vaultRoot: vault.root,
      watchRoot: vault.watch,
      notesDir: vault.notes,
      templatePath: vault.template,
      sourceField: 'source',
      overwrite: true,
    });
    const notePath = join(vault.notes, '深度学习 入门指南.md');
    assert.ok(await fileExists(notePath));
    const content = await readFile(notePath, 'utf8');
    assert.match(content, /文章: "深度学习 入门指南"/);
  });

  test('I10: 笔记 frontmatter 字段完整（中文 source 链接）', async () => {
    await touchPdf(join(vault.watch, '主题', '论文.pdf'));
    await runSync({
      vaultRoot: vault.root,
      watchRoot: vault.watch,
      notesDir: vault.notes,
      templatePath: vault.template,
      sourceField: 'source',
      overwrite: true,
    });
    const content = await readFile(join(vault.notes, '主题', '论文.md'), 'utf8');
    assert.match(content, /^---/);
    assert.match(content, /文章: "论文"/);
    assert.match(content, /作者:/);
    assert.match(content, /创建时间: "\d{4}-\d{2}-\d{2}"/);
    assert.match(content, /tags:/);
    assert.match(content, /状态: false/);
    assert.match(content, /source: "\[\[01_知识库\/主题\/论文\.pdf\]\]"/);
    assert.match(content, /## 摘要/);
    assert.match(content, /## 重点摘录/);
    assert.match(content, /## 我的思考/);
  });
});

// ---------------------------------------------------------------------------
// End-to-end (spawn child) tests — verify CLI exit codes
// ---------------------------------------------------------------------------

describe('CLI end-to-end (spawn)', () => {
  let vault;
  beforeEach(async () => {
    vault = await makeVault();
  });
  after(async () => {
    if (vault) await vault.cleanup();
  });

  test('成功路径 → 退出码 0', async () => {
    await touchPdf(join(vault.watch, 'a.pdf'));
    const r = spawnSync(
      process.execPath,
      [
        SCRIPT_PATH,
        `--vault=${vault.root}`,
        '--overwrite=false',
      ],
      { encoding: 'utf8' }
    );
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /Done\. Scanned=1 Created=1 Skipped=0 Failed=0/);
    assert.ok(await fileExists(join(vault.notes, 'a.md')));
  });

  test('缺失模板 → 退出码 2', async () => {
    const r = spawnSync(
      process.execPath,
      [
        SCRIPT_PATH,
        `--vault=${vault.root}`,
        `--template=00_模板/不存在.md`,
      ],
      { encoding: 'utf8' }
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Template not found/);
  });
});