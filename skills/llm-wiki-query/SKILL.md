---
name: llm-wiki-query
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
4. **归档阶段** — 满足 ≥1 条 → 全自动写 `03_问答区/<主题>/<slug>.md`（Log 见 D4 强制步骤）

# 工作流

## 阶段 A：触发判定

用户原话**显式含**以下任一词才激活：

- 「查 wiki」「问个问题」「问一下」「query」「查 vault」「知识库里有没有 X」「我问个问题」

未含触发词 → **不**走 llm-wiki-query 流程，按 CLAUDE 铁律 #2 普通回答即可。

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
- `召回方式:` 记录本次 llm-wiki-query 用了哪条路径——`qmd-mcp` 或 `Grep 降级`

**正文 4 段**：问题 / 回答（含 `### 引用来源` 子段，必填）/ 相关实体 / 相关概念

**frontmatter 引号约定**：参考 `10_schema/config.md §4` Frontmatter 引号风格约定——标量字段带双引号、数组字段不加引号、`状态:` 不带引号

### D4：强制步骤 — 追加 Log（仅触发归档时）

按 `10_schema/config.md §13.1` 通用格式 + `§13.5` llm-wiki-query 最小条目（含 `召回方式` 字段）。**必须、与主任务同次 commit 完成。**

```markdown
## YYYY-MM-DD  query  <主题摘要>

- **触发**：用户明示「<原话>」
- **答案路径**：`[[03_问答区/<主题>/<slug>.md]]`
- **归档触发**：Q1 / Q2 / Q3 / Q4 / Q5 命中（命中哪几条列哪几条）
- **召回方式**：`qmd-mcp` / `Grep 降级`
- **commit**：`<hash>` 新增 QA 笔记
- **lint 验收**：未跑
```

**未触发归档时跳过本步**——不回写 vault 就不写 Log，避免噪声。

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

# 关联资产

- 复用：`10_schema/config.md` §1 / §4 / §10 / §13.5
- 复用：`00_模板/标签词表.md` §2（4 轴枚举）
- MCP server：`qmd`（`.mcp.json` 声明，可选——未装时降级）
- 写：`03_问答区/<主题>/<slug>.md`
