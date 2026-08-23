# Query Skill 设计（基于 qmd MCP server）

- 日期：2026-08-23
- 作者：zhigangliu
- 状态：待用户 review（v2 重写：接入 qmd MCP server）

## 背景

`llm-wiki-plugin` 当前 4 个 skill（`obsidian-collacting` / `lint-wiki` / `knowledge-graph-sync` / `llm-wiki-plugin-init`）覆盖了 karpathy LLM Wiki 思路的**摄取 / 体检 / 冷启动**环节，但**缺失 Query 环节**。

karpathy 原版对 Query 的核心洞见：

> 重要洞见：**好答案可以归档回 wiki 成为新页面。** 你问出来的对比、分析、你发现的连接——这些有价值，不该消失在聊天记录里。

karpathy 同时在「可选：CLI 工具」段落推荐 [qmd](https://github.com/tobi/qmd) 作为 vault 搜索引擎：

> 最直观的是一个 wiki 页面的搜索引擎——小规模下 index 文件够了，但 wiki 长大你想要正经搜索。qmd 是个不错的选择：它是 markdown 文件的本地搜索引擎，带混合 BM25 / 向量搜索和 LLM 重排，全部在设备上跑。**它既有 CLI（所以 LLM 可以 shell 出调它）也有 MCP server（所以 LLM 能把它当原生工具用）**。

v1 spec 设计了纯 LLM Grep+Read 路径。本版（v2）按 karpathy 原版意图，**接入 qmd MCP server** 作为原生 tool——LLM 在查询阶段调 `query` 召回相关笔记 + 调 `get` 取具体段，比纯 Grep 更准。

## 目标

新增 skill `query`，触发后：

1. 用户问一个问题
2. LLM **调 qmd MCP server 的 `query` tool**召回相关笔记（混合 BM25/vec + reranking）
3. LLM 用引用合成答案（主对话输出）
4. LLM **判定答案是否值得归档**（Q1-Q5 触发条件）—— 值得 → **全自动归档**到 `03_问答区/` + append Log.md，**写完告诉用户路径 + 提供删除方式**

非目标（YAGNI）：

- 不做多种输出格式（对比表 / Marp / matplotlib / canvas）——karpathy 自己也说"可选"
- 不做 QA 笔记触发的 entity/concept 反向链接——QA 是只读型，污染 sources 计数
- 不做"查询历史索引"——单凭 Log.md 时间线 + 03_问答区/ 目录树够用
- 不做"召回率评分"——LLM 自评易幻觉，等真出问题再加
- 不做 qmd 自动 install——plugin 仓零运行时依赖，README 提示用户手动装

## qmd MCP server 接入设计

### .mcp.json 声明

plugin 仓根 `.mcp.json` 新增 `qmd` server：

```json
{
  "mcpServers": {
    "qmd": {
      "command": "qmd",
      "args": ["mcp"]
    }
  }
}
```

**声明条件**：用户本地已装 qmd（`npm i -g @tobilu/qmd` 或 `bun i -g @tobilu/qmd`）。未装 → Claude Code 启动时 .mcp.json 加载失败但**不报错**（MCP server 缺失时静默），query skill 阶段 B 走降级路径（LLM Grep+Read）。

**plugin 仓不负责 install** —— README 新增「可选：qmd 接入」段说明手动步骤：

```bash
# 1. 装 qmd（Node ≥22 / Bun ≥1.0）
npm i -g @tobilu/qmd

# 2. 在 vault 根目录添加 collection（每个 vault 一次）
cd <vaultRoot>
qmd collection add . --name my-vault
qmd embed

# 3. 重启 Claude Code 让 .mcp.json 生效
```

### qmd MCP tool 映射

| qmd tool | query skill 用法 |
|---|---|
| `query(lex?, vec?, hyde?)` | 阶段 B1 召回：传用户原问题作 `vec` 子查询 |
| `get(path \| docid)` | 阶段 B2 取具体笔记段 |
| `multi_get(glob)` | 阶段 B2 批量取相邻笔记（按需） |
| `status` | 阶段 B0 健康检查（可选） |

### 降级策略（qmd 未装 / .mcp.json 加载失败）

query skill **不假设 qmd 必装**。SKILL.md 阶段 B 写明：

- **首选路径**：调 qmd MCP `query` tool
- **降级路径**：LLM 用 Grep 工具扫 vault + Read 工具读具体笔记（v1 spec 行为）

判断条件：调用 `query` 工具返回「tool not found」错误 → 主对话自动降级。SKILL.md 阶段 B1 第一步先**试探调一次** `query`，失败才走 Grep。

## 行为契约

### 触发

显式触发——用户说以下任意词：「查 wiki / 问个问题 / 问一下 / query / 查 vault / 知识库里有没有 X / 我问个问题」。**不**做隐式激活（隐式会和 CLAUDE 铁律 #2「先检索仓库」重叠 + 浪费 token）。

### 查询阶段（无 vault 写操作）

1. **可选健康检查**：调 qmd `status` 看 collection 是否就绪（失败 → 降级）
2. **召回**：调 qmd `query` 工具，传用户原问题作 `vec` 子查询，返回 top-K 笔记路径 + 摘要片段
3. **深读**：对召回结果中**置信度高**（rerank score ≥ 阈值）的笔记，调 qmd `get` 读完整 frontmatter + 关键段（`## 重点摘录` / `## 我的思考` / entity 5-6 段）
4. **补充召回**（可选）：若 `query` 返回的相关笔记不够，调 `multi_get` 按 `02_读书笔记/**/*.md` 批量取全库辅助笔记
5. 用引用合成答案——每条事实必须带 `[[wiki 链接]]`
6. 主对话输出答案给用户

### 归档阶段判定（vault 写操作）

LLM 自检：本次答案**至少满足以下之一**即触发归档：

| # | 触发条件 | 例 |
|---|---|---|
| Q1 | 答案含 **≥ 3 个可复用事实点** | "ISO 21434 包含 X / Y / Z 三块" |
| Q2 | 答案**跨 ≥ 2 篇既有笔记综合** | "对比 A 文章和 B 文章的 SDV 架构差异" |
| Q3 | 答案含**架构图 / 决策树 / 对比表** | "SDV 三种部署模式的选型决策树" |
| Q4 | **用户追问 ≥ 2 轮**——同一主题深入 | "再展开讲讲 SOA" |
| Q5 | 答案揭示**vault 已有内容之间的新连接** | "A 文章提到的 X 其实和 B 文章的 Y 是同一概念" |

满足 0 个 → **不归档**，只输出答案。
满足 ≥ 1 个 → 走归档。

### 归档阶段（vault 写操作）

1. **路径生成**：`03_问答区/<主题目录>/<短句-slug>.md`
   - 主题目录：用 4 轴 tag 中**第一 axis 第一值**作目录名（如 `ai` / `ee-arch`）；跨主题综合问答 → `03_问答区/_cross/`
   - slug：从问题提炼 ≤ 50 字符英文小写连字符
2. **路径冲突**：若 `03_问答区/<主题目录>/<slug>.md` 已存在 → **追加 `## 续答 YYYY-MM-DD HH:MM` 段**而非新建
3. **写笔记内容**（见下方「QA 笔记模板」）
4. **append Log.md**（按 config.md §13.1 通用格式 + §13.5 query 最小条目）
5. **告知用户**：「本次问答已归档到 `[[03_问答区/...]]`，如需删除请说『删 03_问答区/...』」

### QA 笔记模板（双 frontmatter + 4 段正文）

```markdown
---
类型: "qa"
问题: "<用户原始提问>"
回答日期: "2026-08-23"
tags:
  - domain/ai
  - layer/platform
状态: false
---

## 问题

<用户原话 + 必要的澄清>

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
- `问题:` 用户原话
- `回答日期:` YYYY-MM-DD
- `tags:` 4 轴（domain / layer / phase / maturity），规则同 source 笔记（限 §2 枚举）
- `状态:` checkbox 字段，与 source 笔记同义——`false` = 待审 / `true` = 已审

**正文 4 段**：

1. **问题** — 用户原话 + 必要的上下文澄清
2. **回答** — LLM 合成答案，含 `### 引用来源` 子段（必填，每条事实必带 wiki-link）
3. **相关实体** — 答案涉及的 entity 链
4. **相关概念** — 答案涉及的 concept 链

### 反向链接规则

QA 笔记**不** append 到 entity / concept 的 `sources:` 数组。

理由：

- QA 是只读型，不是原始资料
- entity / concept 严格保持「source 驱动」语义
- 避免 lint-wiki `sources-too-many` 频繁报警
- QA 笔记自身的 `## 相关实体` / `## 相关概念` 段已经形成反向引用（从 QA → entity / concept）

但允许 lint-wiki 加一项新检查（`qa-backlink-missing`）：QA 笔记若有 `## 相关实体` / `## 相关概念` 段，wiki-link 必须指向**已存在的** entity / concept 文件。**本期不加，留待 v0.7**。

### Log.md 最小条目（§13.5 新增）

```markdown
## YYYY-MM-DD  query  主题摘要

- **触发**：用户明示「<原话>」
- **答案路径**：`[[03_问答区/<主题>/<slug>.md]]`（若触发了 Q1-Q5）；若未触发归档则标 `未归档`
- **归档触发**：Q1 / Q2 / Q3 / Q4 / Q5 命中（命中哪几条列哪几条）
- **召回方式**：qmd-mcp / Grep 降级
- **commit**：`<hash>` 新增 / 续答 QA 笔记
```

追加位置：`10_schema/config.md §13.3` 末尾，加 §13.5 query 最小条目说明（含 `召回方式` 字段——v2 新增）。

## 架构

```
┌──────────────────────────────────────────────────────────────────┐
│ .mcp.json (plugin 仓根)                                           │
│   mcpServers.qmd = { command: "qmd", args: ["mcp"] }              │
│   ← 仅声明；用户本地必须已装 qmd + 在 vault 跑过 qmd embed        │
├──────────────────────────────────────────────────────────────────┤
│ skills/query/SKILL.md                   # LLM 走流程指引          │
│   阶段 A: 触发判定（显式触发词匹配）                                  │
│   阶段 B: 查询阶段                                                  │
│     B0 (可选): qmd status 健康检查                                  │
│     B1: qmd query 召回 / Grep 降级                                │
│     B2: qmd get 深读 / Read 降级                                  │
│     B3: 用引用合成答案，主对话输出                                  │
│   阶段 C: 归档判定（Q1-Q5）                                       │
│   阶段 D: 归档阶段                                                  │
│     D1: 生成路径 03_问答区/<主题>/<slug>.md                       │
│     D2: 路径冲突 → 追加 ## 续答 段                                 │
│     D3: 写双 frontmatter + 4 段正文                                │
│     D4: append Log.md（§13.5 新格式）                             │
│     D5: 告诉用户路径 + 删除指令                                    │
├──────────────────────────────────────────────────────────────────┤
│ qmd MCP server (外部进程，Claude Code 启动时拉起)                   │
│   tools: query / get / multi_get / status                          │
│   索引存储: ~/.config/qmd/ + ~/.cache/qmd/（全局）                │
│           或 <vaultRoot>/.qmd/ (qmd init 项目本地模式)            │
└──────────────────────────────────────────────────────────────────┘
```

**无新增脚本**——LLM 直接调 MCP tool + Read/Write/Edit 完成 IO，不引入 `scripts/query*.mjs`。

## 与现有 skill 的关系

| Skill | 关系 |
|---|---|
| `obsidian-collacting` | **互斥**：query 触发时不调 obsidian-collacting。两者都对 vault 有写，但 query 写 `03_问答区/`，obsidian-collacting 写 `02_读书笔记/` + `11_entities/` + `12_concepts/`，**目录不重叠**。 |
| `lint-wiki` | **互斥**：query 不调 lint-wiki。但 lint-wiki 未来可能加 `qa-backlink-missing` 检查（本期不加）。 |
| `knowledge-graph-sync` | **互斥**：query 不调 kg-sync。kg-sync 只处理 `02_读书笔记/` 存量笔记的 Related Pages，不碰 QA 笔记。 |
| `llm-wiki-plugin-init` | **依赖**：init 时除了现有 14 个目录，需新增 `03_问答区/` 目录（详见下「改动范围」）。 |

## 改动范围

### 资产层（plugin 仓）

| 文件 | 改动 |
|---|---|
| `skills/query/SKILL.md` | **新增**——本设计文档的实施对象（含 qmd 优先 + 降级路径） |
| `.mcp.json` | **新增** `qmd` server 条目 |
| `README.md` | 在「三个 skill 定位」表新增 query 行；新增「可选：qmd 接入」段说明手动装步骤 |
| `CLAUDE.md` | 「关键命令 / 测试」段 + 「关键文件索引」表新增 query |
| `10_schema/config.md §1` | Wiki Structure 新增 `03_问答区/` 目录描述 |
| `10_schema/config.md §13.3` | 末尾新增 §13.5 query 最小条目（含 `召回方式` 字段） |
| `skills/llm-wiki-plugin-init/SKILL.md` | 步骤 2 新增"创建 `03_问答区/` 目录" |
| `scripts/init-vault.mjs` | 新增 `03_问答区/` 到 `dirsToCreate` 列表 + `_cross/.gitkeep` placeholder |
| `scripts/init-vault.test.mjs` | 新增对应测试 case + bump counter |

### 用户 vault 层

| 资产 | 改动 |
|---|---|
| `03_问答区/` | **新增**——init 时建空目录（`03_问答区/_cross/.gitkeep` 占位） |
| `.qmd/index.yml` | **可选**——用户在 vault 跑 `qmd init` 时自动建（plugin 不管） |
| `Log.md` | 每次 query 归档后 append 一条（§13.5，含 `召回方式` 字段） |

### 不改的

- `00_模板/标签词表.md` ——QA 笔记复用 §2 4 轴枚举，不新增枚举
- `00_模板/读书笔记模板.md` ——QA 笔记结构差异大，单独写 SKILL.md 描述，不新增模板文件
- `scripts/sync-pdf-notes.mjs` ——和 query 无交集
- `hooks/hooks.json` ——query 无需 hook
- qmd 索引 / embed 流程 ——用户手动跑 `qmd embed`，plugin 不代理

## 测试设计

| # | 测试 | 类型 |
|---|---|---|
| T1 | 触发词命中：7 个触发词每个匹配一次 | LLM 自测 |
| T2 | 查询阶段：vault 有相关内容 → 答案含 wiki-link | LLM 自测 |
| T3 | 归档判定：Q1-Q5 全部 0 命中 → 不写 03_问答区/ | LLM 自测 |
| T4 | 归档判定：Q1 命中 → 写 03_问答区/ + append Log.md | LLM 自测 |
| T5 | 路径冲突：同一 slug 第二次问 → 追加 `## 续答` 段而非新建 | LLM 自测 |
| T6 | frontmatter 字段齐全 + tags 仅从 §2 枚举 | LLM 自测 |
| T7 | 反向链接不污染 entity/concept sources: | LLM 自测 |
| T8 | **qmd 优先路径**：qmd 已装 + collection 就绪 → 阶段 B 调 `query` tool | LLM 自测 |
| T9 | **降级路径**：qmd 未装 / collection 未就绪 → 阶段 B 自动降级 Grep+Read | LLM 自测 |
| T10 | init-vault 创建 03_问答区/ + _cross/.gitkeep | 单元测试（`init-vault.test.mjs` 新增 case） |

T1-T9 是 **LLM 自测**，无需 .test.mjs。

T10 是 init-vault 的真实 IO，必须有脚本测试。

## 风险与边界

| 风险 | 缓解 |
|---|---|
| qmd 未装 / 索引陈旧 → 召回结果差 | 阶段 B0 `status` 健康检查；SKILL.md 明写「用户应定期 `qmd embed`」；README 提示 |
| QA 笔记数量爆炸 → 03_问答区/ 体积过大 | 不预设上限；将来 lint-wiki 可加 `qa-no-traffic` 检查。**本期不加** |
| 路径 slug 冲突频繁 → `## 续答` 段堆积 | 单 slug 追加 ≥ 5 段时提示用户换主题重组。**本期不加**，只在 SKILL.md 写明 |
| 归档判定 Q5「揭示新连接」易触发误归档 | LLM 自检「这条连接 vault 里之前**没有任何**笔记提及」。**本期写进 SKILL.md 阶段 C1** |
| qmd embed 性能：vault 大时首次 embed 慢 | 用户手动跑，不在 plugin 路径；README 注明首次 embed 耗时 |
| init-vault.mjs 漏改 → 老用户升级后 03_问答区/ 不存在 | init-vault 已有幂等机制，老用户重跑 init 即可补建。在 README 加 changelog |

## 实施步骤（高层）

1. 写 `skills/query/SKILL.md` ——按本文档「架构」段落地（含 qmd 优先 + 降级）
2. 改 `.mcp.json` ——加 qmd 条目
3. 改 `10_schema/config.md §1` + `§13.5`
4. 改 `skills/llm-wiki-plugin-init/SKILL.md` + `scripts/init-vault.mjs` + 对应测试
5. 改 `README.md`（加 qmd 接入说明 + query 行）+ `CLAUDE.md`（加 query）
6. 本地测试：跑 `node --test scripts/init-vault.test.mjs` 验证 T10
7. 手动 LLM 自测 T1-T9：在 vault 里跑 query 触发词 / 故意答 0 命中 / 故意答 Q1 命中 / 测试 qmd 已装 vs 未装 两种路径
8. commit + push

## 状态

待用户 review。