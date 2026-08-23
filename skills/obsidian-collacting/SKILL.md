---
name: obsidian-collacting
description: 整理、Inbox、web clipper
---

# 触发条件

当用户说：整理、Inbox、web clipper

# Inbox 双源扫描

`Inbox/` 是新资料暂存区。本 skill 同时识别两类源，但**走两条不同的同步路径**——因为现有 `sync-pdf-notes.mjs` 只识别 `.pdf` 扩展名（见 `scripts/sync-pdf-notes.mjs:167` 的 `walkForPdfs` 过滤），不能直接复用：

| 源目录 | 文件类型 | 物理处理 | 笔记模板 |
| --- | --- | --- | --- |
| `Inbox/**/*.{pdf,PDF}` | PDF（递归） | `mv` 到 `01_知识库/<主题目录>/` | 调 `sync-pdf-notes.mjs --overwrite=false` 自动生成 |
| `Inbox/web_clipper/*.md` | Markdown（web 剪藏，`tags: [clippings]`） | `mv` 到 `01_知识库/<主题目录>/` | **手工复制 `00_模板/读书笔记模板.md` 到 `02_读书笔记/`** 对应位置，手工改 frontmatter（详见步骤 4'） |

> **路径 2（web clipper md）为什么不直接调 sync 脚本**：
> `sync-pdf-notes.mjs:walkForPdfs` 过滤 `endsWith('.pdf')`（固定字串），web clipper md 落不进 scan 列表。
> 强行改脚本（加 `.md` 过滤）会动到现有 sync 单测与 `SYNC-PDF-NOTES-DESIGN.md`，超出本 skill 改动范围——故走"手工模板复制"路径。
> 后续如要把 md 也走脚本，需独立 PR 改 `scripts/sync-pdf-notes.mjs`，加 `--ext=pdf,md` 参数化开关。
>
> **现有 `01_知识库/**/*.md`（如 `AI/Humans and Agents in Software Engineering Loops.md`）是从 `Clippings/` 目录手工归档的旧资产，不是本 skill 路径 2 产生的。**

# 执行动作

1. **扫描** `Inbox/` 双源：
   - `Inbox/**/*.pdf` 递归（沿用 sync 脚本自身的扫描逻辑，但本步只统计文件清单）
   - `Inbox/web_clipper/*.md` 单层（子目录里再嵌套 `.md` 不收，避免误扫）
2. **理解**每个文件的主题（读 frontmatter + 标题，与 `01_知识库/` 已有的子目录对比）
3. **归档**（按 `sys.path` `mv` 而非 `cp`——web clipper md 同名重复时 Inbox 是冗余的）：
   - 主题匹配既有 `01_知识库/<主题>/` → `mv Inbox/<file> 01_知识库/<主题>/`
   - 主题不匹配 → `mkdir -p 01_知识库/<新主题>` → `mv` 过去
   - `01_知识库/<主题>/<同名文件>` 已存在 → **跳过本次归档并报告冲突**（不覆盖已归档源）
4. **同步 PDF 模板**：`node scripts/sync-pdf-notes.mjs --overwrite=false --source-field=source`
   - `--overwrite=false` 防覆盖已写笔记
   - `--source-field=source` 沿用读书笔记模板默认
   - `Created` 数 = 本次新生成的空模板数（同主题同名文件存在则 `Skipped`，不计入 Created）

4'. **同步 web_clipper md 模板**（与步骤 4 并列，仅在 Inbox 里有 web clipper md 时执行）：
   - 对每个 `Inbox/web_clipper/<name>.md`：执行 `cp 00_模板/读书笔记模板.md 02_读书笔记/<主题>/<name>.md`
   - 用 Edit 替换模板里的占位字段：
     - `文章: "{{title}}"` → `文章: "<从 web clipper frontmatter 取 title>"`
     - `作者:` → `作者: "<从 web clipper frontmatter 取 author（数组 join）>"`
     - `创建时间: "{{date}}"` → `创建时间: "<YYYY-MM-DD,系统填当天日期>"`
     - `source: "{{pdf}}"` → `source: "[[01_知识库/<主题>/<name>.md]]"`
   - 若 `02_读书笔记/<主题>/<name>.md` 已存在 → **跳过**并报告冲突
   - **不要**从 web clipper 原文 frontmatter 里拷贝 `tags: clippings` / `source: URL` 到新笔记 frontmatter（clippings 是源标记、非 4 轴 tag；URL 已在原文，不进 4 字段 frontmatter）
5. 根据 `02_读书笔记/` 的模板要求，撰写对应文章的内容和知识点，**直接保存入库，无需用户确认**。**打标前必须先 Read** [`00_模板/标签词表.md`](../../00_模板/标签词表.md) 锁定 4 轴枚举，frontmatter `tags:` 字段仅从 §2 词表 35 个枚举值中选取，禁止自由 tag。
6. 更新仓库根的 `Index.md`，为每篇新归档的资料添加索引条目（包含：标题、分类、关键概念、文件路径）
8. 完成后告诉我处理了多少篇，分别归入了哪些分类（按源类型拆分报告：PDF N 篇 / MD M 篇）。**并在末尾追加「建议更新词表」段**——汇总阶段 2 sub agent 的词表更新候选，按候选值 + 词表段二元组 dedup 后告知用户，由用户显式确认是否补入 `00_模板/标签词表.md`：

```
本次 ingest 处理 N 篇，归入以下分类：
- PDF: X 篇
- MD: Y 篇

【建议更新词表 00_模板/标签词表.md】以下候选值在多篇文章中出现但词表未枚举：
1. §2 domain `xxx`：在<文章1> + <文章2> 主题段出现，与已有 16 个 domain 区分度为……
2. ……输入「确认」我立即把以上候选补入词表对应 §；输入「跳过」保留自由 tag 等 lint-wiki 异步处理。
```

- 用户回「确认」→ 主对话用 Edit 工具修改 `00_模板/标签词表.md`：
  - §2 的 axis 表格追加一行（保持值小写 + 中文含义 + 适用场景）
  - §3/§4 子类表格追加一行
- 用户回「跳过」→ 不动词表；该 sub agent 打的自由 tag 留给 lint-wiki 后续捕获

9. **强制步骤 — 追加 Log**：在仓库根 `Log.md` 末尾 append 本次操作的 Log 条目（必须、与主任务同次 commit 完成）。格式严格按 `10_schema/config.md §12.3` 要求。

# 两层 sub agent 工作流

> `Created ≥ 2` 时启动两层 sub agent；`Created = 1` 时串行两层；`Created = 0` 跳过 sub agent。
> **Created 数 = 步骤 4（sync 脚本新生成 PDF 笔记数） + 步骤 4'（web_clipper md 手工模板数）** 的合计。

## 阶段 2：写阅读笔记（并行）

主对话完成步骤 1–4（含 4'），列出 `Created` 笔记清单。

每篇笔记一个 sub agent，**单 message 多 tool call** 并发启动（最多 10 个）。

sub agent prompt 必须包含：
- **source 绝对路径**（已归档到 `01_知识库/<主题>/`；PDF 或 web clipper md 一视同仁）
- 目标笔记绝对路径（已由 sync 脚本生成）
- **source 类型**（`pdf` 或 `md`）——决定读取方式（见下）
- 词表绝对路径：`00_模板/标签词表.md`（**打标前必读**，仅从 §2 枚举中取值）
- 笔记结构：`摘要` + `重点摘录` + `我的思考` + `总结：最有收获的一句话`
- 写作风格：汽车软件架构师视角，指出"工程价值 / 盲点 / 实操建议"
- frontmatter + tags 规则：按 `00_模板/读书笔记模板.md` + `00_模板/标签词表.md` §1/§2
- entity / concept `tags:` 取值见 [`00_模板/标签词表.md` §3 / §4](../../00_模板/标签词表.md)（收编自原 config §4 / §5）
- **输出段建议含「词表更新建议」**：完成目标笔记 + 顺手改建议后，**仅在命中下方强信号判定表任一条件时**输出 `## 词表更新建议（≤3 条）` 段；弱信号（已有 axis 内能找合理 tag）跳过

### source 类型差异处理

| source 类型 | 读取方式 | 作者/日期提示 | verbatim 引用差异 |
| --- | --- | --- | --- |
| `pdf` | Read 工具读 PDF 二进制；或 pdf-plus 插件 | 可能需从 PDF 头部/正文推断 | 带页码（如 `原文片段 (p.3)：`） |
| `md`（web clipper） | Read 工具直接读文本 | frontmatter 通常自带 `title` / `author` / `published`；sub agent **只取 `title` 和 `author`**，**不**取原文 `tags: clippings`（那是源标记，非 4 轴 tag） | **不**带页码；原文 URL（如有）放「我的思考」段作上下文，但**不**写入 frontmatter `source:`（那里必须指向 PDF/md 本体 wiki-link） |

sub agent 只读 source + 写目标笔记。
**不要追加 `## Related Pages` 段**——那是阶段 3 任务 D 的职责，越界会导致 slug 漂移风险。

### 词表更新建议（≤3 条，强信号）

sub agent 在打 tag 前已 Read [`00_模板/标签词表.md`](../../00_模板/标签词表.md) 锁定 4 轴枚举。如果 source 文章的主题在词表里**没有精准覆盖**——满足下表「强信号」任一条件——则输出"词表更新建议"段（与「顺手改建议」并列，**最多 3 条**）：

| 词表段 | 强信号判定（sub agent 视角） |
|---|---|
| §2 domain | 文章主题**横跨 ≥2 个已有 domain**（如同时谈 SDV + AI），且主导 domain 不存在 |
| §2 layer | 文章聚焦的"技术栈层次"在已有 6 个 layer 中找不到对应（如"工具链"被错放 `process`） |
| §2 phase | 文章生命周期阶段在已有 8 个 phase 中找不到对应（如"退役 / EOL"） |
| §2 maturity | 文章描述的成熟度阶段在 5 个之外（如"实验室内测 / alpha"） |
| §3 entity 子类 | 文章主要实体在 7 个子类中找不到对应（如"概念性项目 / framework-as-entity"） |
| §4 concept 子类 | 文章核心概念在 7 个子类中找不到对应（如"反模式 / antipattern"） |

**弱信号 → 不提**：本次 source 在已有 axis 内能找到合理 tag（如 `adas` / `ee-arch`），但还想细分 → 走 lint-wiki 异步通道，不在本次 prompt 里提议。

输出格式（与「顺手改建议」并列追加）：

```markdown
## 词表更新建议（≤3 条）

1. `00_模板/标签词表.md §2 domain` — 新候选 `xxx`：理由（出现在<文章>主题段，与已有 16 个 domain 区分度高；例：`区别于 ee-arch 在于……`）
2. `00_模板/标签词表.md §3 entity` — 新候选 `xxx`：理由（……）
3. ...
```

## 阶段 3：抽取 entity/concept（串行）

> 串行的关键：避免两个 sub agent 同时改 `11_entities/Vector.md` 的 `sources:` 数组导致覆盖。

阶段 2 全部完成后，**每篇 source 笔记启动一个 sub agent**，从已写好的 `02_读书笔记/<path>.md` 抽取实体和概念，**不读 source**（节省 token，且阅读笔记已是结构化摘要；不论 source 是 PDF 还是 web clipper md，路径写法一致）。

sub agent prompt 必须包含：
- source_note_path：`02_读书笔记/<分类目录>/<文章名>.md`（阶段 2 已写好）
- config_path：`10_schema/config.md`（**single source of truth**，§4 entity / §5 concept 模板）
- entity_dir：`11_entities/`
- concept_dir：`12_concepts/`

### 阶段 3 sub agent 任务清单

**任务 A：抽取实体**

按 config §4 实体子类枚举（person / organization / project / product / event / place / other）从 source_note_path 全文（含 frontmatter + 4 段正文）抽取。

slug 规则：
- person：`Firstname-Lastname`（如 `Stefany-Chourakorn`）
- organization：全名 slug（如 `IEEE` / `Infineon` / `Vector`）
- project：缩写展开或保留缩写（如 `AES-2026` / `AUTOSAR`）
- product：厂商原名（如 `AURIX` / `VectorCAST`）
- event：名 + 年（如 `IEEE-Ethernet-Day-2024`）
- place：pinyin 或保留原文（`Munich` / `Shanghai`）

候选名抽取时同时记录每个候选的**别名候选**（中文/英文/缩写/变体）供任务 E dedup 用。

**任务 B：抽取概念**

按 config §5 概念子类枚举（theory / method / field / phenomenon / standard / term / other）抽取。同任务 A 记录别名候选。

**任务 E：三档 dedup**

主对话预加载传给 sub agent：

```yaml
aliases_index:
  # alias_lower → existing_slug
  "nio": ["nio"]
  "蔚来": ["nio"]
  "蔚来汽车": ["nio"]
  "sdv": ["sdv"]
  "software-defined-vehicle": ["sdv"]
  "waymo": ["waymo"]
  # ...
existing_slugs:
  # 11_entities/ + 12_concepts/ 下所有 .md basename 列表
  ["nio", "waymo", "baidu-apollo", ..., "sdv", "seL4", ...]
```

对任务 A/B 抽出的每个候选：

1. **slug normalize**：候选 slug 走 `normalize()`（v2 纯函数：全小写 + 去空格/连字符/下划线）
2. **Tier 1（必走）**：查 `aliases_index` + normalize 后 `existing_slugs`
   - 命中 → `merge_target = existing_slug`，跳到任务 C 的"命中已有"分支
3. **Tier 2（token 预算内）**：编辑距离 ≤ 2 + 同 tag → LLM 二次确认
   - confirmed → `merge_target`
4. **Tier 3（fallback）**：LLM 直接判断两个候选是否同一实体/概念
   - same → `merge_target`
   - not same → 新 slug

LLM Wiki 设计参考：`green-dalii/obsidian-llm-wiki` Tiered duplicate detection。

**任务 C：写 / 改 entity/concept 页**

对每个候选（有 `merge_target` 或新 slug）：

1. 检查 `11_entities/<slug>.md` 或 `12_concepts/<slug>.md` 是否存在
2. 不存在 → 按 config §4 / §5 模板**新建**，frontmatter **必填**：
   - `aliases:` ≥ 1 项（决策 D2：中等等级）
   - `sources:` 含本次 source wiki-link
   - `type:` "entity" 或 "concept"
   - `tags:` 从 §4/§5 7 子类枚举单选
   - `created:` 系统填（YYYY-MM-DD）
   - `updated:` 系统填（YYYY-MM-DD，新建即与 created 同值）
3. 存在 + `reviewed: true` → 只做 append(机器**不**改写正文)：
   - `sources:` append（去重，**永不删**）
   - `aliases:` append（去重，**永不删**已有别名）
   - `## Mentions in Source` 段 append verbatim 引用（按 source 分组）
   - **不动**正文
   - **不动** `updated:`（因为正文未改）
4. 存在 + `reviewed` 缺失或 `reviewed: false` → 机器**直接 Edit 正文**：
   - `sources:` append（去重）
   - `aliases:` append（去重）
   - `## Mentions in Source` 段 append verbatim 引用
   - **Edit 5 段 / 6 段正文**(LLM 重写 + 补充新信息)
   - **`updated:` 同步刷成本次 ingest 日期**（YYYY-MM-DD）
5. **source-level 去重**:本次 source 已在 `sources:` 列表中 → early return 跳过整次 append
6. **正文缩水保护**:若 Edit 后正文长度 < 改前 50% → abort,不写盘,主对话报警

verbatim 引用按 config §6。

**任务 D：source 笔记追加 `## Related Pages` 段**

如果 source 笔记末尾**没有** `## Related Pages` 段，追加：

```markdown
## Related Pages

### Entities
- [[11_entities/<entity-slug-1|Display]]
- [[11_entities/<entity-slug-2|Display]]

### Concepts
- [[12_concepts/<concept-slug-1|Display]]
```

`Display` 用人话可读名（如 `[[11_entities/vector|Vector]]`）。

只有实体没概念时省略 Concepts 子标题，反之亦然。

# 批编译（顺手改建议）

单篇 ingest 不仅写目标笔记，还要**识别同主题相关页并提示主对话**。

每个阶段 2 sub agent 在完成目标笔记后，必须额外输出 **"顺手改建议"清单**：

```markdown
## 顺手改建议（≤5 条）

1. `02_读书笔记/<路径>` — 在「我的思考」段末尾追加一行 "参见 [[本笔记]]" + 一句话关联说明
2. `02_读书笔记/<路径>` — ...
```

识别规则：
- 同主题（tag 重叠 ≥2 个）
- 同作者 / 同会议 / 同技术族（同 SDV 平台 / 同 OEM）
- 同源（同 arXiv 主题 / 同 PDF 文件名前缀）

**sub agent 不直接修改其他笔记**（避免破坏 frontmatter 一致性）；主对话汇总后人工 review 决定写不写。