---
name: llm-wiki-query
description: 在知识库查一下
---

# 触发条件

当用户说：在知识库查一下 / 查一下知识库 / 知识库查一下 / 在 wiki 查一下

> **显式触发**——不做隐式激活。和 obsidian-collacting / lint-wiki / kg-sync 一致。

# 这个 skill 做什么

按 karpathy LLM Wiki 模式，**朴素 Grep 召回** → 引用合成答案 → **经用户确认后归档**回 wiki，避免「好答案消失在聊天记录里」。

四阶段流程：

1. **触发判定** — 用户原文含以上触发词
2. **查询阶段** — 朴素 Grep（按 vault 优先级）召回候选笔记 + Read 深读关键段
3. **回答 + 建议归档** — 先输出答案给用户；命中 Q1-Q5 时在答案末尾附「建议归档」提示，**等用户明示「归档」才写**
4. **归档阶段** — 用户确认后写 `03_问答区/<主题>/<slug>.md`（Log 见 D4 强制步骤）

# 工作流

## 阶段 A：触发判定

用户原话**显式含**以下任一词才激活：

- 「在知识库查一下」「查一下知识库」「知识库查一下」「在 wiki 查一下」

未含触发词 → **不**走 llm-wiki-query 流程，按 CLAUDE 铁律 #2 普通回答即可。

## 阶段 B：查询阶段（无 vault 写操作）

**路径选择：v3 由 SessionStart hook 注入 system context 决定.** 朴素 Grep 与 qmd MCP 共存, LLM 按 system context 里的 `effective_path` 调对应工具. 详见末尾 §"v3 路径选择".

### B0：读 system context 路径决策

**B0.0 读 system context:** SessionStart 时 `hooks/hooks.json` matcher 调用 `scripts/qmd-detect.mjs`, 已注入 LLM context 一段形如:

```
<system-context>
llm-wiki-query path selection:
  tier: <small|medium|large> (vault_size: <N> .md files)
  effective_path: <grep|qmd>
  qmd_available: <true|false>
  state_override: <grep|qmd|auto|null>
  should_suggest_qmd_install: <bool>
  should_warn_grep_unstable: <bool>
</system-context>
```

LLM 记下 `effective_path` 进入 B0.1.

**B0.1 按 effective_path 分支:**

- `effective_path === "grep"`:
  走 B1 (v2 老路径) — 多 anchor Grep + Read frontmatter+重点段.
- `effective_path === "qmd"`:
  - 调 `mcp__qmd__query({vec: <用户原问题>, limit: 10})` 取 recall 结果 (path + snippet + score).
  - 对 `score ≥ 0.6` 的 hits 调 `mcp__qmd__get({path})` 取完整内容; 缺失的 fallback 到 Read 工具读对应路径.
  - 与 grep 模式同样要求: 读 frontmatter + 关键段 (`## 重点摘录` / `## 我的思考` / entity 5-6 段 / concept 定义段) 重建 `[[wiki 链接]]` 粒度.
  - qmd MCP 工具调用失败 (`tool_not_found` / `timeout`) → 降级到 B1 多 anchor Grep 路径, 主对话输出 `[qmd MCP 不可用, fallback 朴素 Grep 召回]` warning 一句 (不阻塞).

**B0.2 引导逻辑 (按 system context 的 flags):**

- `should_suggest_qmd_install === true` (medium tier + qmd 未装 + 引导未跳过):
  主对话输出**一次性**装说明: 「vault >= 500 且当前用朴素 Grep, 你可以考虑装 [qmd](https://github.com/tobi/qmd) 提升召回 (npm i -g @tobilu/qmd). 跳过则后续不再提示 (vault >= 3000 时除外).」
  vault 用户回「跳过」 → 写 vault root `.llm-wiki-query-state.json`:
  ```json
  {"引导_skipped_at": "<当前 ISO 8601>"}
  ```
  若 vault 用户不表态 → 本次 session 不再问, 下次 SessionStart 重新判断.
- `should_warn_grep_unstable === true` (large tier + qmd 未装 + 未 override):
  主对话在**每次询问阶段 B 之前**输出强提示: 「vault >= 3000 朴素 Grep 召回不稳, 强烈建议装 qmd (npm i -g @tobilu/qmd). 已装后下次 session 自动切.」
  直到 vault 用户装上 **或** 在 vault root `.llm-wiki-query-state.json` 写 `"path_override": "grep"` 显式拒绝.

### B0：入口优先级 (vault 内部目录, 不变)

按以下顺序扫目录（与 vault `CLAUDE.md` 铁律 #2 同步）：

```
02_读书笔记/  >  11_entities/  >  12_concepts/  >  01_知识库/  >  03_问答区/(可选)
```

**为什么 11/12 提前到 01 之前：** 11_entities / 12_concepts 是从 02 抽出的结构化索引，grep 命中时常含「X 出现在 N 篇笔记」这种元信息，对合成答案更有杠杆；01 是未加工原文（PDF/书摘），事实密度低于「我的思考」段。

### B1：多 anchor Grep 召回

把用户原问题拆出核心名词短语（实体 / 概念词），对每个 anchor 分别 `grep` 一次，结果跨目录 union 去重。

**优先级内的召回梯度：**

1. 默认扫前 2 个目录（`02_读书笔记/` + `11_entities/`），命中 ≥ 3 篇就停——不再向低优先级目录扩散
2. 命中 < 3 篇 → 扩到 `12_concepts/`
3. 仍 < 3 篇 → 扩到 `01_知识库/`
4. 仍 < 3 篇 → 扩到 `03_问答区/`（**仅在用户明示「之前的问答里」时**才纳入）
5. 所有目录合计仍 < 3 篇 → 输出「仓库无相关笔记」后停

**永远不扫：** `00_模板/`（template 区不当证据源）。

**同命中跨目录排序**：按目录优先级排序，不按 hit 数排序——02 笔记排在 01 笔记前面，即使 01 命中次数更高。

**Anchor 拆分示例：**

```bash
# 用户问：「在知识库查一下 ISO 21434 中的 TARA 方法」
# 拆出 anchor：["ISO 21434", "TARA"]
grep -rl "ISO 21434" 02_读书笔记/ 11_entities/ | head -20
grep -rl "TARA"      02_读书笔记/ 11_entities/ | head -20
# 结果 union 去重 → 按目录优先级排序 → 命中 ≥3 篇就停
```

### B2：Read 深读

对 B1 召回命中的每篇笔记，Read 它的 frontmatter + 关键段：

- frontmatter（`tags` / entity / concept 子类）
- `## 重点摘录`（source 笔记）
- `## 我的思考`（source 笔记）
- entity 的 5-6 段事实陈述（11_entities）
- concept 的定义段（12_concepts）

## 阶段 C：答案输出 + 建议归档

### C1：先输出答案给用户

不论后续是否归档，必须**先**把答案输出到主对话。**不得**先归档再回答。

每条事实必须带 `[[wiki 链接]]`。读 `00_模板/标签词表.md §2`（4 轴枚举）—— 为可能的归档准备 tags。

### C2：自检 Q1-Q5（仅供「建议」提示用）

LLM 自检本次答案，是否命中以下任一条件——命中用作「是否值得归档」的建议信号，**不再自动触发写**：

| # | 信号 | 例 |
|---|---|---|
| Q1 | 答案含 **≥ 3 个可复用事实点** | "ISO 21434 包含 X / Y / Z 三块" |
| Q2 | 答案**跨 ≥ 2 篇既有笔记综合** | "对比 A 文章和 B 文章的 SDV 架构差异" |
| Q3 | 答案含**架构图 / 决策树 / 对比表** | "SDV 三种部署模式的选型决策树" |
| Q4 | **用户追问 ≥ 2 轮**——同一主题深入 | "再展开讲讲 SOA" |
| Q5 | 答案揭示**vault 已有内容之间的新连接** | "A 文章提到的 X 其实和 B 文章的 Y 是同一概念" |

**命中 ≥ 1 条 → 输出「建议归档」提示段**（在答案末尾追加，等用户明示「归档」才真写）：

```text
[建议归档] 命中 Q1 / Q2（列出具体命中条件）。
归档到 `03_问答区/<主题>/<slug>.md`？
回「归档」即写，「跳过」即不写。
```

**全部不命中 → 不**输出建议归档段（避免噪声）。简单事实查询 / 「仓库无相关笔记」场景尤其不要凑 Q。

**绝不**为触发建议归档而人为凑 Q 命中——LLM 自检应当忠于本次答案的真实价值判断。

## 阶段 D：归档阶段（vault 写操作）

**入口条件：仅当用户在「建议归档」提示之后明示「归档 / 写入 / 是」才执行本阶段。**

用户回「跳过 / 不用 / 否」→ **不**归档，**不**写 Log，本次回答到此为止。
用户既不「归档」也不「跳过」→ 不主动追问，等下次用户表态。
用户在没有「建议归档」提示时主动说「归档」→ **反问确认意图**（避免误归档）；确认后再走本阶段。

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
召回方式: "Grep"
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
- `召回方式:` 记录本次 llm-wiki-query 用的召回路径——固定 `Grep`（未来若引入新召回路径再扩枚举）

**正文 4 段**：问题 / 回答（含 `### 引用来源` 子段，必填）/ 相关实体 / 相关概念

**frontmatter 引号约定**：参考 `10_schema/config.md §4` Frontmatter 引号风格约定——标量字段带双引号、数组字段不加引号、`状态:` 不带引号

### D4：强制步骤 — 更新 Index.md + 追加 Log（仅触发归档时）

**触发条件：用户明示「归档」后才执行本步。**

**索引**：在仓库根 `Index.md` append 一条索引条目（标题 / 分类 / `[[03_问答区/<主题>/<slug>.md]]` 路径）。必须、与主任务同次 commit 完成。

按 `00_模板/Log_Spec.md §2` 通用格式 + `§3.4` llm-wiki-query 最小条目（含 `召回方式` 字段）。**必须、与主任务同次 commit 完成。**

```markdown
## YYYY-MM-DD  query  <主题摘要>

- **触发**：用户明示「<原话>」
- **答案路径**：`[[03_问答区/<主题>/<slug>.md]]`
- **归档触发**：Q1 / Q2 / Q3 / Q4 / Q5 命中（命中哪几条列哪几条）
- **召回方式**：`Grep`
- **commit**：`<hash>` 新增 QA 笔记
- **lint 验收**：未跑
```

**用户回「跳过」/「不用」/ 未表态 → 跳过本步**——不回写 vault 就不写 Log，避免噪声。

### D5：告知用户

输出到主对话：

```text
已按你确认归档到 `[[03_问答区/<主题>/<slug>.md]]`。
如需删除：「删 03_问答区/<主题>/<slug>.md」
```

未归档时**不**输出此段（避免噪声）。

# 边界

- ❌ **不**未经用户明示「归档」就写 vault——Q1-Q5 命中仅是「建议」信号，**不**是写操作触发器
- ❌ **不**反向链接到 entity / concept 的 `sources:` 数组——QA 是只读型，污染 sources 计数
- ❌ **不**为触发建议归档而人为凑 Q 命中——LLM 自检应当忠于本次答案的真实价值
- ❌ **不**在没有「建议归档」提示时盲目响应用户「归档」指令——反问确认意图
- ❌ **不**在触发词缺失时强行走归档——零命中就**只输出答案**
- ❌ **不**为归档而捏造 Q 命中——如果答案是简单查事实（"vault 里有没有 X"），就该如实写「仓库无相关笔记」并跳过归档
- ❌ **不**扫 `00_模板/`——template 区不当证据源
- ❌ **不**默认扫 `03_问答区/`——仅在用户明示「之前的问答里」时才纳入
- ❌ **不**做多种输出格式（对比表 / Marp / matplotlib / canvas）——karpathy 原文标注「可选」，本期 YAGNI
- ❌ **不**引入 qmd MCP / BM25 / 向量检索——朴素的 grep + Read 已够用，未来若要升级再拆独立 skill
- ✅ **必须**走 CLAUDE 铁律 #2 检索（按新优先级 `02_读书笔记/ > 11_entities/ > 12_concepts/ > 01_知识库/ > 03_问答区/(可选)`）——不得跳过
- ✅ **必须**每条事实带 `[[wiki 链接]]`
- ✅ **必须**先输出答案给用户，再等用户是否要归档——不颠倒顺序

# v3 路径选择 (SessionStart hook + state.json override)

v3 起, 召回路径**自动**由 `scripts/qmd-detect.mjs` 决定, LLM 仅按 system context 调对应工具 (阶段 B0). vault 用户无需手动选.

**三档 (vault_size 计算 = 递归数 vault 根 .md, 排除 00_模板/ .obsidian/ node_modules/ .git/ temp/):**

| tier | vault_size | automatic 行为 |
| --- | --- | --- |
| `small` | `< 500` | 强制 `grep` (不探 qmd, 不出提示) |
| `medium` | `500 ≤ v < 3000` | qmd 装了就 `qmd`, 没装就 `grep` + **首次引导装一次** |
| `large` | `>= 3000` | qmd 装了就 `qmd`, 没装就 `grep` + **每次询问前强提示** |

`vault_size` 阈值 (500 / 3000) 写死在 `scripts/qmd-detect.mjs` 顶部 `THRESHOLDS`.

## vault 用户 override (可选)

写 vault root `.llm-wiki-query-state.json`:

```json
{
  "path_override": "grep",   // "grep" | "qmd" | "auto" (= 缺省, 自动)
  "引导_skipped_at": "2026-08-29T10:00:00Z"   // 可选, medium tier 跳过引导后写入
}
```

- `path_override: "grep"` — 永远用 grep (vault >= 3000 时用于解封强提示)
- `path_override: "qmd"` — 永远用 qmd (qmd 未装时 LLM 端报 tool-not-found, fallback 到 grep)
- 字段缺失/非法值 → 忽略, 走 auto.

## 设计依据

`scripts/qmd-detect.mjs` 路径决策由 Node 脚本决定 — 不依赖 LLM 自检, 可文档化 / 可测试 / 行为可预测. 三件套: 脚本 + SessionStart hook + state.json override. 完整 spec 见 [docs/superpowers/specs/spec-query.md](../superpowers/specs/spec-query.md).

karpathy LLM Wiki 原文 `reference/llm-wiki.md` §"Optional: CLI tools" 仍为顶层依据: 「at small scale the index file is enough, but as the wiki grows you want proper search」.

## Q1-Q5 与引用粒度

v3 设计明示接受两条 trade-off (写在 [spec §7](docs/superpowers/specs/spec-query.md#7)):

- **Q1-Q5 跨模式不感知** — LLM 看答案本身, 阈值不按召回路径调优.
- **qmd 召回后补 Read 重建 `[[wiki 链接]]` 粒度** — qmd 召回时 hit 列表是 `path+snippet+score`, 后续用 Read 工具读 frontmatter+重点段, 与 grep 模式粒度对齐.

# 关联资产

- 复用：`10_schema/config.md` §1 / §4 / §10
- 复用：`00_模板/Log_Spec.md` §3.4
- 复用：`00_模板/标签词表.md` §2（4 轴枚举）
- 写：`03_问答区/<主题>/<slug>.md`
