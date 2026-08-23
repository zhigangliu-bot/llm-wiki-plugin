# Query Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 5th skill `query` to llm-wiki-plugin that lets users query their Obsidian vault via qmd MCP server (with Grep fallback) and auto-archive valuable answers to `03_问答区/`, closing the Query loop from karpathy's LLM Wiki pattern.

**Architecture:** Single new `SKILL.md` describes a 4-phase flow (trigger / query / archive-judge / archive-write). Query phase prefers qmd MCP `query`/`get`/`multi_get`/`status` tools and falls back to LLM Grep+Read if qmd is not installed. `.mcp.json` declares the qmd server. The only mechanical code change is adding `03_问答区/` to `init-vault.mjs`'s `DIRECTORIES` constant. Plugin-level docs (config.md, README, CLAUDE.md, init SKILL.md) get corresponding additions.

**Tech Stack:** Node.js 22 (no new deps), Markdown, YAML frontmatter, qmd MCP server (optional, external). Test runner: `node --test`. Plugin auto-update hook unchanged.

---

## File Structure

### New files

| File | Purpose |
|---|---|
| `skills/query/SKILL.md` | Main skill spec — frontmatter + 4-phase flow + qmd优先+降级 + QA template + Log entry template + edge cases |

### Modified files

| File | Change |
|---|---|
| `.mcp.json` | Add `qmd` server entry (`{ command: "qmd", args: ["mcp"] }`) alongside existing playwright / brave-search / fetch / bocha-mcp / github |
| `10_schema/config.md` | §1 Wiki Structure: add `03_问答区/` line. §13.3 末尾: append §13.5 query 最小条目 subsection (含 `召回方式` 字段) |
| `scripts/init-vault.mjs` | `DIRECTORIES` array: add `'03_问答区'`. `PLACEHOLDER_FILES`: add `'03_问答区/_cross/.gitkeep'` |
| `scripts/init-vault.test.mjs` | Add test case asserting `03_问答区/` is created. Update 现有 integration tests: counters may change |
| `skills/llm-wiki-plugin-init/SKILL.md` | 资产清单 + 步骤 2 报告: add `03_问答区/` line. New sentence mentioning QA archive path |
| `README.md` | 「三个 skill 定位」→「五个 skill 定位」table (add query row) + 新增「可选：qmd 接入」段说明手动装步骤 |
| `CLAUDE.md` | 仓库性质: bump "3 个 skill" → "4 个核心 skill + 1 init", "4 个 Node.js 脚本" unchanged. 架构图: add query to the data flow diagram. 关键文件索引: add `skills/query/SKILL.md` row |

### Unchanged

- `00_模板/标签词表.md` — QA 笔记复用 §2 4 轴枚举
- `00_模板/读书笔记模板.md` — QA 笔记结构独立，不复用 source 模板
- `hooks/hooks.json` — query 无需 hook
- `scripts/sync-pdf-notes.mjs` — query 不与 PDF 同步交叉
- `scripts/lint-wiki.mjs` — 本期不新增 QA 检查（YAGNI）
- `scripts/check-update.mjs` — 无 query 相关改动

---

## Task 1: Update `.mcp.json` — declare qmd MCP server

**Files:**
- Modify: `.mcp.json` (add `qmd` entry after `github`)

- [ ] **Step 1: Add qmd server entry**

Read current `.mcp.json` first to see exact structure. The file currently has 5 MCP servers (playwright / brave-search / fetch / bocha-mcp / github) under `mcpServers`.

Find the closing `}` of the `github` server block (it ends with `}` followed by the outer `}` of `mcpServers`). Add a comma after the `github` block's closing `}` and insert a new `qmd` block **before** the outer closing `}`.

Find (the closing of the github block):

```json
    "github": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-github"
      ],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "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"
      }
    }
}
```

Replace with:

```json
    "github": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-github"
      ],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "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"
      }
    },
    "qmd": {
      "command": "qmd",
      "args": [
        "mcp"
      ]
    }
}
```

(The exact github env token value may differ in the actual file — preserve whatever is there. Only the addition of the comma + qmd block matters.)

- [ ] **Step 2: Validate JSON syntax**

Run: `cd "F:/llm-wiki-plugin" && node -e "JSON.parse(require('node:fs').readFileSync('.mcp.json','utf8')); console.log('valid')"`

Expected output: `valid`

If error: re-check step 1 — most likely missing comma or unbalanced brace.

- [ ] **Step 3: Confirm qmd key exists**

Run: `cd "F:/llm-wiki-plugin" && node -e "const j=JSON.parse(require('node:fs').readFileSync('.mcp.json','utf8')); console.log('servers:', Object.keys(j.mcpServers).join(','))"`

Expected output: `servers: playwright,brave-search,fetch,bocha-mcp,github,qmd` (6 entries)

- [ ] **Step 4: Commit**

```bash
cd "F:/llm-wiki-plugin"
git add .mcp.json
git commit -m "feat(mcp): declare qmd MCP server for query skill (optional, requires user install)"
```

Expected output: `[main <hash>] feat(mcp): declare qmd MCP server for query skill (optional, requires user install)` with 1 file changed.

---

## Task 2: Update `10_schema/config.md` — Wiki Structure + §13.5

**Files:**
- Modify: `10_schema/config.md` (lines 9-21 Wiki Structure; lines 405-417 §13.3 末尾)

- [ ] **Step 1: Update Wiki Structure §1 to add `03_问答区/` line**

Edit `10_schema/config.md` §1 Wiki Structure diagram. After the `02_读书笔记/` line and **before** `11_entities/` line, add:

```
03_问答区/          查询产物（query skill 归档的问答笔记）—— 只读型
```

So the block becomes (after edit):

```
01_知识库/          原始资料（PDF / 研报，按主题分子目录）—— source 物理载体
02_读书笔记/        从 01_知识库 中的 PDF 自动生成的阅读笔记—— source 逻辑表示
03_问答区/          查询产物（query skill 归档的问答笔记）—— 只读型
11_entities/        实体页（人 / 组织 / 产品 / 项目 / 事件 / 地点）
12_concepts/        概念页（理论 / 方法 / 标准 / 术语 / 现象 / 领域）
Index.md            资料索引表（路由表，LLM 优先读此区）
Log.md              操作流水
Inbox/              新资料暂存区
  └── web_clipper/   浏览器剪藏暂存（Obsidian Web Clipper 写入，obsidian-collacting 入库）
00_模板/            笔记模板（读书笔记 / 日记 / 会议纪要 / 每周固定任务）
10_schema/          Wiki schema 配置（本文件位置）
附件文件夹/         当前附件目录
```

- [ ] **Step 2: Append §13.5 query 最小条目 at end of §13.3**

Find the existing `### 13.3 3 skill 各自的最小条目` section (around lines 405-409). After the bullet list for 3 skills, add a new sub-heading `### 13.5 query 最小条目` with content:

```markdown
### 13.5 query 最小条目（query 触发时）

- **触发**：用户明示「<触发词原文>」
- **答案路径**：`[[03_问答区/<主题>/<slug>.md]]`（若触发了 Q1-Q5）；若未触发归档则标 `未归档`
- **归档触发**：列出 Q1 / Q2 / Q3 / Q4 / Q5 命中项（如 Q1 + Q5）；未归档时写「未触发（无 Q 命中）」
- **召回方式**：`qmd-mcp` / `Grep 降级`（必填；query skill 优先 qmd，qmd 未装时降级 Grep+Read）
- **commit**：`<hash>` 新增 / 续答 QA 笔记
```

The full appended block after existing §13.3 content (note the addition of `召回方式` field vs v1 spec):

```markdown
### 13.5 query 最小条目（query 触发时）

- **触发**：用户明示「<触发词原文>」
- **答案路径**：`[[03_问答区/<主题>/<slug>.md]]`（若触发了 Q1-Q5）；若未触发归档则标 `未归档`
- **归档触发**：列出 Q1 / Q2 / Q3 / Q4 / Q5 命中项（如 Q1 + Q5）；未归档时写「未触发（无 Q 命中）」
- **召回方式**：`qmd-mcp` / `Grep 降级`（必填；query skill 优先 qmd，qmd 未装时降级 Grep+Read）
- **commit**：`<hash>` 新增 / 续答 QA 笔记
```

- [ ] **Step 3: Commit**

```bash
cd "F:/llm-wiki-plugin"
git add 10_schema/config.md
git commit -m "docs(schema): add 03_问答区/ to Wiki Structure + §13.5 query 最小条目 (含召回方式字段)"
```

Expected output: `[main <hash>] docs(schema): add 03_问答区/ to Wiki Structure + §13.5 query 最小条目 (含召回方式字段)` with 1 file changed.

---

## Task 3: Update `scripts/init-vault.mjs` — add `03_问答区/` to DIRECTORIES + placeholder

**Files:**
- Modify: `scripts/init-vault.mjs:151-167`

- [ ] **Step 1: Add `03_问答区` to DIRECTORIES array**

Edit `scripts/init-vault.mjs` line 151-161. Find:

```js
export const DIRECTORIES = [
  '01_知识库',
  '02_读书笔记',
  '11_entities',
  '12_concepts',
  'Inbox',
  'Inbox/web_clipper',
  '00_模板',
  '10_schema',
  '附件文件夹',
];
```

Replace with:

```js
export const DIRECTORIES = [
  '01_知识库',
  '02_读书笔记',
  '03_问答区',
  '11_entities',
  '12_concepts',
  'Inbox',
  'Inbox/web_clipper',
  '00_模板',
  '10_schema',
  '附件文件夹',
];
```

(DIRECTORIES array now has 10 entries instead of 9.)

- [ ] **Step 2: Add `_cross` placeholder to PLACEHOLDER_FILES**

Edit `scripts/init-vault.mjs` line 164-167. Find:

```js
export const PLACEHOLDER_FILES = [
  'Inbox/.gitkeep',
  'Inbox/web_clipper/.gitkeep',
];
```

Replace with:

```js
export const PLACEHOLDER_FILES = [
  'Inbox/.gitkeep',
  'Inbox/web_clipper/.gitkeep',
  '03_问答区/_cross/.gitkeep',
];
```

(PLACEHOLDER_FILES array now has 3 entries instead of 2.)

- [ ] **Step 3: Verify the script compiles**

Run: `cd "F:/llm-wiki-plugin" && node -e "import('./scripts/init-vault.mjs').then(m => console.log('DIRECTORIES:', m.DIRECTORIES.length, '/', m.PLACEHOLDER_FILES.length))"`

Expected output: `DIRECTORIES: 10 / 3` — confirms the constants exported correctly.

- [ ] **Step 4: Commit**

```bash
cd "F:/llm-wiki-plugin"
git add scripts/init-vault.mjs
git commit -m "feat(init-vault): add 03_问答区/ to DIRECTORIES + _cross placeholder"
```

Expected output: `[main <hash>] feat(init-vault): add 03_问答区/ to DIRECTORIES + _cross placeholder` with 1 file changed.

---

## Task 4: Update `scripts/init-vault.test.mjs` — adjust counters + add 03_问答区/ assertion

**Files:**
- Modify: `scripts/init-vault.test.mjs:144-223` (integration tests)

- [ ] **Step 1: Update `r1` test — bump expected counters**

Edit `scripts/init-vault.test.mjs` lines 145-157. Find:

```js
  test('empty vault: 9 dirs + 4 placeholders + 4 assets + CLAUDE.md created', async () => {
    const vault = await makeVault('r1');
    const report = await runInit({ vaultRoot: vault, pluginRoot: PLUGIN_ROOT });
    assert.equal(report.exitCode, 0);
    assert.equal(report.counters.dirsCreated, 9);
    assert.equal(report.counters.dirsSkipped, 0);
    assert.equal(report.counters.filesCopied, 4);
    assert.equal(report.counters.filesSkipped, 0);
    assert.equal(report.counters.placeholdersCreated, 4);
    assert.equal(report.counters.placeholdersSkipped, 0);
    assert.equal(report.claudeMd.status, 'created');
    assert.equal(report.errors.length, 0);
  });
```

Replace with:

```js
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
    assert.equal(report.errors.length, 0);
  });
```

- [ ] **Step 2: Update `r2` test — bump partial-init counters**

Edit `scripts/init-vault.test.mjs` lines 159-175. Find:

```js
  test('half-init vault: partial create + partial skip, no overwrite', async () => {
    const vault = await makeVault('r2');
    await mkdir(join(vault, '01_知识库'));
    await writeFile(join(vault, 'Index.md'), '# Index', 'utf8');
    await mkdir(join(vault, '00_模板'), { recursive: true });
    await writeFile(join(vault, '00_模板/读书笔记模板.md'), 'USER CONTENT', 'utf8');

    const report = await runInit({ vaultRoot: vault, pluginRoot: PLUGIN_ROOT });
    assert.equal(report.exitCode, 0);
    assert.equal(report.counters.dirsCreated, 7);    // 9 - 2 已存在 (01_知识库 + 00_模板 都被预创建了)
    assert.equal(report.counters.dirsSkipped, 2);
    assert.equal(report.counters.filesCopied, 3);    // 4 - 1 已存在 (读书笔记模板.md 已存在)
    assert.equal(report.counters.filesSkipped, 1);
    assert.equal(report.counters.placeholdersCreated, 3); // 4 - 1 (Index.md 已存在)
    assert.equal(report.claudeMd.status, 'created');
    assert.equal(await readFile(join(vault, '00_模板/读书笔记模板.md'), 'utf8'), 'USER CONTENT');
  });
```

Replace with:

```js
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
  });
```

- [ ] **Step 3: Update `r5` idempotent test — bump expected counts**

Edit `scripts/init-vault.test.mjs` lines 198-222. Find:

```js
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
    assert.equal(r2.counters.dirsCreated, 0);  // 9 个都已存在
    assert.equal(r2.counters.dirsSkipped, 9);
    assert.equal(r2.counters.filesCopied, 0);  // 4 个都已存在
    assert.equal(r2.counters.filesSkipped, 4);
    assert.equal(r2.counters.placeholdersCreated, 0);  // 4 个都已存在
    assert.equal(r2.counters.placeholdersSkipped, 4);
    assert.equal(r2.errors.length, 0);
    assert.equal(r2.exitCode, 0);

    // 关键:CLAUDE.md 字节数必须不变
    const size2 = (await readFile(claudePath, 'utf8')).length;
    assert.equal(size2, size1, 'CLAUDE.md must not grow on second run');
  });
```

Replace with:

```js
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
    assert.equal(r2.counters.dirsCreated, 0);  // 10 个都已存在
    assert.equal(r2.counters.dirsSkipped, 10);
    assert.equal(r2.counters.filesCopied, 0);  // 4 个都已存在
    assert.equal(r2.counters.filesSkipped, 4);
    assert.equal(r2.counters.placeholdersCreated, 0);  // 5 个都已存在
    assert.equal(r2.counters.placeholdersSkipped, 5);
    assert.equal(r2.errors.length, 0);
    assert.equal(r2.exitCode, 0);

    // 关键:CLAUDE.md 字节数必须不变
    const size2 = (await readFile(claudePath, 'utf8')).length;
    assert.equal(size2, size1, 'CLAUDE.md must not grow on second run');
  });
```

- [ ] **Step 4: Add new test asserting `03_问答区/` is created with placeholder**

Edit `scripts/init-vault.test.mjs` after the `idempotent` test (around line 223, end of `describe('runInit (integration)'` block). Add a new test **before** the closing `});` of the `runInit (integration)` describe block. Find:

```js
    // 关键:CLAUDE.md 字节数必须不变
    const size2 = (await readFile(claudePath, 'utf8')).length;
    assert.equal(size2, size1, 'CLAUDE.md must not grow on second run');
  });
});

describe('injectClaudeMd', () => {
```

Replace with:

```js
    // 关键:CLAUDE.md 字节数必须不变
    const size2 = (await readFile(claudePath, 'utf8')).length;
    assert.equal(size2, size1, 'CLAUDE.md must not grow on second run');
  });

  test('03_问答区/ + _cross/.gitkeep created on empty vault', async () => {
    const vault = await makeVault('r6');
    const report = await runInit({ vaultRoot: vault, pluginRoot: PLUGIN_ROOT });
    assert.equal(report.exitCode, 0);
    // 03_问答区/ 目录存在
    const qaDirStat = await (await import('node:fs/promises')).stat(join(vault, '03_问答区'));
    assert.ok(qaDirStat.isDirectory(), '03_问答区/ must be a directory');
    // _cross/.gitkeep 占位存在
    const keepStat = await (await import('node:fs/promises')).stat(join(vault, '03_问答区/_cross/.gitkeep'));
    assert.ok(keepStat.isFile(), '03_问答区/_cross/.gitkeep must be a file');
  });
});

describe('injectClaudeMd', () => {
```

- [ ] **Step 5: Run init-vault tests to verify all pass**

Run: `cd "F:/llm-wiki-plugin" && node --test scripts/init-vault.test.mjs`

Expected: All tests pass. Total test count should be 21 (was 19 before — 1 added, 3 updated with new assertions).

If any fail: re-check step 1-4 edits. The most likely failure is counter mismatches if DIRECTORIES / PLACEHOLDER_FILES constants don't match.

- [ ] **Step 6: Commit**

```bash
cd "F:/llm-wiki-plugin"
git add scripts/init-vault.test.mjs
git commit -m "test(init-vault): bump counters to 10 dirs / 5 placeholders + assert 03_问答区/ created"
```

Expected output: `[main <hash>] test(init-vault): bump counters to 10 dirs / 5 placeholders + assert 03_问答区/ created` with 1 file changed.

---

## Task 5: Write `skills/query/SKILL.md` — the main skill file

**Files:**
- Create: `skills/query/SKILL.md`

- [ ] **Step 1: Create the skill file**

Write a new file at `F:/llm-wiki-plugin/skills/query/SKILL.md` with the following exact content:

```markdown
---
name: query
description: 查 wiki、问一下、query、查 vault、知识库里有没有 X、我问个问题
---

# 触发条件

当用户说：查 wiki / 问个问题 / 问一下 / query / 查 vault / 知识库里有没有 X / 我问个问题

> **显式触发**——不做隐式激活。和 obsidian-collacting / lint-wiki / kg-sync 一致。

# 这个 skill 做什么

按 karpathy LLM Wiki 模式，把用户的提问 + LLM 的答案**主动归档**回 wiki，避免「好答案消失在聊天记录里」。

四阶段流程：

1. **触发判定** — 用户原文含以上触发词
2. **查询阶段** — 优先调 qmd MCP server 召回相关笔记（混合 BM25/vec + reranking）；qmd 未装时自动降级到 Grep+Read
3. **归档判定** — LLM 自检 Q1-Q5 强信号条件
4. **归档阶段** — 满足 ≥1 条 → 全自动写 `03_问答区/<主题>/<slug>.md` + append Log.md

# 工作流

## 阶段 A：触发判定

用户原话**显式含**以下任一词才激活：

- 「查 wiki」「问个问题」「问一下」「query」「查 vault」「知识库里有没有 X」「我问个问题」

未含触发词 → **不**走 query 流程，按 CLAUDE 铁律 #2 普通回答即可。

## 阶段 B：查询阶段（无 vault 写操作）

### B0：可选健康检查（qmd 已装时）

调 qmd MCP `status` tool 看 collection 是否就绪：

- 成功返回 → 进 B1（qmd 路径）
- 返回「tool not found」错误 → **降级**：跳过 B0/B1/B2 的 qmd 步骤，进 B3 用 Grep+Read

### B1：召回（qmd 路径）

调 qmd MCP `query` tool：

```js
// qmd query tool 用法（参考 qmd 文档）
await mcp.qmd.query({
  vec: "<用户原问题>",   // 主召回向量
  limit: 10,             // 取 top-10 笔记
});
```

返回结果含每篇笔记的 `path` + `snippet` + `score`。

### B2：深读（qmd 路径）

对 B1 召回结果中 `score ≥ 0.6`（经验阈值，可调整）的笔记，调 qmd MCP `get` tool 取完整内容：

```js
for (const hit of recallResult.hits.filter(h => h.score >= 0.6)) {
  const doc = await mcp.qmd.get({ path: hit.path });
  // 读 frontmatter + 关键段：## 重点摘录 / ## 我的思考 / entity 5-6 段
}
```

补充召回（召回结果 < 3 篇时）：调 `multi_get({ glob: "02_读书笔记/**/*.md" })` 批量取全库辅助笔记。

### B3：降级路径（qmd 未装时）

LLM 用 Grep 工具扫 vault + Read 工具读具体笔记：

```js
// 1. Grep 候选笔记路径
const candidates = await grep({
  pattern: "<关键词>",
  path: "02_读书笔记/",
  output_mode: "files_with_matches",
});

// 2. Read 每篇命中笔记的 frontmatter + 关键段
for (const file of candidates) {
  await read({ file_path: file });
}
```

### B4：合成答案 + 输出

无论 qmd 路径还是降级路径，输出阶段一致：

1. 用引用合成答案——**每条事实必须带 `[[wiki 链接]]`**
2. **不得**先归档再回答——必须先在主对话输出答案给用户
3. 读 `00_模板/标签词表.md §2`（4 轴枚举）——为阶段 D 准备 tags

## 阶段 C：归档判定

LLM 自检本次答案，**至少满足以下之一**即触发归档：

| # | 触发条件 | 例 |
|---|---|---|
| Q1 | 答案含 **≥ 3 个可复用事实点** | "ISO 21434 包含 X / Y / Z 三块" |
| Q2 | 答案**跨 ≥ 2 篇既有笔记综合** | "对比 A 文章和 B 文章的 SDV 架构差异" |
| Q3 | 答案含**架构图 / 决策树 / 对比表** | "SDV 三种部署模式的选型决策树" |
| Q4 | **用户追问 ≥ 2 轮**——同一主题深入 | "再展开讲讲 SOA" |
| Q5 | 答案揭示**vault 已有内容之间的新连接** | "A 文章提到的 X 其实和 B 文章的 Y 是同一概念" |

满足 0 个 → **不归档**，只输出答案。**不得**为了归档而捏造命中。
满足 ≥ 1 个 → 走阶段 D。

## 阶段 D：归档阶段（vault 写操作）

### D1：生成路径

- 主题目录：用本次答案**第一 axis 第一值**作目录名（如 `ai` / `ee-arch`）
  - 4 轴 tag 全空 → fallback 用 `03_问答区/_cross/`
  - 跨主题综合（涉及 ≥2 个 domain 第一值） → 强制用 `03_问答区/_cross/`
- slug：从用户原问题提炼 ≤ 50 字符英文小写连字符
  - 中文问题：用 pinyin 缩句 + `-` 分隔（例：「SOA 的本质是什么」 → `soa-essence`）
  - 提炼失败 / 字符数 > 50 → 用 `qa-<YYYYMMDD-HHMM>` 占位

完整路径：`03_问答区/<主题>/<slug>.md`

### D2：路径冲突处理

检查 `03_问答区/<主题>/<slug>.md` 是否已存在：

- **不存在** → 按下方「QA 笔记模板」新建
- **存在** → 用 Edit 工具在文件末尾追加：

```markdown
---

## 续答 YYYY-MM-DD HH:MM

**追问**：<用户原话>

<答案正文（不带 frontmatter，沿用原笔记的 tags）>
```

### D3：写 QA 笔记（仅新建路径走）

完整模板：

```markdown
---
类型: "qa"
问题: "<用户原话>"
回答日期: "YYYY-MM-DD"
tags:
  - domain/<axis1-value>
  - layer/<axis2-value>
状态: false
召回方式: "<qmd-mcp / Grep 降级>"
---

## 问题

<用户原话 + 必要的上下文澄清>

## 回答

<LLM 合成答案正文，bullet 列表优先>

### 引用来源

- `[[02_读书笔记/<A>]]` — 第 X 段：...
- `[[02_读书笔记/<B>]]` — 第 Y 段：...
- `[[12_concepts/<C>]]` — ...

## 相关实体

- `[[11_entities/<e1>]]`
- `[[11_entities/<e2>]]`

## 相关概念

- `[[12_concepts/<c1>]]`
```

**frontmatter 字段**：

- `类型:` 字面 `"qa"`（与 source / entity / concept 三层并列，作为第四种「只读型」笔记）
- `问题:` 用户原话（完整保留，不改写）
- `回答日期:` YYYY-MM-DD
- `tags:` 4 轴，规则同 source 笔记（限 §2 枚举）
- `状态:` checkbox 字段，bare boolean（不带引号）——与 source 同义，`false` = 待审
- `召回方式:` 记录本次 query 用了哪条路径——`qmd-mcp` 或 `Grep 降级`

**正文 4 段**：问题 / 回答（含 `### 引用来源` 子段，必填）/ 相关实体 / 相关概念

**frontmatter 引号约定**：参考 `10_schema/config.md §4` Frontmatter 引号风格约定——标量字段带双引号、数组字段不加引号、`状态:` 不带引号

### D4：append Log.md

按 `10_schema/config.md §13.1` 通用格式 + `§13.5` query 最小条目（含 `召回方式` 字段）：

```markdown
## YYYY-MM-DD  query  <主题摘要>

- **触发**：用户明示「<原话>」
- **答案路径**：`[[03_问答区/<主题>/<slug>.md]]`
- **归档触发**：Q1 / Q2 / Q3 / Q4 / Q5 命中（命中哪几条列哪几条）
- **召回方式**：`qmd-mcp` / `Grep 降级`
- **commit**：`<hash>` 新增 QA 笔记
- **lint 验收**：未跑
```

未触发归档时 Log 条目 `**答案路径**` 写 `未归档`，`**归档触发**` 写 `未触发（无 Q 命中）`，`**召回方式**` 仍必填。

### D5：告知用户

输出到主对话：

```text
已归档到 `[[03_问答区/<主题>/<slug>.md]]`。
如需删除：「删 03_问答区/<主题>/<slug>.md」
```

未归档时**不**输出此段（避免噪声）。

# 边界

- ❌ **不**反向链接到 entity / concept 的 `sources:` 数组——QA 是只读型，污染 sources 计数
- ❌ **不**更新 `Index.md`——QA 是查询产物非摄取产物，由人工决定
- ❌ **不**在触发词缺失时强行走归档——零命中就**只输出答案**
- ❌ **不**为归档而捏造 Q 命中——如果答案是简单查事实（"vault 里有没有 X"），就该如实写「仓库无相关笔记」并跳过归档
- ❌ **不**做多种输出格式（对比表 / Marp / matplotlib / canvas）——karpathy 原文标注「可选」，本期 YAGNI
- ❌ **不**自动装 qmd——plugin 仓零运行时依赖；README 说明手动装步骤
- ✅ **必须**优先试 qmd（如果 .mcp.json 已声明），失败才降级
- ✅ **必须**走 CLAUDE 铁律 #2 检索——不得跳过
- ✅ **必须**每条事实带 `[[wiki 链接]]`
- ✅ **必须** append Log.md（满足 §3 硬性约束）

# 互斥规则

| Skill | 互斥语义 |
|---|---|
| `obsidian-collacting` | query 写 `03_问答区/`，obsidian-collacting 写 `02_读书笔记/` + `11_entities/` + `12_concepts/`，目录不重叠。**互不调用**。 |
| `lint-wiki` | query 不调 lint-wiki。本期不新增 QA 检查项（YAGNI）。 |
| `knowledge-graph-sync` | query 不调 kg-sync。kg-sync 只处理 `02_读书笔记/` 存量笔记。 |
| `llm-wiki-plugin-init` | init 时创建 `03_问答区/` 目录；query 不调 init。 |

# 维护

- 触发词 / Q1-Q5 判定阈值 / slug 规则改时 → 改本 SKILL.md
- 改 schema / 词表 / Log 格式时 → 改 `10_schema/config.md` 对应章节
- qmd tool 用法 / 参数改动时 → 改本 SKILL.md 阶段 B0-B2

# 测试场景（LLM 自测，不写 .test.mjs）

| # | 场景 | 预期 |
|---|---|---|
| T1 | 7 个触发词每个匹配一次 | llm-wiki-query 流程启动 |
| T2 | vault 有相关内容 → 答案含 wiki-link | 主对话输出含 `[[02_读书笔记/...]]` |
| T3 | Q1-Q5 全部 0 命中 → 不写 03_问答区/ | 仅输出答案，无归档动作 |
| T4 | Q1 命中 → 写 03_问答区/ + append Log.md | 新文件存在，Log 新增一行 |
| T5 | 同一 slug 第二次问 → 追加 `## 续答` 段 | 原文件末尾有 `## 续答 YYYY-MM-DD HH:MM` 段 |
| T6 | frontmatter 字段齐全 + tags 仅从 §2 枚举 | YAML 解析无误，4 轴值合法 |
| T7 | 反向链接不污染 entity/concept sources: | entity/concept 的 `sources:` 数组未变 |
| T8 | **qmd 优先路径**：qmd 已装 + collection 就绪 → 阶段 B 调 `query` tool | 主对话能看到 qmd tool 被调用 |
| T9 | **降级路径**：qmd 未装 / collection 未就绪 → 阶段 B 自动降级 Grep+Read | 主对话输出与 qmd 路径等价，但 Log 标 `Grep 降级` |

# 关联资产

- 复用：`10_schema/config.md` §1 / §4 / §10 / §13.5
- 复用：`00_模板/标签词表.md` §2（4 轴枚举）
- MCP server：`qmd`（`.mcp.json` 声明，可选——未装时降级）
- 写：`03_问答区/<主题>/<slug>.md`
- 写：`Log.md`（按 §13.5）
```

- [ ] **Step 2: Verify the file is syntactically valid Markdown**

Run: `cd "F:/llm-wiki-plugin" && node -e "const fs=require('node:fs'); const c=fs.readFileSync('skills/query/SKILL.md','utf8'); console.log('lines:', c.split('\\n').length); console.log('starts with frontmatter:', c.startsWith('---'))"`

Expected output:

```
lines: <some number, ~155>
starts with frontmatter: true
```

- [ ] **Step 3: Commit**

```bash
cd "F:/llm-wiki-plugin"
git add skills/query/SKILL.md
git commit -m "feat(skill): add query skill — qmd MCP 召回 + 自动归档回 03_问答区/ (Grep 降级)"
```

Expected output: `[main <hash>] feat(skill): add query skill — qmd MCP 召回 + 自动归档回 03_问答区/ (Grep 降级)` with 1 file changed.

---

## Task 6: Update `skills/llm-wiki-plugin-init/SKILL.md` — mention 03_问答区/

**Files:**
- Modify: `skills/llm-wiki-plugin-init/SKILL.md`

- [ ] **Step 1: Update vault 创建目录清单**

Read `skills/llm-wiki-plugin-init/SKILL.md` first to find the exact enumeration of created directories. Find any sentence like "创建 N 个目录" or "01_知识库/ 02_读书笔记/ ...". Bump N from 8 to 9, and add `03_问答区/` to any explicit enumeration.

If the SKILL.md doesn't have an explicit count, find any sentence that says "创建 2 个顶层 md 占位（Index.md Log.md）+ Inbox/.gitkeep" and update to mention 03_问答区/_cross/.gitkeep. Specifically look for language like:

```
- 创建 2 个顶层 md 占位（Index.md Log.md）+ Inbox/.gitkeep
```

Replace with:

```
- 创建 2 个顶层 md 占位（Index.md Log.md）+ 3 个 .gitkeep 占位（Inbox/、Inbox/web_clipper/、03_问答区/_cross/）
```

- [ ] **Step 2: Update 资产清单 to mention 03_问答区/ is created (not copied)**

Edit the "## 资产清单" section. After the "拷贝到 vault" list, add a new bullet:

```
- 创建到 vault（不拷贝内容）: `03_问答区/` 目录 + `03_问答区/_cross/.gitkeep` 占位
```

- [ ] **Step 3: Verify the SKILL.md mentions 03_问答区**

Run: `cd "F:/llm-wiki-plugin" && grep -c "03_问答区" skills/llm-wiki-plugin-init/SKILL.md`

Expected output: `1` or more (at least one mention).

If 0: re-check step 1-2 edits.

- [ ] **Step 4: Commit**

```bash
cd "F:/llm-wiki-plugin"
git add skills/llm-wiki-plugin-init/SKILL.md
git commit -m "docs(init-skill): mention 03_问答区/ creation in vault init"
```

Expected output: `[main <hash>] docs(init-skill): mention 03_问答区/ creation in vault init` with 1 file changed.

---

## Task 7: Update `README.md` — add query row + 「可选：qmd 接入」section

**Files:**
- Modify: `README.md:36-43` (skill positioning table) + new section after 「每个 skill 依赖的资产」

- [ ] **Step 1: Add query row to the skill positioning table**

Edit `README.md`. Find the table around lines 36-43:

```
## 三个 skill 定位

| Skill | 触发词 | 做什么 |
|---|---|---|
| `knowledge-graph-sync` | knowledge graph / 同步反向引用 / 知识图谱同步 | 手动触发；只补存量 `02_读书笔记/` 的反向引用 `## Related Pages`，不读 PDF、不写正文 |
| `lint-wiki` | lint / healthcheck / 检查 vault / 扫一遍笔记 / 跑 lint | 只读不写；扫 source/entity/concept 14 类健康问题到 `scripts/_lint-report.md` |
| `obsidian-collacting` | 整理 / Inbox / web clipper | `Inbox/` 双源（PDF + web clipper md）→ 归档到 `01_知识库/` → 生成 `02_读书笔记/` 模板 → 写正文 → 抽 entity/concept |
```

Replace the heading "## 三个 skill 定位" with "## 五个 skill 定位". Then add a new row to the table after the `obsidian-collacting` row:

```
| `query` | 查 wiki / 问一下 / query / 查 vault | 显式触发；优先调 qmd MCP server 召回 + 重排，qmd 未装自动降级 Grep+Read → 合成答案 → 全自动归档到 `03_问答区/<主题>/<slug>.md`（触发 Q1-Q5 时）+ append Log.md |
| `llm-wiki-plugin-init` | 初始化 vault / 初始化知识库 / 新建 vault / cold start / init vault | 冷启动一句话触发词：建 10 个目录 + 5 个占位 + 拷 4 个资产 + 注入 CLAUDE.md 模板，幂等可重跑 |
```

So the final table becomes:

```markdown
## 五个 skill 定位

| Skill | 触发词 | 做什么 |
|---|---|---|
| `knowledge-graph-sync` | knowledge graph / 同步反向引用 / 知识图谱同步 | 手动触发；只补存量 `02_读书笔记/` 的反向引用 `## Related Pages`，不读 PDF、不写正文 |
| `lint-wiki` | lint / healthcheck / 检查 vault / 扫一遍笔记 / 跑 lint | 只读不写；扫 source/entity/concept 14 类健康问题到 `scripts/_lint-report.md` |
| `obsidian-collacting` | 整理 / Inbox / web clipper | `Inbox/` 双源（PDF + web clipper md）→ 归档到 `01_知识库/` → 生成 `02_读书笔记/` 模板 → 写正文 → 抽 entity/concept |
| `query` | 查 wiki / 问一下 / query / 查 vault | 显式触发；优先调 qmd MCP server 召回 + 重排，qmd 未装自动降级 Grep+Read → 合成答案 → 全自动归档到 `03_问答区/<主题>/<slug>.md`（触发 Q1-Q5 时）+ append Log.md |
| `llm-wiki-plugin-init` | 初始化 vault / 初始化知识库 / 新建 vault / cold start / init vault | 冷启动一句话触发词：建 10 个目录 + 5 个占位 + 拷 4 个资产 + 注入 CLAUDE.md 模板，幂等可重跑 |
```

- [ ] **Step 2: Add new section 「可选：qmd 接入」 after 「每个 skill 依赖的资产」 section**

Find the section ending with:

```
> ⚠️ 缺 schema/模板时 skill 会失败（lint-wiki 会自动跳过 tag-drift 检查；其它两个会直接报错）。
```

After that block, add a new section:

```markdown
## 可选：qmd 接入（query skill 用）

query skill 默认走 Grep+Read 降级路径。要走 qmd MCP 召回（BM25 + 向量 + 重排），用户手动装：

```bash
# 1. 装 qmd（需 Node ≥22 / Bun ≥1.0）
npm i -g @tobilu/qmd

# 2. 在 vault 根目录添加 collection + 索引（每个 vault 一次）
cd <vaultRoot>
qmd collection add . --name my-vault
qmd embed    # 首次 embed 较慢（几十秒到几分钟，取决于笔记量）

# 3. 重启 Claude Code 让 .mcp.json 生效
```

装好后 query skill 自动用 qmd tool 召回，无需 LLM 手动操作。

未装 qmd → query 自动降级到 Grep+Read；vault 小（<几百页）时差异不大。
```

- [ ] **Step 3: Verify table + new section exist**

Run: `cd "F:/llm-wiki-plugin" && grep -c "^| \`query\`" README.md && grep -c "^## 可选：qmd 接入" README.md`

Expected output: `1` then `1` (two `1`s).

If any 0: re-check step 1-2.

- [ ] **Step 4: Commit**

```bash
cd "F:/llm-wiki-plugin"
git add README.md
git commit -m "docs(readme): add query skill row + 可选 qmd 接入 section"
```

Expected output: `[main <hash>] docs(readme): add query skill row + 可选 qmd 接入 section` with 1 file changed.

---

## Task 8: Update `CLAUDE.md` — bump skill count, add query to flow diagram, add to file index

**Files:**
- Modify: `CLAUDE.md` (仓库性质 line + 架构图 + 关键文件索引 table)

- [ ] **Step 1: Bump skill count in 仓库性质 section**

Edit `CLAUDE.md` line 7. Find:

```
本仓提供 3 个 skill（`knowledge-graph-sync` / `lint-wiki` / `obsidian-collacting`）+ 1 个 init skill（`llm-wiki-plugin-init`）+ 4 个 Node.js 脚本 + 1 个 SessionStart hook。
```

Replace with:

```
本仓提供 4 个核心 skill（`knowledge-graph-sync` / `lint-wiki` / `obsidian-collacting` / `query`）+ 1 个 init skill（`llm-wiki-plugin-init`）+ 4 个 Node.js 脚本 + 1 个 SessionStart hook。query skill 依赖 `.mcp.json` 声明的 qmd MCP server（可选——未装自动降级 Grep+Read）。
```

- [ ] **Step 2: Add query to 架构图 (data flow diagram)**

Edit `CLAUDE.md` around lines 73-100. Find the ASCII art diagram showing the 3-skill collaboration:

```
   ┌────────────────────┐    ┌──────────────────────────┐
   │ lint-wiki          │    │ knowledge-graph-sync      │
   │ • 只读 vault       │    │ • 只补 ## Related Pages   │
   │ • 15 类健康检查     │    │ • 不读 PDF / 不写正文     │
   │ • 写 _lint-report  │    │ • 处理 obsidian-collacting │
   │ • Vocab Suggestions│    │   漏的反向引用             │
   └────────────────────┘    └──────────────────────────┘
```

Replace with (adding query as a third box):

```
   ┌────────────────────┐    ┌──────────────────────────┐    ┌──────────────────────────┐
   │ lint-wiki          │    │ knowledge-graph-sync      │    │ query                     │
   │ • 只读 vault       │    │ • 只补 ## Related Pages   │    │ • 显式触发词              │
   │ • 15 类健康检查     │    │ • 不读 PDF / 不写正文     │    │ • qmd MCP 召回 / Grep 降级│
   │ • 写 _lint-report  │    │ • 处理 obsidian-collacting │    │ • Q1-Q5 判定              │
   │ • Vocab Suggestions│    │   漏的反向引用             │    │ • 自动归档 03_问答区/      │
   └────────────────────┘    └──────────────────────────┘    └──────────────────────────┘
```

Also update the closing sentence "**互斥规则**：`## Related Pages` 段由 obsidian-collacting 自动处理 ingest 笔记，kg-sync 只补存量旧笔记。3 skill 互不调用。" — bump to "4 个核心 skill 互不调用".

- [ ] **Step 3: Add query SKILL.md to 关键文件索引 table**

Edit `CLAUDE.md` 关键文件索引 table (around lines 148-159). Add a new row after the `lint-wiki/SKILL.md` row:

```markdown
| `skills/query/SKILL.md` | 中 | `.mcp.json` + `10_schema/config.md §1/§13.5` + `00_模板/标签词表.md §2` |
```

- [ ] **Step 4: Verify CLAUDE.md updates**

Run: `cd "F:/llm-wiki-plugin" && grep -c "query" CLAUDE.md`

Expected output: 3 or more (mention in 仓库性质, 架构图, 文件索引).

- [ ] **Step 5: Commit**

```bash
cd "F:/llm-wiki-plugin"
git add CLAUDE.md
git commit -m "docs(claude-md): add query skill to 4 skill count + 架构图 + 文件索引"
```

Expected output: `[main <hash>] docs(claude-md): add query skill to 4 skill count + 架构图 + 文件索引` with 1 file changed.

---

## Task 9: Final verification — run all tests + manual smoke test (qmd 已装 vs 未装)

**Files:**
- Read: `skills/query/SKILL.md`, `.mcp.json`, `10_schema/config.md`, `README.md`, `CLAUDE.md`, `scripts/init-vault.mjs`

- [ ] **Step 1: Run full test suite**

Run: `cd "F:/llm-wiki-plugin" && node --test scripts/*.test.mjs`

Expected: All tests pass across all 4 .test.mjs files (check-update, init-vault, lint-wiki, sync-pdf-notes). The newly added init-vault test (Task 4 Step 4) should pass.

If any fail: re-run the relevant task's tests and trace the failure to a specific edit.

- [ ] **Step 2: Smoke test init-vault with a temp vault**

Run:

```bash
cd "F:/llm-wiki-plugin"
TMP=$(mktemp -d)
node scripts/init-vault.mjs "$TMP"
ls "$TMP/03_问答区/"
ls "$TMP/03_问答区/_cross/"
rm -rf "$TMP"
```

Expected output:

- `node scripts/init-vault.mjs "$TMP"` exits 0 and prints JSON with `dirsCreated: 10`
- `ls "$TMP/03_问答区/"` lists `_cross`
- `ls "$TMP/03_问答区/_cross/"` lists `.gitkeep`

If any fails: re-check init-vault.mjs edits (Task 3).

- [ ] **Step 3: Verify .mcp.json is valid + qmd declared**

Run: `cd "F:/llm-wiki-plugin" && node -e "const j=JSON.parse(require('node:fs').readFileSync('.mcp.json','utf8')); console.log('qmd:', JSON.stringify(j.mcpServers.qmd))"`

Expected output: `qmd: {"command":"qmd","args":["mcp"]}`

If error: re-check Task 1.

- [ ] **Step 4: Verify all 8 commits are in git log**

Run: `cd "F:/llm-wiki-plugin" && git log --oneline -8`

Expected output (most recent 8 commits):

```
<hash> docs(claude-md): add query skill to 4 skill count + 架构图 + 文件索引
<hash> docs(readme): add query skill row + 可选 qmd 接入 section
<hash> docs(init-skill): mention 03_问答区/ creation in vault init
<hash> feat(skill): add query skill — qmd MCP 召回 + 自动归档回 03_问答区/ (Grep 降级)
<hash> test(init-vault): bump counters to 10 dirs / 5 placeholders + assert 03_问答区/ created
<hash> feat(init-vault): add 03_问答区/ to DIRECTORIES + _cross placeholder
<hash> docs(schema): add 03_问答区/ to Wiki Structure + §13.5 query 最小条目 (含召回方式字段)
<hash> feat(mcp): declare qmd MCP server for query skill (optional, requires user install)
```

- [ ] **Step 5: Manual LLM smoke test — qmd 未装 (Grep 降级路径)**

Open a new Claude Code session with the updated plugin installed. **Don't** install qmd. Say: "查 wiki: vault 里关于 SDV 的笔记有哪些关键观点？"

Expected behavior:

1. Skill recognizes the trigger word 「查 wiki」
2. Tries qmd `status` / `query` tool → MCP tool not available → 降级到 Grep+Read
3. Reads `02_知识库/` + `02_读书笔记/` + `12_concepts/` via Grep + Read
4. Outputs an answer with `[[wiki links]]`
5. (If answer has ≥3 facts / cross-2-notes / etc.) Creates `03_问答区/<主题>/<slug>.md` with `召回方式: "Grep 降级"` in frontmatter
6. Appends Log.md with `召回方式: Grep 降级`
7. Tells user "已归档到 `[[03_问答区/...]]`"

If qmd MCP tool is called (降级失败): re-read `skills/query/SKILL.md` 阶段 B0 — the `status` tool call should be the first probe.

- [ ] **Step 6: Manual LLM smoke test — qmd 已装 (qmd 优先路径)**

Install qmd: `npm i -g @tobilu/qmd`. In a test vault, run: `qmd collection add . --name test && qmd embed`. Restart Claude Code.

Say: "查 wiki: <some question>"

Expected behavior:

1. Skill recognizes the trigger word
2. Calls qmd `status` → success → calls `query` with the user's question
3. Uses `get` on top-scored hits
4. Outputs an answer with `[[wiki links]]`
5. If archive triggered: frontmatter has `召回方式: "qmd-mcp"`, Log.md has `召回方式: qmd-mcp`

If Grep is used instead of qmd (优先级错): re-read 阶段 B0 / B1 — the `status` call is the gate.

- [ ] **Step 7: Push to remote (only if user requests)**

This task is the final verification step. **Do NOT push** unless the user explicitly asks. Report completion of all 8 prior tasks to the user.