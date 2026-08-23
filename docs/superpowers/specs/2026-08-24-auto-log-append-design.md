# 自动写 Log.md 设计文档（统一四个 skill 的 Log 写入）

## 1. 背景与现状

### 1.1 五个 skill 关于 Log.md 的现状

| Skill | 现状写法 | 是否自动 | 模式 |
|-------|---------|---------|------|
| `obsidian-collacting` | "在仓库根的 `Log.md` 末尾追加本次操作记录（**已自写**）" + "在 Log.md 同次 commit append 一条" | ✅自动（但**写末尾**，违反 §13.1 倒序） | skill 文本流自写 |
| `lint-wiki` | "**主对话必须在同次 commit 内 append `Log.md` 一条**" | ❌手动（甩主对话→主对话甩用户） | 甩锅 |
| `knowledge-graph-sync` | "提示主对话：本次 kg-sync 须在同次 commit 内 append `Log.md` 一条" | ❌手动（甩主对话→主对话甩用户） | 甩锅 |
| `llm-wiki-query` | "归档阶段 — ... + append Log.md" | ✅自动 | skill 文本流自写 |
| `llm-wiki-plugin-init` | 仅创建空 `Log.md` 文件 | N/A | init 时一次性 |

### 1.2 用户的痛点

> "我期望的是任何对知识库的修改都自动写 Log，不需要我确认"

但当前 4 个有写 Log 行为的 skill 中，**2 个仍要靠主对话提醒用户**（kg-sync / lint-wiki），**2 个虽然自动但实现各异**（obsidian-collacting 写末尾、query 写哪里未明说）。规范执行责任压在用户身上，且违反 §13.1 倒序约定。

## 2. 目标

- ✅ **四个 skill 收尾时全部自动** append `Log.md`，无需用户确认、无需主对话中转
- ✅ 全部按 `10_schema/config.md §13.1` **倒序**（最新在顶部），不再写末尾
- ✅ 格式严格符合 §13.3 各 skill 最小条目（obsidian-collacting / knowledge-graph-sync / lint-wiki）+ §13.5（llm-wiki-query）
- ✅ 不破坏现有 commit 工作流——脚本只动 `Log.md`，不 git add / commit
- ✅ 无新依赖（沿用 Node stdlib + `child_process`，与现有 `scripts/*.mjs` 范式一致）

**非目标**（YAGNI）：
- ❌ 不做 git commit / push / hash 回填
- ❌ 不做"扫描 vault 自动推断改动范围"——改动范围由 skill 调用方传入（skill 已知）
- ❌ 不替换或重写 Log.md 历史条目——纯 append（修正 obsidian-collacting 的末尾写入方式时，**新条目仍按顶部插入**，旧历史不动）
- ❌ 不动 `llm-wiki-plugin-init`（只创建空文件，无 Log 条目语义）

## 3. 设计方案

### 3.1 新增 `scripts/log-append.mjs`

**职责**：按 §13.1 通用格式在 `Log.md` **顶部**插入一条 H2 条目。

**CLI 接口**（与 `sync-pdf-notes.mjs` 同 `parseArgs` 风格）：

```
node scripts/log-append.mjs \
  --skill=<name> \
  --trigger="<触发原话>" \
  --scope="<改动范围摘要>" \
  --behavior="<行为简述>" \
  [--commit="<hash> <描述>"] \
  [--extra="<额外字段，如 llm-wiki-query 的 召回方式>"]
```

**最小必需**：`--skill` / `--trigger` / `--scope` / `--behavior`。`--commit` / `--extra` 可选。

**位置行为**（与 §13.1 一致）：
- 读 `Log.md`（不存在则创建空文件）
- 找到第一个 H2 `## YYYY-MM-DD` 行，把新条目 + `\n---\n\n` 插到它之前
- 若 Log.md 完全空/不存在，直接写新条目

**输出格式**（按 §13.2 模板）：

```markdown
## YYYY-MM-DD  <skill 名> 触发说明

- **触发**：<trigger>
- **改动范围**：<scope>
- **行为**：<behavior>
- **commit**：<commit，可缺省>
- **<extra key>**：<extra value>  ← llm-wiki-query 传 召回方式
```

**退出码**：0 成功 / 1 参数缺失 / 2 IO 错误。

### 3.2 四个 SKILL.md 改动

#### `skills/obsidian-collacting/SKILL.md`

- L52 "7. 在仓库根的 `Log.md` 末尾追加本次操作记录" → 改为末尾调用 `node scripts/log-append.mjs --skill=obsidian-collacting --trigger=... --scope=... --behavior=... --commit=...`
- L68 "在 Log.md 同次 commit append 一条（词表改了 → 触发硬性约束 §3，必须走 Log）" → 同样改为调脚本
- 注意：调用方在 Phase 7/词表追加步骤**调一次**而不是写末尾——保留 §13.1 倒序

#### `skills/knowledge-graph-sync/SKILL.md`

- L82 "6. 提示主对话：本次 kg-sync 须在同次 commit 内 append `Log.md` 一条" → 改为调脚本（与 obsidian-collacting 同模板）

#### `skills/lint-wiki/SKILL.md`

- L103 "**主对话必须在同次 commit 内 append `Log.md` 一条诊断摘要**" → 改为：在 `scripts/lint-wiki.mjs` 收尾（lint 报告写完后）直接调 `log-append.mjs`
- **实现选择**：`scripts/lint-wiki.mjs` 是脚本进程，可直接 `import { appendLog } from './log-append.mjs'`（同进程内函数调用，比 spawn 快、无 IO 边界问题）
- 暴露 `appendLog(opts)` 函数供 lint-wiki 等脚本内嵌调用；CLI 入口供 SKILL.md 文本流调用（同一文件、双入口）

#### `skills/llm-wiki-query/SKILL.md`

- L21 / L193 D4 / L232 / L249 四处将"append Log.md"具体化为调脚本
- 新增 `--extra="召回方式: qmd-mcp"`（qmd 未装时自动降级 Grep+Read，传 `召回方式: Grep 降级`）

### 3.3 `scripts/lint-wiki.mjs` 改动

在 lint 报告生成后追加：

```js
import { appendLog } from './log-append.mjs';
await appendLog({
  skill: 'lint-wiki',
  trigger: '用户明示「lint」',
  scope: `扫描笔记数: ${stats.total}`,
  behavior: '5 类问题分类扫描...',
  extra: { 问题总数: stats.total, 报告路径: 'scripts/_lint-report.md' },
});
```

### 3.4 `10_schema/config.md` 改动

- §3 第 81 行 "**操作流水**：... 主对话必须在同次 commit 内 append `Log.md` 一条" → 改为 "**skill 收尾必须**调用 `scripts/log-append.mjs` 自动 append"
- §13.1 表格新增行：`| 自动入口 | 四个 skill 收尾必须调用 \`node scripts/log-append.mjs\`（或脚本内 \`import\`） |`
- §13.2 模板后加注释："本模板由 `scripts/log-append.mjs` 自动写入（人工不直接编辑）"
- §13.4 不触发本规范的情形 → 增加："`Log.md` 自身（已计入 skill 写入）"

## 4. 关键决策与理由

| 决策 | 理由 |
|------|------|
| 双入口：CLI + `appendLog()` 函数 | SKILL.md 文本流调 CLI；`scripts/lint-wiki.mjs` 同进程内 import。无新依赖、无 spawn 开销 |
| 不在脚本里 git commit | commit 时机由主对话决定（用户可能还要 review）；commit hash 留作 `--commit` flag 显式传入 |
| 不修 `obsidian-collacting` 历史末尾条目 | YAGNI——只保证**新**条目按倒序；旧历史是事实，不追溯 |
| 不抽 `parseArgs` 库 | 沿用 `sync-pdf-notes.mjs` 既有内联风格；只新增 1 个脚本 |
| 不做 frontmatter | §13 模板无 frontmatter；既有 Log.md 也没 frontmatter |
| 不动 `llm-wiki-plugin-init` | init 只创建空文件，无 Log 条目语义 |

## 5. 测试策略

按 CLAUDE.md "写代码前必须要写测试用例"：

`scripts/log-append.test.mjs`（node:test 内置），5 个 case：
1. Log.md 不存在 → 创建 + 写入新条目
2. Log.md 已有 1 条 → 新条目插到顶部，旧条目下方 + `---` 分隔
3. Log.md 已有 2 条 → 新条目插到顶部，第 1 条与第 2 条之间保留 `---`
4. 缺 `--skill` flag → 退出码 1，stderr 报错
5. `--extra` 多 key → 输出中按原顺序列出

lint-wiki 集成测试：在 `scripts/lint-wiki.test.mjs` 增加 1 个 case，断言 lint 流程结束后 `Log.md` 顶部出现新条目。

## 6. 文件清单（执行本 spec 的 diff 范围）

新增：
- `scripts/log-append.mjs`
- `scripts/log-append.test.mjs`

修改：
- `skills/obsidian-collacting/SKILL.md`（L52 + L68）
- `skills/knowledge-graph-sync/SKILL.md`（L82）
- `skills/lint-wiki/SKILL.md`（L103）
- `skills/llm-wiki-query/SKILL.md`（L21 + L193 + L232 + L249）
- `scripts/lint-wiki.mjs`（收尾追加 `appendLog` 调用）
- `scripts/lint-wiki.test.mjs`（增加集成测试 case）
- `10_schema/config.md`（§3 + §13.1 + §13.2 + §13.4 共 4 处微调）
- `docs/superpowers/plans/2026-08-24-auto-log-append.md`（执行 plan）

不改：
- `skills/llm-wiki-plugin-init/SKILL.md`
- 任何 vault 内笔记 / Log.md 历史条目

## 7. 回滚

删 `scripts/log-append.{mjs,test.mjs}` + 还原六个 SKILL.md / `config.md` / `lint-wiki.mjs` 即可。所有改动限于 `scripts/` + `skills/*/SKILL.md` + `10_schema/config.md`，未触及 vault 数据。