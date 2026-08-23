# Query Skill 设计

- 日期：2026-08-23
- 作者：zhigangliu
- 状态：待用户 review

## 背景

`llm-wiki-plugin` 当前 4 个 skill（`obsidian-collacting` / `lint-wiki` / `knowledge-graph-sync` / `llm-wiki-plugin-init`）覆盖了 karpathy LLM Wiki 思路的**摄取 / 体检 / 冷启动**环节，但**缺失 Query 环节**。

karpathy 原版对 Query 的核心洞见：

> 重要洞见：**好答案可以归档回 wiki 成为新页面。** 你问出来的对比、分析、你发现的连接——这些有价值，不该消失在聊天记录里。这样你的探索像被摄取的素材一样在知识库里累积。

plugin 当前对这块的处理：

- `00_模板/CLAUDE_Template.md` 铁律 #3「File Back 软规则」只要求 LLM **提议**写回，但需要用户显式确认
- 没有专门 skill 主动把问答产物归档回 wiki
- 没有「03_问答区/」目录存放 QA 产物

导致：用户的提问 + LLM 整理出的对比 / 综合判断 **只活在聊天记录里**，不会被知识库累积。

## 目标

新增 skill `query`，触发后：

1. 用户问一个问题
2. LLM 按 CLAUDE 铁律 #2 检索 vault（`02_读书笔记/` > `01_知识库/` > 其他目录）
3. LLM 用引用合成答案（主对话输出）
4. LLM **判定答案是否值得归档**（触发条件见下）—— 值得 → **全自动归档**到 `03_问答区/` + append Log.md，**写完告诉用户路径 + 提供删除方式**

非目标（YAGNI）：

- 不做多种输出格式（对比表 / Marp / matplotlib / canvas）——karpathy 自己也说"可选"，当前不要
- 不做 QA 笔记触发的 entity/concept 反向链接——QA 是只读型，污染 sources 计数
- 不做"查询历史索引"——单凭 Log.md 时间线 + 03_问答区/ 目录树够用
- 不做"召回率评分"——LLM 自评易幻觉，等真出问题再加
- 不支持"QA 笔记二次编辑走 obsidian-collacting 阶段 3"——QA 是只读产物，不和 ingest 流程交叉

## 行为契约

### 触发

显式触发——用户说以下任意词：「查 wiki / 问个问题 / 问一下 / query / 查 vault / 知识库里有没有 X / 我问个问题」。**不**做隐式激活（隐式会和 CLAUDE 铁律 #2「先检索仓库」重叠 + 浪费 token）。

### 查询阶段（无 vault 写操作）

1. 主对话收到问题
2. **必须**走 CLAUDE 铁律 #2 检索优先级：`02_读书笔记/` > `01_知识库/` > `04_会议记录/` > `03_日记/`
3. 读相关笔记的 `## 重点摘录` / `## 我的思考` 段 + entity/concept 的 5-6 段正文
4. 用引用合成答案——每条事实必须带 `[[wiki链接]]`
5. 主对话输出答案给用户

### 归档阶段判定（vault 写操作）

LLM 自检：本次答案**至少满足以下之一**即触发归档：

| # | 触发条件 | 例 |
|---|---|---|
| Q1 | 答案含 **≥ 3 个可复用事实点** | "ISO 21434 包含 X / Y / Z 三块" |
| Q2 | 答案**跨 ≥ 2 篇既有笔记综合** | "对比 A 文章和 B 文章的 SDV 架构差异" |
| Q3 | 答案含**架构图 / 决策树 / 对比表** | "SDV 三种部署模式的选型决策树" |
| Q4 | **用户追问 ≥ 2 轮**——同一主题深入 | "再展开讲讲 SOA" |
| Q5 | 答案揭示**用户笔记库已有内容之间的新连接** | "A 文章提到的 X 其实和 B 文章的 Y 是同一概念" |

满足 0 个 → **不归档**，只输出答案。
满足 ≥ 1 个 → 走归档。

### 归档阶段（vault 写操作）

1. **路径生成**：`03_问答区/<主题目录>/<短句-slug>.md`
   - 主题目录：用 4 轴 tag 中**第一 axis 第一值**作目录名（如 `ai` / `ee-arch`）；跨主题综合问答 → `03_问答区/_cross/`
   - slug：从问题提炼 ≤ 50 字符英文小写连字符
2. **路径冲突**：若 `03_问答区/<主题目录>/<slug>.md` 已存在 → **追加 `## 续答 YYYY-MM-DD HH:MM` 段**而非新建
3. **写笔记内容**（见下方「QA 笔记模板」）
4. **append Log.md**（按 config.md §13.1 通用格式 + §13.5 query 最小条目，详见下）
5. **告知用户**："本次问答已归档到 `[[03_问答区/...]]`，如需删除请说『删 03_问答区/...』"

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

- `类型:` 字面 `"qa"`（与 source/entity/concept 三层并列，作为第四种「只读型」笔记）
- `问题:` 用户原话
- `回答日期:` YYYY-MM-DD
- `tags:` 4 轴（domain/layer/phase/maturity），规则同 source 笔记（限 §2 枚举）
- `状态:` checkbox 字段，与 source 笔记同义——`false` = 待审 / `true` = 已审

**正文 4 段**：

1. **问题** — 用户原话 + 必要的上下文澄清
2. **回答** — LLM 合成答案，含 `### 引用来源` 子段（必填，每条事实必带 wiki-link）
3. **相关实体** — 答案涉及的 entity 链
4. **相关概念** — 答案涉及的 concept 链

### 反向链接规则

QA 笔记**不** append 到 entity/concept 的 `sources:` 数组。

理由：
- QA 是只读型，不是原始资料
- entity/concept 严格保持「source 驱动」语义
- 避免 lint-wiki `sources-too-many` 频繁报警
- QA 笔记自身的 `## 相关实体` / `## 相关概念` 段已经形成反向引用（从 QA → entity/concept）

但允许 lint-wiki 加一项新检查（`qa-backlink-missing`）：QA 笔记若有 `## 相关实体` / `## 相关概念` 段，wiki-link 必须指向**已存在的** entity/concept 文件。**本期不加，留待 v0.7**。

### Log.md 最小条目（§13.5 新增）

```markdown
## YYYY-MM-DD  query  主题摘要

- **触发**：用户明示「<原话>」
- **答案路径**：`[[03_问答区/<主题>/<slug>.md]]`
- **归档触发**：Q1 / Q2 / Q3 / Q4 / Q5 命中（命中哪几条列哪几条）
- **commit**：`<hash>` 新增 QA 笔记
- **lint 验收**：未跑
```

追加位置：`10_schema/config.md §13.3` 末尾，加 §13.5 query 最小条目说明。

## 架构

```
┌──────────────────────────────────────────────────────────────────┐
│ skills/query/SKILL.md                   # LLM 走流程指引          │
│   阶段 A: 触发判定（显式触发词匹配）                                  │
│   阶段 B: 查询阶段                                                  │
│     B1: 走 CLAUDE 铁律 #2 检索优先级                                │
│     B2: 读笔记重点摘录 / 我的思考 / entity 5-6 段                 │
│     B3: 用引用合成答案，主对话输出                                  │
│   阶段 C: 归档判定                                                  │
│     C1: LLM 自检 Q1-Q5 触发条件                                    │
│     C2: 0 命中 → 跳过归档                                          │
│     C3: ≥1 命中 → 走归档阶段                                      │
│   阶段 D: 归档阶段                                                  │
│     D1: 生成路径 03_问答区/<主题>/<slug>.md                       │
│     D2: 路径冲突 → 追加 ## 续答 段                                 │
│     D3: 写双 frontmatter + 4 段正文                                │
│     D4: append Log.md（§13.5 新格式）                             │
│     D5: 告诉用户路径 + 删除指令                                    │
├──────────────────────────────────────────────────────────────────┤
│ 复用资产（plugin 自带）                                              │
│   - 00_模板/标签词表.md §2（4 轴枚举，tags: 必读）                 │
│   - 10_schema/config.md §10 / §13.5（引用规则 + Log 格式）          │
└──────────────────────────────────────────────────────────────────┘
```

**无新增脚本**——LLM 直接 Read / Write / Edit 完成 IO，不引入 `scripts/query*.mjs`。理由：

- 查询是 IO 不密集型操作（读笔记 + 写 1 个文件），shell 脚本拆出来反而多一层维护
- 触发判定 + 归档判定都是 LLM 语义判断，脚本替代不了
- 与 plugin 现有"LLM 主导 + 脚本仅做机械动作"的分工一致

## 与现有 skill 的关系

| Skill | 关系 |
|---|---|
| `obsidian-collacting` | **互斥**：query 触发时不调 obsidian-collacting，反之亦然。两者都对 vault 有写，但 query 写 `03_问答区/`，obsidian-collacting 写 `02_读书笔记/` + `11_entities/` + `12_concepts/`，**目录不重叠**。 |
| `lint-wiki` | **互斥**：query 不调 lint-wiki。但 lint-wiki 未来可能加 `qa-backlink-missing` 检查（本期不加）。 |
| `knowledge-graph-sync` | **互斥**：query 不调 kg-sync。kg-sync 只处理 `02_读书笔记/` 存量笔记的 Related Pages，不碰 QA 笔记。 |
| `llm-wiki-plugin-init` | **依赖**：init 时除了现有 14 个目录，需新增 `03_问答区/` 目录（详见下「改动范围」）。 |

## 改动范围

### 资产层（plugin 仓）

| 文件 | 改动 |
|---|---|
| `skills/query/SKILL.md` | **新增**——本设计文档的实施对象 |
| `README.md` | 在「三个 skill 定位」表新增第 4 行 query |
| `CLAUDE.md`「关键命令 / 测试」段 | 新增 query 的触发词 + 归档路径说明 |
| `CLAUDE.md`「关键文件索引」表 | 新增 `skills/query/SKILL.md` 行 |
| `10_schema/config.md §1` Wiki Structure | 新增 `03_问答区/` 目录描述 |
| `10_schema/config.md §13.3` 末尾 | 新增 §13.5 query 最小条目 |
| `skills/llm-wiki-plugin-init/SKILL.md` 步骤 2 | 新增"创建 `03_问答区/` 目录" |
| `scripts/init-vault.mjs` | 新增 `03_问答区/` 到 `dirsToCreate` 列表 |
| `scripts/init-vault.test.mjs` | 新增对应测试 case |

### 用户 vault 层

| 资产 | 改动 |
|---|---|
| `03_问答区/` | **新增**——init 时建空目录（`03_问答区/_cross/.gitkeep` 占位） |
| `Log.md` | 每次 query 归档后 append 一条（§13.5） |
| `Index.md` | query **不**自动更新 Index——QA 是查询产物而非摄取产物，由人工决定要不要列入索引。**YAGNI**：未来需要时再加自动化。 |

### 不改的

- `00_模板/标签词表.md` ——QA 笔记复用 §2 4 轴枚举，不新增枚举
- `00_模板/读书笔记模板.md` ——QA 笔记结构差异大，单独写 SKILL.md 描述，不新增模板文件
- `scripts/sync-pdf-notes.mjs` ——和 query 无交集
- `hooks/hooks.json` ——query 无需 hook

## 测试设计

| # | 测试 | 类型 |
|---|---|---|
| T1 | 触发词命中：5 个触发词每个匹配一次 | LLM 自测（无需脚本） |
| T2 | 查询阶段：vault 有相关内容 → 答案含 wiki-link | LLM 自测 |
| T3 | 归档判定：Q1-Q5 全部 0 命中 → 不写 03_问答区/ | LLM 自测 |
| T4 | 归档判定：Q1 命中 → 写 03_问答区/ + append Log.md | LLM 自测 |
| T5 | 路径冲突：同一 slug 第二次问 → 追加 `## 续答` 段而非新建 | LLM 自测 |
| T6 | frontmatter 字段齐全 + tags 仅从 §2 枚举 | LLM 自测 |
| T7 | 反向链接不污染 entity/concept sources: | LLM 自测 |
| T8 | init-vault 创建 03_问答区/ + .gitkeep | 单元测试（`init-vault.test.mjs` 新增 case） |

T1-T7 是 **LLM 自测**，无需 .test.mjs——通过观察 SKILL.md 是否被严格执行来验收。理由：

- 查询 / 判定 / 归档都是 LLM 语义判断，写单元测试等于测 LLM 行为，无意义
- 和 obsidian-collacting / kg-sync / lint-wiki 一致——这 3 个 skill 的 SKILL.md 也没有 .test.mjs

T8 是 init-vault 的真实 IO，必须有脚本测试。

## 风险与边界

| 风险 | 缓解 |
|---|---|
| QA 笔记数量爆炸 → 03_问答区/ 体积过大 | 不预设上限；将来 lint-wiki 可加 `qa-no-traffic` 检查（X 月内未被任何 query 引用的 QA 笔记提示归档 / 删除）。**本期不加**。 |
| 路径 slug 冲突频繁 → `## 续答 段堆积 | 单 slug 追加 ≥ 5 段时提示用户换主题重组。**本期不加**，只在 SKILL.md 写明「续答 ≥ 5 段考虑重建」。 |
| 归档判定 Q5「揭示新连接」易触发误归档 | LLM 自评易幻觉——加 LLM 自检「这条连接 vault 里之前**没有任何**笔记提及」。**本期写进 SKILL.md 阶段 C1**，无需额外脚本。 |
| init-vault.mjs 漏改 → 老用户升级后 03_问答区/ 不存在 | init-vault 已有幂等机制，老用户重跑 init 即可补建（不会覆盖任何已有内容）。在 README 加一行 changelog 说明。 |

## 实施步骤（高层）

1. 写 `skills/query/SKILL.md` ——按本文档「架构」段落地
2. 改 `10_schema/config.md §1` + `§13.5`
3. 改 `skills/llm-wiki-plugin-init/SKILL.md` 步骤 2 + `scripts/init-vault.mjs` + 对应测试
4. 改 `README.md` + `CLAUDE.md`（加 query 触发词说明）
5. 本地测试：跑 `node --test scripts/init-vault.test.mjs` 验证 T8
6. 手动 LLM 自测 T1-T7：在 vault 里跑 query 触发词 / 故意答 0 命中 / 故意答 Q1 命中
7. commit + push

## 状态

待用户 review。