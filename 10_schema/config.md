# My Wiki Schema Configuration

本文件是本仓库 wiki 的单一信息源（Single Source of Truth）。所有 skill、脚本、sub agent 必须从此文件读取规范，不得各自维护副本。

---

## 1. Wiki Structure

```
01_知识库/          原始资料（PDF / 研报，按主题分子目录）—— source 物理载体
02_读书笔记/        从 01_知识库 中的 PDF 自动生成的阅读笔记—— source 逻辑表示
03_问答区/          查询产物（llm-wiki-query skill 归档的问答笔记）—— 只读型
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

三层结构互不替代：

- `02_读书笔记/`（source）= 原始资料驱动的阅读笔记
- `11_entities/` = 被多篇 source 引用的单点实体页
- `12_concepts/` = 跨多 source 抽象聚合的单点概念页

两层通过 `sources:` 数组反向链接互联。

---

## 2. Source Page Template（`02_读书笔记/*.md`）

### Frontmatter 强制字段

| 字段          | 类型      | 说明                                                                                         |
| ------------- | --------- | -------------------------------------------------------------------------------------------- |
| `文章:`     | string    | 文章标题                                                                                     |
| `作者:`     | string    | 作者 / 会议 / 演讲人                                                                         |
| `创建时间:` | ISO date  | 入库日期（系统填）                                                                           |
| `tags:`     | array     | 4 轴（domain / layer / phase / maturity），仅从[词表 §2](../../00_模板/标签词表.md) 枚举取值 |
| `状态:`     | boolean   | `false` = 占位或待审；`true` = 已审入库（merge 语义见 §9-bis）                          |
| `source:`   | wiki-link | `[[01_知识库/...]]` 链回 PDF                                                               |

### 正文固定 4 段（顺序固定，不可增减）

1. `## 摘要` — 200-300 字，全文浓缩
2. `## 重点摘录` — bullet 列表，原文片段 + 来源页码（verbatim 引用，不翻译）
3. `## 我的思考` — 工程价值 / 盲点 / 实操建议（汽车软件架构师视角）
4. `## 总结：最有收获的一句话` — ≤50 字

### 可选末段

- `## Mentions in Source` — 双向链接 + 原文脚注（格式见 §10）

---

## 3. Tag Vocabulary（4 轴枚举权威源）

> **权威源见 [`00_模板/标签词表.md §2`](../../00_模板/标签词表.md)。** 本文件不再维护副本；新增/修改枚举请改词表。
>
> 三套枚举的指向：
>
> - 4 轴（domain / layer / phase / maturity）— 词表 §2
> - entity 子类（7 个）— 词表 §3
> - concept 子类（7 个）— 词表 §4
> - 三层 type × tags 互斥规则 — 词表 §5

### 打标规则

- 4 轴必填，缺一不可
- `domain` ≤ 2（最多 5）
- `layer` ≤ 2
- `phase` 可多值
- `maturity` 必填且单值
- entity / concept `tags:` 单值，限对应子类枚举（词表 §3 / §4）
- 写入工具：obsidian-collacting sub agent 首次入库；knowledge-graph-sync 只读不改
- 漂移检查：lint-wiki 引用词表 §2/§3/§4 枚举值，发现词表外值即报 tag-drift
- 操作流水：obsidian-collacting / knowledge-graph-sync / lint-wiki / llm-wiki-query 任一收尾 → 主对话必须在同次 commit 内 append `Log.md` 一条（格式见 §12）。4 skill 各自独立收尾

---

## 4. Entity Page Template（`11_entities/*.md`）

单点实体页（人 / 组织 / 产品 / 项目 / 事件 / 地点），被多篇 source 引用并积累。

### Frontmatter 强制字段

| 字段          | 类型     | 说明                                                                                                                         |
| ------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `type:`     | enum     | 字面必须`entity`                                                                                                           |
| `tags:`     | array    | 实体子类枚举（仅从[词表 §3](../../00_模板/标签词表.md) 取值）                                                                |
| `sources:`  | array    | 反向链回 source 页的 wiki-link 数组                                                                                          |
| `created:`  | ISO date | 创建日期（系统填）                                                                                                           |
| `updated:`  | ISO date | 最后一次机器 Edit 正文的日期（系统填,新建即与 created 同值）                                                                 |
| `aliases:`  | array    | **必填 ≥ 1 项**——别名 / 译名 / 缩写                                                                                 |
| `reviewed:` | boolean  | 可选，`true` = 已人工 review 正文(机器遇到 `reviewed: true` 时**跳过正文改写**,只 append sources/aliases/Mentions) |

### 实体子类枚举

> 权威源见 [`00_模板/标签词表.md §3`](../../00_模板/标签词表.md)。本表已收编至词表，config 不再维护副本。

### Frontmatter 引号风格约定（v0.5）

所有笔记 frontmatter 必须遵循:

- **标量字段**值必须带双引号：`type` / `reviewed` / `created` / `创建时间` / `protected` / `文章` / `作者` / `source`
- **数组字段**列表项不加引号（已用 `- value` 语法）：`tags` / `aliases` / `sources`
- **wiki-link 字段**保持 `[[...]]` 形态不加引号
- 例外：值内已含嵌套引号或方括号时，保守不加引号

#### `状态:` 是 checkbox 字段（**bare boolean**，不带引号）

`.obsidian/types.json` 把 `状态:` 声明为 `checkbox`。Obsidian 1.4+ Properties 对 checkbox 类型在 YAML frontmatter 里期望 **bare boolean**（不带引号、不带 list 形态）：

```yaml
状态: false   # 未勾选（占位/待审）
状态: true    # 已勾选（已审入库）
```

⚠️ **错误历史**：`状态:\n  - false`（list 形态）会被 Obsidian 识别为 "未匹配类型"，弹"建议使用 复选框"提示。早期迁移脚本误用 list 形态，已由 `scripts/rollback-status-to-scalar.mjs` 回滚。

linter `quote-style` **不**检查 `状态:`（boolean 不需要引号）。

```yaml
type: "entity"
created: "2026-08-23"
source: "[[01_知识库/...]]"
tags:
  - project
```

linter 检查项:`scripts/lint-wiki.mjs` 的 `quote-style` 类别。迁移工具:`scripts/migrate-quote-frontmatter.mjs`。

### 正文固定 5 段（顺序固定）

1. **基本资料** — Type / 子类标签 / 首次出现 source 链接
2. **描述** — 3-6 句具体事实，含 `[[双向链接]]`
3. **相关实体** — `[[11_entities/...]]` 反向链到的其他实体
4. **相关概念** — `[[12_concepts/...]]` 链到的概念
5. **Mentions in Source** — verbatim 引用 + 来源标注（格式见 §10）

---

## 5. Concept Page Template（`12_concepts/*.md`）

单点概念页（理论 / 方法 / 标准 / 术语），跨多 source 抽象聚合。

### Frontmatter 强制字段

| 字段          | 类型     | 说明                                                                                                                         |
| ------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `type:`     | enum     | 字面必须`concept`                                                                                                          |
| `tags:`     | array    | 概念子类枚举（仅从[词表 §4](../../00_模板/标签词表.md) 取值）                                                                |
| `sources:`  | array    | 反向链回 source 页的 wiki-link 数组                                                                                          |
| `created:`  | ISO date | 系统填                                                                                                                       |
| `updated:`  | ISO date | 最后一次机器 Edit 正文的日期（系统填,新建即与 created 同值）                                                                 |
| `aliases:`  | array    | **必填 ≥ 1 项**——别名 / 译名                                                                                        |
| `reviewed:` | boolean  | 可选，`true` = 已人工 review 正文(机器遇到 `reviewed: true` 时**跳过正文改写**,只 append sources/aliases/Mentions) |

### 概念子类枚举

> 权威源见 [`00_模板/标签词表.md §4`](../../00_模板/标签词表.md)。本表已收编至词表，config 不再维护副本。

### 正文固定 6 段（顺序固定）

1. **定义** — 一句话精准定义（≤100 字）
2. **关键特征** — bullet 列表（3-5 条）
3. **应用场景** — 真实落地例子
4. **相关概念** — `[[12_concepts/...]]` 链到的其他概念
5. **相关实体** — `[[11_entities/...]]` 链到的实体
6. **Mentions in Source** — verbatim 引用 + 来源标注

---

## 6. 三层 type 与 tags 互斥规则

> 权威源见 [`00_模板/标签词表.md §5`](../../00_模板/标签词表.md)。本节已收编至词表，config 不再维护副本。
>
> 简述：判断优先级 —— 先看 `type:` → 再选对应枚举（source → 词表 §2；entity → 词表 §3；concept → 词表 §4）。混淆即 tag-drift，lint-wiki 报错。

### 命名约定

- 文件名 slug：`lowercase-with-hyphens`（如 `11_entities/automotive-ecosystem-summit-2026.md`）
- 中文实体 / 概念保留原文不翻译
- 跨语言别名走 `aliases:` 字段，不改文件名
- Wiki 链接一律用全路径 `[[11_entities/page-name|Display Name]]` 或 `[[12_concepts/...|...]]`

---

## 7. Related Pages 段（source 笔记末尾）

每篇 `02_读书笔记/*.md` 在末尾追加一段 `## Related Pages`，列出该 source 引用的实体和概念。**由 obsidian-collacting sub agent 在抽取 entity/concept 后自动追加**。

```markdown
## Related Pages

### Entities
- [[11_entities/<entity-slug-1|Display]]
- [[11_entities/<entity-slug-2|Display]]

### Concepts
- [[12_concepts/<concept-slug-1|Display]]
```

规则：

- 该段是 source 笔记末尾的**可选末段**，由 obsidian-collacting sub agent 在抽取 entity/concept 后追加
- 已有 `## Related Pages` 段表示已处理过，重复 ingest 时跳过追加
- 段内 Entities / Concepts 子标题**可选**——只有实体没概念时省略 Concepts 子标题，反之亦然
- 单个 entity/concept 的 `Display` 用人话可读名（如 `[[11_entities/vector|Vector]]` 而非纯 slug）

---

## 8. Date Fields

| 字段         | 填法                                            | 谁能改 |
| ------------ | ----------------------------------------------- | ------ |
| `创建时间` | 入库时由`sync-pdf-notes.mjs` 填（YYYY-MM-DD） | 系统   |
| `created`  | entity / concept 页创建时由系统填               | 系统   |

笔记内容任何位置不出现日期推断。

---

## 9. reviewed / 状态 字段语义

### 字段对照

| 字段                       | 层级             | 含义                                                                                  | 谁填            |
| -------------------------- | ---------------- | ------------------------------------------------------------------------------------- | --------------- |
| `reviewed: true`         | entity / concept | **正文已人工审核**——机器遇到时跳过正文改写,只 append sources/aliases/Mentions | 用户人工翻 true |
| `状态: false` / `true` | source           | source 是否已审入库（合并语义见 §9-bis）                                             | 用户人工翻 true |

### 机器行为规则（entity / concept）

| 触发条件                                                      | 机器行为                                                                                                         |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| ingest 命中已有 slug +`reviewed: true`                      | 仅 append`sources:` / `aliases:` / `## Mentions in Source`,**不**改写 5 段/6 段正文                  |
| ingest 命中已有 slug +`reviewed` 缺失或 `reviewed: false` | append`sources:` / `aliases:` / `## Mentions in Source`,**直接 Edit** 5 段/6 段正文(LLM 重写 + 补充) |
| ingest 命中但 source 已在`sources:` 列表中                  | early return,跳过本次 append,记日志                                                                              |
| 改后正文长度 < 改前 50%                                       | abort 并报"正文缩水过大",不写盘                                                                                  |

### 增长告警

单 entity/concept 页 `sources:` 数组长度 ≥ 50 时,`lint-wiki` `sources-too-many` warning,提示人工 review / 合并 source 列表。

---

## 9-bis. `状态` 语义

### `状态: false`（占位 / 待审）

- obsidian-collacting sub agent 重跑 ingest → 整体覆盖
- kg-sync 补充 `## Mentions in Source` 段
- 用户尚未审阅入库

### `状态: true`（已审入库）

obsidian-collacting sub agent 重跑 ingest → 只 append，不覆盖：

| 字段            | 重跑 ingest 时的行为                                                    |
| --------------- | ----------------------------------------------------------------------- |
| `tags` 数组   | append 新值（去重）                                                     |
| `重点摘录` 段 | append 新 bullet，不删旧 bullet                                         |
| `我的思考` 段 | append 新段，不删旧段；如与旧段冲突加`## Contradictions` 子段保留双侧 |
| 其他字段        | 不动                                                                    |

翻 false → true 的触发条件：用户人工 review 确认内容无误。

### 合并冲突处理（multi-source merge）

同一 PDF 被多人 / 多轮精读时的合并规则：

- 同一 bullet 重复 → 保留首次出现，后续出现只在 `## Contradictions` 段记录差异
- 同一观点冲突 → 保留双侧 + 标注来源
- tags 数组永远 append，永不删除既有值

---

## 10. Content Rules

### 引用规则

- PDF 原文必须 verbatim 引用（不翻译、不意译、不总结）
- 引用格式：`- "<原文片段>" — 文档名 p.X` 或 `- "<原文片段>" — [[源笔记]]`
- 多处引用同一 PDF → 同一 block，newlines 分隔

### Mentions in Source 格式（三层通用）

正文位置在文末。

```markdown
## Mentions in Source
- "<原文片段 verbatim>" — [[02_读书笔记/<source A>|Display]]
- "<原文片段 verbatim>" — [[02_读书笔记/<source B>|Display]]
```

规则：

- 原文不翻译、不意译，保留 PDF / md 原始语言
- 每个 quote 必须带 source wiki-link
- 同一 source 的多条 quote 同一 block，newlines 分隔
- 多语言 quote 用 `—— 中文（English original）` 形式

### 链接规则

- 内部链接一律 Wiki 链接 `[[...]]`
- 附件统一放 `附件文件夹/`（`alwaysUpdateLinks: true`）
- 跨笔记关联放文末 `## Mentions in Source`

### 文件命名

- `02_读书笔记/<分类目录>/<文章名>.md`（与 `01_知识库/` 镜像）
- 中文文件名保留原文
- 不强制 kebab-case（PDF 名通常是英文，中文文件名很常见）

---

## 11. Maintenance Policies（lint-wiki 阈值）

### source 笔记（02_读书笔记/）

| 检查项         | 阈值                                               | 触发动作                              |
| -------------- | -------------------------------------------------- | ------------------------------------- |
| Missing meta   | frontmatter 缺`tags` 或 `source`               | lint-wiki 报 missing-meta             |
| Orphan         | 无入向 wiki 链接且出向 < 3                         | lint-wiki 报 orphan（叶节点阈值放宽） |
| Stale          | `状态: false` 且 `创建时间` > 90 天            | lint-wiki 报 stale（已审入库不报）    |
| Tag drift      | tags 不在[词表](../../00_模板/标签词表.md) §2 枚举 | lint-wiki 报 tag-drift（最高优先级）  |
| Duplicate      | `文章` 字段相同                                  | lint-wiki 报 duplicate（待人工合并）  |
| Contradictions | 笔记末尾出现`## Contradictions` 段               | lint-wiki 报 contradictions           |

### entity 页（11_entities/）

| 检查项                 | 阈值                                           | 触发动作                            |
| ---------------------- | ---------------------------------------------- | ----------------------------------- |
| Entity missing aliases | frontmatter 缺`aliases` 或为空               | lint-wiki 报 entity-missing-aliases |
| Entity tag drift       | tags 不在词表 §3 entity 子类枚举              | lint-wiki 报 entity-tag-drift       |
| Entity name clash      | 同目录 normalize（去空格/连字符/下划线）后同名 | lint-wiki 报 entity-name-clash      |

### concept 页（12_concepts/）

| 检查项                  | 阈值                               | 触发动作                             |
| ----------------------- | ---------------------------------- | ------------------------------------ |
| Concept missing aliases | frontmatter 缺`aliases` 或为空   | lint-wiki 报 concept-missing-aliases |
| Concept tag drift       | tags 不在词表 §4 concept 子类枚举 | lint-wiki 报 concept-tag-drift       |
| Concept name clash      | 同目录 normalize 后同名            | lint-wiki 报 concept-name-clash      |

### 跨目录 / 共享

| 检查项           | 阈值                                        | 触发动作                                           |
| ---------------- | ------------------------------------------- | -------------------------------------------------- |
| Cross-dir dup    | entity 与 concept 跨目录 normalize 同名     | lint-wiki 报 entity-cross-dir-dup                  |
| Sources too many | entity / concept 的`sources.length` ≥ 50 | lint-wiki 报 sources-too-many（warning，建议合并） |

---

## 12. Log.md Append 格式

本节定义仓库根 `Log.md` 的 append 格式。`obsidian-collacting` / `knowledge-graph-sync` / `lint-wiki` / `llm-wiki-query` 任一收尾，主对话必须按本格式 append 一条。

### 12.1 通用格式

| 字段        | 约定                                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| 标题级别    | `## YYYY-MM-DD  简述`（H2，日期与内容**双空格**分隔）                                           |
| 倒序        | 最新在顶部；上一行用`---` 视觉分隔                                                                    |
| 起首        | `**触发**` 单星号，写触发原因 / 用户原话                                                              |
| 后续        | `**改动范围**` / `**行为**` / `**commit**` / `**测试结果**` / `**YAGNI 边界**` 等小节按需组合 |
| 路径引用    | `[[wiki 链接]]` 或反引号相对路径                                                                      |
| commit 列表 | `- \`<hash></hash>\` 描述` 单行短句                                                                   |
| 工具调用    | `node scripts/<name>.mjs --flags` 全文内嵌代码                                                        |

### 12.2 模板

```markdown
## 2026-MM-DD  <skill 名> 触发说明

- **触发**：用户明示「<触发词原文>」
- **改动范围**：
  - <path 或笔记数>
- **行为**：<简述>
- **commit**：`<hash>` <描述>
- **lint 验收**：<如适用>
```

### 12.3 4 skill 各自的最小条目

- **obsidian-collacting**：`触发` / `改动范围`（Inbox 移入 + 02_读书笔记 新增 + 11_entities/12_concepts 新增/append + Index.md 追加）/ `行为`（按主题归档 + sub agent 写笔记 + 反链补全）/ `commit` / `YAGNI 边界`
- **knowledge-graph-sync**：`触发` / `改动范围`（存量 source 笔记 ## Related Pages 段数 + entity/concept 新建/append 数）/ `行为`（Phase 1-4 简述）/ `commit`
- **lint-wiki**：`触发` / `扫描笔记数`（X 篇）/ `问题总数`（N 处 + 5 类问题分项数）/ `报告路径`（`scripts/_lint-report.md`）/ `commit`
- **llm-wiki-query**：`触发` / `答案路径` / `归档触发` / `召回方式` / `commit` — 字段定义见 §12.4

### 12.4 llm-wiki-query 最小条目（仅触发归档时写）

- **触发**：用户明示「<触发词原文>」
- **答案路径**：`[[03_问答区/<主题>/<slug>.md]]`
- **归档触发**：列出 Q1 / Q2 / Q3 / Q4 / Q5 命中项（如 Q1 + Q5）
- **召回方式**：`qmd-mcp` / `Grep 降级`（必填；llm-wiki-query skill 优先 qmd，qmd 未装时降级 Grep+Read）
- **commit**：`<hash>` 新增 / 续答 QA 笔记

### 12.5 不触发本规范的情形

- 单纯修改 4 skill 自身的 `SKILL.md`（走 git commit message 记，不重复写 Log）
- `scripts/*.mjs` / `scripts/_lint-report.md` 等脚本 / 报告文件改动（不属 vault 笔记）
- `Index.md` 更新（由 obsidian-collacting 主 Log 覆盖）
- 人工行为（手翻 `状态:` false→true、纯文档查阅）
- **`llm-wiki-query` 未触发归档**（无 Q 命中、仅口头回答）——不回写 vault 就不写 Log
