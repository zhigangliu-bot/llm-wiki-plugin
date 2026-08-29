# Log.md操作流水规范

> 本文件是仓库根 `Log.md` 的唯一规范来源。`obsidian-collacting` / `knowledge-graph-sync` / `lint-wiki` / `llm-wiki-query` 任一收尾，主对话必须按本规范 append 一条。
>
> 关联：本规范是从 `10_schema/config.md §12` 迁出的单一权威源。config.md 中关于 Log 的章节已删除。

---

## 1. 硬约束

- **`Log.md` 不使用 `[[wiki 链接]]`**，**不被**任何 `[[wiki 链接]]` 反向引用。一旦引入，会污染 `## Related Pages` 与 entity/concept `sources:` 计数，破坏知识图谱统计。
- 所有路径一律用反引号相对路径（如 `` `02_读书笔记/<主题>/<name>.md` ``）。

---

## 2. 通用格式

| 维度         | 约定                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------- |
| 标题级别      | `## YYYY-MM-DD  简述`（H2，日期与内容**双空格**分隔）                                                            |
| 倒序         | 最新在顶部；上一条用 `---` 视觉分隔                                                                                |
| 起首        | `**触发**` 单星号，写触发原因 / 用户原话                                                                              |
| 后续小节      | `**改动范围**` / `**行为**` / `**commit**` / `**测试结果**` / `**YAGNI 边界**` / `**lint 验收**` 等按需组合 |
| 路径引用      | **仅**反引号相对路径，禁止 `[[wiki 链接]]`                                                                            |
| commit 列表 | `- `<hash>` 描述` 单行短句                                                                                     |
| 工具调用      | `` `node scripts/<name>.mjs --flags` `` 全文内嵌代码                                                              |

---

## 3. 4 skill 最小条目（必填字段）

### 3.1 obsidian-collacting

- `触发`：用户原话要点 + 二次明示 / 授权
- `改动范围`：
  - Inbox 移入（`<源 path>` → `<目标 path>`）
  - `02_读书笔记/` 新增笔记数 + 路径列表
  - `11_entities/` 新建 / append 数 + slug 列表
  - `12_concepts/` 新建 / append 数 + slug 列表
  - `Index.md` 重建（**v2 起由 `node scripts/sync-index.mjs --all --write` 维护**, LLM 不再手写行）
  - 删除（如有）+ 原因
- `行为`：按主题归档 + sub agent 写笔记（4 段 + frontmatter tags）+ 反链补全（## Related Pages + Mentions in Source）+ `node scripts/sync-index.mjs --all --write` 重建 Index.md
- `commit`
- `YAGNI 边界`：刻意不做的事 + 原因

### 3.2 knowledge-graph-sync

- `触发`
- `改动范围`：存量 source 笔记 ## Related Pages 段数 + 路径列表；entity / concept 新建 / append 数；Index.md 重建（v2 起由 `sync-index.mjs` 维护）
- `行为`：Phase 1-7 简述（扫描 → 抽取 → 新建/append → 反链镜像 → 报告 → Index.md 同步 → Log）
- `commit`

### 3.3 lint-wiki

- `触发`
- `扫描笔记数`（X 篇）
- `问题总数`（N 处 + 5 类问题分项数）
- `报告路径`（`` `scripts/_lint-report.md` ``）
- `commit`
- 说明：`log-backlinks` 检查项服务于 §1 硬约束（Log 不被反向引用）

### 3.4 llm-wiki-query（仅触发归档时写）

- `触发`
- `答案路径`：`` `03_问答区/<主题>/<slug>.md` ``
- `归档触发`：列出 Q1 / Q2 / Q3 / Q4 / Q5 命中项（如 Q1 + Q5）
- `召回方式`：`Grep` / `qmd`（必填；v3 起 llm-wiki-query 由 SessionStart hook 注入 system context 决定走哪条路径, 本字段记录本次实际用的路径）
- `commit`

---

## 4. 不触发本规范的情形（白名单）

下列动作**不**写 Log，也不触发 `Index.md` 更新：

- 单纯修改 4 skill 自身的 `SKILL.md`（走 git commit message 记，不重复写 Log）
- `scripts/*.mjs` / `scripts/_lint-report.md` 等脚本 / 报告文件改动（不属 vault 笔记）
- `Index.md` 自身更新（属于强制步骤 9 / D4 的产物，不另写 Log 条目）
- 人工行为（手翻 `状态:` false→true、纯文档查阅）
- `llm-wiki-query` 未触发归档（无 Q 命中、仅口头回答）——不回写 vault 就不写 Log，也不触发 `Index.md`

下列动作**仍写 Log**但**不触发** `Index.md` 更新：

- 修改既有笔记（路径不变、语义未改）——路径与分类已存在，但仍写 Log 记录变更内容

---

## 5. 骨架示例（obsidian-collacting）

```markdown
## 2026-MM-DD  obsidian-collacting <触发说明>

- **触发**：用户明示「<触发词原文>」+ <二次明示 / 授权>
- **改动范围**：
  - Inbox 移入：`<源 path>` → `<目标 path>`
  - `02_读书笔记/<主题>/` 新增 N 篇：`<path1>` + `<path2>` ...
  - `11_entities/` 新建 N 个 / 追加 M 个：`<slug1>` / `<slug2>` ...
  - `12_concepts/` 新建 N 个 / 追加 M 个：`<slug1>` / `<slug2>` ...
  - `Index.md` 追加 N 条索引
  - 删除：`<path>` + 原因
- **行为**：
  - 按主题归档到 `<主题>/`
  - `` `node scripts/sync-pdf-notes.mjs --overwrite=false --source-field=source` ``
  - sub agent 三批并发写笔记（4 段 + frontmatter tags）
  - sub agent 抽 entity / concept + append ## Related Pages 段
- **YAGNI 边界**：
  - <刻意不做的事>：原因
- **commit**：`<hash>` <描述>
```