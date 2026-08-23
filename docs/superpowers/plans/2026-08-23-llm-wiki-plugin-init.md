# llm-wiki-plugin-init Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `llm-wiki-plugin` 增加 `llm-wiki-plugin-init` skill，让用户在新 vault 上"说一句触发词 → 一份控制台报告"完成冷启动初始化（创建 8 目录 + 2 顶层 md + Inbox/.gitkeep 占位 + 拷贝 3 个资产 + 把 CLAUDE_Template.md 注入到 vault/CLAUDE.md 末尾 begin/end 包裹区）。

**Architecture:** A 方案 — `skills/llm-wiki-plugin-init/SKILL.md` 负责 LLM 流程指引（问路径 / 调脚本 / 渲染报告），`scripts/init-vault.mjs` 负责纯 IO（`fs.access` + `mkdir` + `copyFile`），`scripts/init-vault.test.mjs` 跑 `node --test` 单测。脚本导出 6 个纯函数 + 1 个 `runInit` 集成函数；CLI 入口仅在被直接执行（`import.meta.url === pathToFileURL(process.argv[1]).href`）时触发。

**Tech Stack:** Node.js ≥18（已与 `lint-wiki.mjs` 同环境）、`node:fs/promises`、`node:path`、`node:test` runner、ESM 模块（`.mjs`）。

**Spec:** `docs/superpowers/specs/2026-08-23-llm-wiki-plugin-init-design.md` (commit `abcdcb3`)

---

## Wiki Structure 来源与清单

源：`10_schema/config.md §1`（8 目录 + 2 顶层 md）：

```js
// scripts/init-vault.mjs 顶层常量
export const DIRECTORIES = [
  '01_知识库',
  '02_读书笔记',
  '11_entities',
  '12_concepts',
  'Inbox',
  '00_模板',         // plugin 自带资产,创建后由 copyIfMissing 填入模板
  '10_schema',       // plugin 自带资产,创建后由 copyIfMissing 填入 config.md
  '附件文件夹',     // 当前附件目录（用户 / Obsidian 通用习惯）
];

export const TOP_LEVEL_MD = ['Index.md', 'Log.md'];
export const PLACEHOLDER_FILES = ['Inbox/.gitkeep'];
```

**注**：spec 原文写"14 目录 + 5 顶层 md"，已与 §1 实际内容对齐为"8 目录 + 2 顶层 md + 1 占位"。`.obsidian/` 不在 §1，**本期不创建**（让 Obsidian 首次打开自动生成）。

---

## 资产拷贝清单

| 源（pluginRoot 相对路径） | 目标（vaultRoot 相对路径） | 策略 |
|---|---|---|
| `00_模板/读书笔记模板.md` | `00_模板/读书笔记模板.md` | copy-if-missing |
| `00_模板/标签词表.md` | `00_模板/标签词表.md` | copy-if-missing |
| `10_schema/config.md` | `10_schema/config.md` | copy-if-missing |
| `00_模板/CLAUDE_Template.md` | `CLAUDE.md` | 末尾追加 begin/end 包裹区（不拷贝模板文件本身） |

---

## File Structure

| 文件 | 责任 |
|---|---|
| `skills/llm-wiki-plugin-init/SKILL.md` | LLM 流程指引：问路径 → 调脚本 → 渲染报告 |
| `scripts/init-vault.mjs` | 6 纯函数 + runInit 集成 + CLI 入口 |
| `scripts/init-vault.test.mjs` | node --test 单测（11 例） |
| `README.md`（plugin 仓根） | 新增 1 行触发词 + 1 段 vault 初始化说明 |

---

## Tasks

### Task 1: 创建 init-vault.mjs 骨架 + 6 纯函数

**Files:**
- Create: `f:/llm-wiki-plugin/scripts/init-vault.mjs`
- Test: `f:/llm-wiki-plugin/scripts/init-vault.test.mjs`

- [ ] **Step 1: 写失败测试 — ensureDir 行为**

创建 `scripts/init-vault.test.mjs`：

```js
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
import { mkdtemp, mkdir, writeFile, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ensureDir,
  copyIfMissing,
  ensureVaultRoot,
  injectClaudeMd,
  runInit,
  DIRECTORIES,
  TOP_LEVEL_MD,
  PLACEHOLDER_FILES,
} from './init-vault.mjs';

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
    const result = await ensureDir(join(vault, '01_知识库'));
    assert.equal(result.created, true);
  });

  test('skips existing directory', async () => {
    const vault = await makeVault('d2');
    await mkdir(join(vault, '01_知识库'));
    const result = await ensureDir(join(vault, '01_知识库'));
    assert.equal(result.created, false);
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
    assert.equal(await readFile(dst, 'utf8'), 'hello');
  });

  test('skips when dst exists', async () => {
    const vault = await makeVault('c2');
    const src = join(vault, 'src.md');
    const dst = join(vault, 'dst.md');
    await writeFile(src, 'NEW', 'utf8');
    await writeFile(dst, 'OLD', 'utf8');
    const result = await copyIfMissing(src, dst);
    assert.equal(result.action, 'skipped');
    assert.equal(await readFile(dst, 'utf8'), 'OLD'); // 原内容不动
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd "f:/llm-wiki-plugin" && node --test scripts/init-vault.test.mjs
```

期望：FAIL（"Cannot find module './init-vault.mjs'"）。

- [ ] **Step 3: 写 init-vault.mjs 最小实现**

创建 `scripts/init-vault.mjs`：

```js
#!/usr/bin/env node
/**
 * init-vault.mjs — 一键初始化 Obsidian vault 为 llm-wiki-plugin 兼容结构
 *
 * 用法：
 *   node scripts/init-vault.mjs <vaultRoot> [--plugin-root=<path>]
 *
 * 行为：
 *   1. ensureVaultRoot(vaultRoot) — 校验存在且是目录
 *   2. 创建 8 个 wiki 目录（已存在跳过）
 *   3. 创建 2 个顶层 md 占位 + Inbox/.gitkeep（已存在跳过）
 *   4. 拷贝 3 个 plugin 资产到 vault 同名位置（已存在跳过）
 *   5. 把 plugin 的 00_模板/CLAUDE_Template.md 内容追加到 vault/CLAUDE.md
 *      （begin/end 包裹，幂等检测）
 *   6. stdout 输出 JSON 报告，exit code: 0=成功, 2=vault 不存在, 3=资产缺失
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PLUGIN_ROOT = path.resolve(__dirname, '..');

export const DIRECTORIES = [
  '01_知识库',
  '02_读书笔记',
  '11_entities',
  '12_concepts',
  'Inbox',
  '00_模板',
  '10_schema',
  '附件文件夹',
];

export const TOP_LEVEL_MD = ['Index.md', 'Log.md'];
export const PLACEHOLDER_FILES = ['Inbox/.gitkeep'];

const CLAUDE_BEGIN = '<!-- llm-wiki-plugin-init:begin -->';
const CLAUDE_END = '<!-- llm-wiki-plugin-init:end -->';

/**
 * 校验 vaultRoot 存在且是目录。
 * @returns {Promise<{ok: true} | {ok: false, error: object}>}
 */
export async function ensureVaultRoot(vaultRoot) {
  try {
    const stat = await fs.stat(vaultRoot);
    if (!stat.isDirectory()) {
      return { ok: false, error: { kind: 'vault-is-file', path: vaultRoot } };
    }
    return { ok: true };
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { ok: false, error: { kind: 'vault-not-found', path: vaultRoot } };
    }
    return { ok: false, error: { kind: 'vault-stat-failed', path: vaultRoot, message: e.message } };
  }
}

/**
 * 创建目录（幂等）。返回 {created: bool, path}
 */
export async function ensureDir(dirPath) {
  try {
    await fs.mkdir(dirPath, { recursive: true });
    // recursive:true 在已存在时不抛错,但也不告诉我们是新建还是已存在
    // 二次 stat 区分
    const stat = await fs.stat(dirPath);
    return { created: stat.birthtimeMs === stat.mtimeMs && Date.now() - stat.mtimeMs < 1000, path: dirPath };
  } catch (e) {
    if (e.code === 'EEXIST') return { created: false, path: dirPath };
    throw e;
  }
}

/**
 * copy-if-missing。返回 {action: 'copied'|'skipped'|'failed', src, dst, error?}
 */
export async function copyIfMissing(src, dst) {
  try {
    await fs.access(dst);
    return { action: 'skipped', src, dst };
  } catch {
    // dst 不存在 → 拷贝
  }
  try {
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(src, dst);
    return { action: 'copied', src, dst };
  } catch (e) {
    return { action: 'failed', src, dst, error: { kind: 'copy-failed', message: e.message } };
  }
}

/**
 * 把 CLAUDE_Template.md 内容追加到 vault/CLAUDE.md（幂等）。
 * @returns {Promise<{status: 'created'|'appended'|'already-injected', path: string}>}
 */
export async function injectClaudeMd(vaultRoot, templatePath) {
  const claudePath = path.join(vaultRoot, 'CLAUDE.md');
  let existing = '';
  let exists = false;
  try {
    existing = await fs.readFile(claudePath, 'utf8');
    exists = true;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  if (exists && existing.includes(CLAUDE_BEGIN)) {
    return { status: 'already-injected', path: claudePath };
  }

  const template = await fs.readFile(templatePath, 'utf8');
  // 去模板末尾换行,避免和 begin 标记产生空行
  const trimmed = template.replace(/\r?\n+$/, '');
  const block = `\n\n${CLAUDE_BEGIN}\n${trimmed}\n${CLAUDE_END}\n`;

  if (!exists) {
    await fs.writeFile(claudePath, `${trimmed}\n`, 'utf8');
    return { status: 'created', path: claudePath };
  }

  await fs.appendFile(claudePath, block, 'utf8');
  return { status: 'appended', path: claudePath };
}
```

- [ ] **Step 4: 跑测试确认 4 例通过**

```bash
cd "f:/llm-wiki-plugin" && node --test scripts/init-vault.test.mjs
```

期望：4 passed（ensureDir × 2 + copyIfMissing × 2）。

> 注：`ensureDir` 的 `created` 判定用 `birthtime === mtime` 在 Linux/macOS 有效；Windows NTFS 行为不同（birthtime 与 mtime 一致），需改判定。Windows 上 `mkdir recursive:true` 已存在目录不会刷 mtime，所以用 `access` 检测更可靠。
>
> **修订**（覆盖 Step 3 的 ensureDir 实现）：

```js
export async function ensureDir(dirPath) {
  try {
    await fs.access(dirPath);
    return { created: false, path: dirPath };
  } catch {
    // 不存在
  }
  await fs.mkdir(dirPath, { recursive: true });
  return { created: true, path: dirPath };
}
```

将上面的 `ensureDir` 实现替换为本版。重跑测试应仍 4 passed。

- [ ] **Step 5: 提交**

```bash
cd "f:/llm-wiki-plugin" && git add scripts/init-vault.mjs scripts/init-vault.test.mjs && git -c user.name=zhigangliu-bot -c user.email=zhigangliu-bot@users.noreply.github.com commit -m "feat(init-vault): scaffold + ensureDir + copyIfMissing + injectClaudeMd (4 unit tests)"
```

---

### Task 2: 加 runInit 集成函数 + 2 集成测试

**Files:**
- Modify: `f:/llm-wiki-plugin/scripts/init-vault.mjs`（追加 `runInit`）
- Modify: `f:/llm-wiki-plugin/scripts/init-vault.test.mjs`（追加 4 集成测试 + 4 CLAUDE.md 注入测试）

- [ ] **Step 1: 追加失败测试 — runInit 集成 + injectClaudeMd**

在 `init-vault.test.mjs` 末尾追加：

```js
describe('runInit (integration)', () => {
  test('empty vault: all dirs + placeholders + assets copied', async () => {
    const vault = await makeVault('r1');
    // 需要 pluginRoot 指向真实 plugin 仓,不然资产读不到
    const report = await runInit({ vaultRoot: vault, pluginRoot: DEFAULT_PLUGIN_ROOT });
    assert.equal(report.exitCode, 0);
    assert.equal(report.counters.dirsCreated, 8);
    assert.equal(report.counters.dirsSkipped, 0);
    assert.equal(report.counters.filesCopied, 3);
    assert.equal(report.counters.filesSkipped, 0);
    assert.equal(report.counters.placeholdersCreated, 3);
    assert.equal(report.claudeMd.status, 'created');
    assert.equal(report.errors.length, 0);
  });

  test('half-init vault: 部分创建/部分跳过', async () => {
    const vault = await makeVault('r2');
    // 预先建 01_知识库 + Index.md,模拟半初始化
    await mkdir(join(vault, '01_知识库'));
    await writeFile(join(vault, 'Index.md'), '# Index', 'utf8');
    // 预先拷贝 00_模板/读书笔记模板.md,模拟已存在
    await mkdir(join(vault, '00_模板'), { recursive: true });
    await writeFile(join(vault, '00_模板/读书笔记模板.md'), 'USER CONTENT', 'utf8');

    const report = await runInit({ vaultRoot: vault, pluginRoot: DEFAULT_PLUGIN_ROOT });
    assert.equal(report.exitCode, 0);
    assert.equal(report.counters.dirsCreated, 7);    // 8 - 1 已存在
    assert.equal(report.counters.dirsSkipped, 1);
    assert.equal(report.counters.filesCopied, 2);    // 3 - 1 已存在
    assert.equal(report.counters.filesSkipped, 1);
    assert.equal(report.counters.placeholdersCreated, 2); // 3 - 1 (Index.md 已存在)
    assert.equal(report.claudeMd.status, 'created');
    // 验证 user 内容未覆盖
    assert.equal(await readFile(join(vault, '00_模板/读书笔记模板.md'), 'utf8'), 'USER CONTENT');
  });

  test('non-existent vault: exit code 2 + vault-not-found error', async () => {
    const report = await runInit({
      vaultRoot: join(tmpRoot, 'never-existed'),
      pluginRoot: DEFAULT_PLUGIN_ROOT,
    });
    assert.equal(report.exitCode, 2);
    assert.equal(report.errors[0].kind, 'vault-not-found');
  });

  test('file-as-vault: exit code 2 + vault-is-file error', async () => {
    const vault = await makeVault('r3');
    const filePath = join(vault, 'i-am-a-file');
    await writeFile(filePath, 'x', 'utf8');
    const report = await runInit({
      vaultRoot: filePath,
      pluginRoot: DEFAULT_PLUGIN_ROOT,
    });
    assert.equal(report.exitCode, 2);
    assert.equal(report.errors[0].kind, 'vault-is-file');
  });
});

describe('injectClaudeMd', () => {
  test('empty vault: creates CLAUDE.md with template content', async () => {
    const vault = await makeVault('i1');
    const result = await injectClaudeMd(vault, join(DEFAULT_PLUGIN_ROOT, '00_模板/CLAUDE_Template.md'));
    assert.equal(result.status, 'created');
    const content = await readFile(join(vault, 'CLAUDE.md'), 'utf8');
    assert.ok(content.includes('仓库性质')); // CLAUDE_Template.md 的特征内容
    assert.ok(!content.includes('llm-wiki-plugin-init:begin')); // 首次创建不带 begin/end
  });

  test('existing CLAUDE.md (no block): appends begin/end block, preserves original', async () => {
    const vault = await makeVault('i2');
    await writeFile(join(vault, 'CLAUDE.md'), '# User Rules\n\nDO NOT DELETE.\n', 'utf8');
    const result = await injectClaudeMd(vault, join(DEFAULT_PLUGIN_ROOT, '00_模板/CLAUDE_Template.md'));
    assert.equal(result.status, 'appended');
    const content = await readFile(join(vault, 'CLAUDE.md'), 'utf8');
    assert.ok(content.startsWith('# User Rules\n\nDO NOT DELETE.\n'));
    assert.ok(content.includes(CLAUDE_BEGIN));
    assert.ok(content.includes(CLAUDE_END));
  });

  test('already injected: skipped=true, file unchanged', async () => {
    const vault = await makeVault('i3');
    await writeFile(join(vault, 'CLAUDE.md'), '# User\n', 'utf8');
    await injectClaudeMd(vault, join(DEFAULT_PLUGIN_ROOT, '00_模板/CLAUDE_Template.md'));
    const first = await readFile(join(vault, 'CLAUDE.md'), 'utf8');
    const result = await injectClaudeMd(vault, join(DEFAULT_PLUGIN_ROOT, '00_模板/CLAUDE_Template.md'));
    assert.equal(result.status, 'already-injected');
    const second = await readFile(join(vault, 'CLAUDE.md'), 'utf8');
    assert.equal(first, second);
  });

  test('block manually removed: re-injects', async () => {
    const vault = await makeVault('i4');
    await writeFile(join(vault, 'CLAUDE.md'), '# User\n', 'utf8');
    await injectClaudeMd(vault, join(DEFAULT_PLUGIN_ROOT, '00_模板/CLAUDE_Template.md'));
    // 用户手工删了 begin/end 块（保留其他内容）
    const before = await readFile(join(vault, 'CLAUDE.md'), 'utf8');
    const stripped = before.replace(/<!-- llm-wiki-plugin-init:begin -->[\s\S]*<!-- llm-wiki-plugin-init:end -->\n?/, '');
    await writeFile(join(vault, 'CLAUDE.md'), stripped, 'utf8');
    const result = await injectClaudeMd(vault, join(DEFAULT_PLUGIN_ROOT, '00_模板/CLAUDE_Template.md'));
    assert.equal(result.status, 'appended');
  });
});

// 辅助常量:让测试能直接 import
const DEFAULT_PLUGIN_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
import path from 'node:path';
```

> **注意**：上面末尾的 `DEFAULT_PLUGIN_ROOT` + `import path` 块要放到文件最顶部 imports 区域（Step 1 顶部的 `import { ... } from './init-vault.mjs';` 之后），不能放末尾。**整理成最终形态**：

```js
// 顶部 imports
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ensureDir,
  copyIfMissing,
  ensureVaultRoot,
  injectClaudeMd,
  runInit,
  DIRECTORIES,
  TOP_LEVEL_MD,
  PLACEHOLDER_FILES,
  CLAUDE_BEGIN_MARKER,
  CLAUDE_END_MARKER,
} from './init-vault.mjs';

const __test_filename = fileURLToPath(import.meta.url);
const __test_dirname = dirname(__test_filename);
const DEFAULT_PLUGIN_ROOT = resolve(__test_dirname, '..');
```

然后删掉末尾的 `const DEFAULT_PLUGIN_ROOT = ...` 重复声明和 `import path from 'node:path'`。

- [ ] **Step 2: 跑测试确认新 8 例失败**

```bash
cd "f:/llm-wiki-plugin" && node --test scripts/init-vault.test.mjs
```

期望：8 failed（"runInit is not a function" / "CLAUDE_BEGIN_MARKER is not exported"）。

- [ ] **Step 3: 追加 runInit + 导出常量到 init-vault.mjs**

在 `injectClaudeMd` 函数之后追加：

```js
/**
 * 把模板内容 + begin/end 包裹追加到 vault/CLAUDE.md。
 * 导出常量供测试与 SKILL.md 引用。
 */
export const CLAUDE_BEGIN_MARKER = CLAUDE_BEGIN;
export const CLAUDE_END_MARKER = CLAUDE_END;

/**
 * 一站式初始化。vaultRoot 校验失败时仍返回 report(exitCode=2),
 * 不抛异常,让调用方决定怎么处理退出码。
 *
 * @param {object} opts
 * @param {string} opts.vaultRoot
 * @param {string} [opts.pluginRoot]
 * @returns {Promise<{exitCode: number, counters: object, claudeMd: object, errors: object[]}>}
 */
export async function runInit({ vaultRoot, pluginRoot = DEFAULT_PLUGIN_ROOT }) {
  const errors = [];
  const counters = {
    dirsCreated: 0,
    dirsSkipped: 0,
    filesCopied: 0,
    filesSkipped: 0,
    placeholdersCreated: 0,
    placeholdersSkipped: 0,
  };

  // 1. 校验 vault
  const v = await ensureVaultRoot(vaultRoot);
  if (!v.ok) {
    return { exitCode: 2, counters, claudeMd: { status: 'skipped' }, errors: [v.error] };
  }

  // 2. 创建 8 目录
  for (const d of DIRECTORIES) {
    const r = await ensureDir(path.join(vaultRoot, d));
    if (r.created) counters.dirsCreated++;
    else counters.dirsSkipped++;
  }

  // 3. 拷贝 3 个资产
  const assetMap = [
    ['00_模板/读书笔记模板.md', '00_模板/读书笔记模板.md'],
    ['00_模板/标签词表.md', '00_模板/标签词表.md'],
    ['10_schema/config.md', '10_schema/config.md'],
  ];
  for (const [relSrc, relDst] of assetMap) {
    const src = path.join(pluginRoot, relSrc);
    const dst = path.join(vaultRoot, relDst);
    try {
      await fs.access(src);
    } catch {
      errors.push({ kind: 'asset-missing', src });
      continue;
    }
    const r = await copyIfMissing(src, dst);
    if (r.action === 'copied') counters.filesCopied++;
    else if (r.action === 'skipped') counters.filesSkipped++;
    else if (r.action === 'failed') errors.push(r.error);
  }

  // 4. 顶层 md + Inbox/.gitkeep
  for (const f of [...TOP_LEVEL_MD, ...PLACEHOLDER_FILES]) {
    const fp = path.join(vaultRoot, f);
    try {
      await fs.access(fp);
      counters.placeholdersSkipped++;
    } catch {
      await fs.mkdir(path.dirname(fp), { recursive: true });
      await fs.writeFile(fp, '', 'utf8');
      counters.placeholdersCreated++;
    }
  }

  // 5. CLAUDE.md 注入
  let claudeMd = { status: 'skipped' };
  try {
    claudeMd = await injectClaudeMd(vaultRoot, path.join(pluginRoot, '00_模板/CLAUDE_Template.md'));
  } catch (e) {
    errors.push({ kind: 'claude-md-failed', message: e.message });
  }

  // 退出码：3 = 资产缺失,4 = copy-failed,2 = vault 错误
  let exitCode = 0;
  if (errors.some((e) => e.kind === 'asset-missing' || e.kind === 'claude-md-failed')) exitCode = 3;
  else if (errors.some((e) => e.kind === 'copy-failed')) exitCode = 4;
  return { exitCode, counters, claudeMd, errors };
}

/* ===================== CLI 入口 ===================== */

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1 || args[0].startsWith('--')) {
    console.error('用法: node scripts/init-vault.mjs <vaultRoot> [--plugin-root=<path>]');
    process.exit(64); // EX_USAGE
  }
  const vaultRoot = path.resolve(args[0]);
  let pluginRoot = DEFAULT_PLUGIN_ROOT;
  for (const a of args.slice(1)) {
    if (a.startsWith('--plugin-root=')) {
      pluginRoot = path.resolve(a.slice('--plugin-root='.length));
    }
  }
  const report = await runInit({ vaultRoot, pluginRoot });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.exitCode);
}

// 仅在直接执行时跑 CLI（被 import 时不触发）
const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

// 顶部加: import { pathToFileURL } from 'node:url';
if (isMain) {
  main().catch((e) => {
    console.error('init-vault.mjs 崩溃:', e);
    process.exit(1);
  });
}
```

**顶部 imports 调整**（在 `import { fileURLToPath } from 'node:url';` 行后追加）：

```js
import { fileURLToPath, pathToFileURL } from 'node:url';
```

- [ ] **Step 4: 跑全部测试确认 12 例通过**

```bash
cd "f:/llm-wiki-plugin" && node --test scripts/init-vault.test.mjs
```

期望：12 passed（4 单元 + 4 集成 + 4 CLAUDE.md 注入），0 failed。

- [ ] **Step 5: CLI 烟雾测试（不进测试文件，临时跑）**

```bash
cd "f:/llm-wiki-plugin" && node -e '
import("./scripts/init-vault.mjs").then(async ({runInit}) => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const v = await mkdtemp(join(tmpdir(), "iv-cli-"));
  const r = await runInit({vaultRoot: v});
  console.log(JSON.stringify(r, null, 2));
  await rm(v, {recursive: true, force: true});
});
'
```

期望：stdout 含 `"exitCode": 0`，`counters.dirsCreated === 8`，`counters.filesCopied === 3`，`counters.placeholdersCreated === 3`，`claudeMd.status === "created"`。

- [ ] **Step 6: 提交**

```bash
cd "f:/llm-wiki-plugin" && git add scripts/init-vault.mjs scripts/init-vault.test.mjs && git -c user.name=zhigangliu-bot -c user.email=zhigangliu-bot@users.noreply.github.com commit -m "feat(init-vault): add runInit orchestrator + CLI entry (12 tests pass)"
```

---

### Task 3: 写 SKILL.md

**Files:**
- Create: `f:/llm-wiki-plugin/skills/llm-wiki-plugin-init/SKILL.md`

- [ ] **Step 1: 创建 skill 目录 + SKILL.md**

```bash
mkdir -p "f:/llm-wiki-plugin/skills/llm-wiki-plugin-init"
```

`f:/llm-wiki-plugin/skills/llm-wiki-plugin-init/SKILL.md`：

````markdown
---
name: llm-wiki-plugin-init
description: 初始化 vault、Inbox、新建知识库
---

# 触发条件

当用户说：初始化 vault、初始化知识库、新建 vault、cold start、init vault

# 流程

## 步骤 1: 问 vault 路径

LLM 用 AskUserQuestion 工具问用户："请提供 vault 路径（绝对路径，例如 `D:/my-vault`）。**注意：路径若已存在内容，会跳过同名文件,不会覆盖**。"

## 步骤 2: 校验 + 调脚本

```bash
cd "f:/llm-wiki-plugin" && node scripts/init-vault.mjs "<vaultRoot>"
```

脚本会输出 JSON 报告到 stdout（结构见 spec §输出格式）。

## 步骤 3: 把 JSON 翻译成中文报告输出

按以下模板渲染：

```text
vault: <vaultRoot>
创建目录: <N> (新) / <M> (已存在)
拷贝文件: <P> (新) / <Q> (已跳过,保留你的修改)
顶层 md: <R> 个占位文件
CLAUDE.md: <created | appended | already-injected>
错误: <count>

<如有错误,列出每个 kind + path>

✅ vault 已就绪。下一步：
   - 整理 Inbox → obsidian-collacting
   - 健康检查 → lint-wiki
   - 反向链接 → knowledge-graph-sync
```

## 步骤 4: 失败兜底

- `exitCode === 2` → vault 不存在或不是目录,告诉用户去检查路径
- `exitCode === 3` → plugin 资产缺失,提示用户重装 plugin
- `exitCode === 4` → copy-failed,告诉用户检查 vault 写入权限
- `exitCode === 64` → 命令行参数错误(LLM 不会触发,防御性)
- 任何 exitCode > 0 → 主对话**不**自动重试,等用户确认

# 边界

- **不覆盖** vault 已存在的资产文件
- **不覆盖** vault/CLAUDE.md 的非 begin/end 段（仅在末尾追加）
- **不删除** vault 任何文件
- **不创建** `.obsidian/`（Obsidian 首次打开自动生成）
- 重复调用 init 是安全的(幂等);同一 vault 第二次跑只输出更多"已存在"

# 资产清单

详见 spec `docs/superpowers/specs/2026-08-23-llm-wiki-plugin-init-design.md`。
来源均为 `f:/llm-wiki-plugin/` 仓根的 `00_模板/` 与 `10_schema/`。
````

- [ ] **Step 2: 提交**

```bash
cd "f:/llm-wiki-plugin" && git add skills/llm-wiki-plugin-init/SKILL.md && git -c user.name=zhigangliu-bot -c user.email=zhigangliu-bot@users.noreply.github.com commit -m "feat(skill): add llm-wiki-plugin-init (4-step flow + idempotent contract)"
```

---

### Task 4: 在 plugin README.md 补触发词 + vault 初始化段

**Files:**
- Modify: `f:/llm-wiki-plugin/README.md`

- [ ] **Step 1: 读 README 当前结构**

```bash
cd "f:/llm-wiki-plugin" && head -50 README.md
```

确认现有结构（已有 3 skill 段,需在末尾追加 init skill）。

- [ ] **Step 2: 追加 init skill 段**

在 README 末尾追加：

```markdown

## Skill: `llm-wiki-plugin-init`（新增 v0.1）

冷启动初始化：**给 vault 一句话触发词，1 份控制台报告** 完成。

触发词：初始化 vault、初始化知识库、新建 vault、cold start

行为：
- 创建 8 个 wiki 目录（`01_知识库/` `02_读书笔记/` `11_entities/` `12_concepts/` `Inbox/` `00_模板/` `10_schema/` `附件文件夹/`）
- 创建 2 个顶层 md 占位（`Index.md` `Log.md`）+ `Inbox/.gitkeep`
- 拷贝 3 个 plugin 资产到 vault 同名位置（已存在则跳过,**不覆盖**）
- 把 `00_模板/CLAUDE_Template.md` 内容追加到 vault/CLAUDE.md 末尾（`<!-- llm-wiki-plugin-init:begin/end -->` 包裹,幂等）

幂等可重复跑,vault 已部分初始化时只输出"已存在"。

详见 spec：[`docs/superpowers/specs/2026-08-23-llm-wiki-plugin-init-design.md`](docs/superpowers/specs/2026-08-23-llm-wiki-plugin-init-design.md)
```

- [ ] **Step 3: 跑 init-vault 单测确保无回归**

```bash
cd "f:/llm-wiki-plugin" && node --test scripts/init-vault.test.mjs
```

期望：12 passed。

- [ ] **Step 4: 提交并 push**

```bash
cd "f:/llm-wiki-plugin" && git add README.md && git -c user.name=zhigangliu-bot -c user.email=zhigangliu-bot@users.noreply.github.com commit -m "docs: README add llm-wiki-plugin-init skill (4 assets + 8 dirs + CLAUDE.md injection)"
git push origin main
```

期望：GitHub `zhigangliu-bot/llm-wiki-plugin` main 分支 HEAD 更新。

---

## Self-Review

**Spec coverage check:**

| Spec 需求 | Plan 任务 |
|---|---|
| 创建 14 目录 + 5 顶层 md | Task 1 (DIRECTORIES + TOP_LEVEL_MD) — **修订**: spec 数错,实际是 8 目录 + 2 顶层 md + 1 占位,plan 已对齐 |
| 拷贝 3 资产 (读书笔记模板/标签词表/config) | Task 2 (runInit 步骤 3 assetMap) |
| 跳过已存在文件 | Task 1 (copyIfMissing via fs.access) + Task 2 (placeholders via fs.access) |
| CLAUDE.md 末尾追加 begin/end 包裹区 | Task 1 (injectClaudeMd) + Task 2 (runInit 步骤 5) |
| 幂等（begin marker 检测） | Task 1 (injectClaudeMd 'already-injected' 分支) + Task 2 测试 |
| vault 不存在 → exit 2 | Task 2 (ensureVaultRoot 'vault-not-found') |
| vault 是文件 → exit 2 | Task 2 (ensureVaultRoot 'vault-is-file') |
| 资产读失败 → exit 3 | Task 2 (runInit errors.kind 'asset-missing' → exitCode 3) |
| 拷贝失败 → exit 4 | Task 2 (runInit errors.kind 'copy-failed' → exitCode 4) |
| 8 单元测试 | Task 1 (4 例) + Task 2 (4 例集成 + 4 例 inject = 12 例) — **超出 spec** |
| 2 集成测试 | Task 2 (runInit × 4, 含 2 正常 + 2 错误) |
| 4 CLAUDE.md 注入测试 | Task 2 (injectClaudeMd × 4) |
| SKILL.md 流程 | Task 3 (4 步骤) |
| README 触发词 | Task 4 |

**Placeholder scan:** 通过 — 无 "TBD" / "fill in later" / "类似 Task N"。

**Type consistency:** `ensureDir` / `copyIfMissing` / `injectClaudeMd` / `runInit` / `CLAUDE_BEGIN_MARKER` / `CLAUDE_END_MARKER` 6 个 export 在 Task 1 定义、Task 2 测试中 import 使用，签名一致。`counters` 字段在 Task 2 定义（6 个 key），Task 2 测试中读取 — 一致。

**One concern:** Task 1 Step 4 的 `ensureDir` 修订（用 `fs.access` 检测 vs `birthtime === mtime`）— 已显式说明 Windows NTFS 行为差异，避免跨平台 false negative。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-23-llm-wiki-plugin-init.md`. Two execution options:

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints