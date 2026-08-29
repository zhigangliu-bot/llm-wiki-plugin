# llm-wiki-plugin 总设计规范

- 文档目的:一份文档说明整个 plugin 是什么、为什么这样设计、5 个 skill 如何在文档生命周期中协同
- 适用范围:plugin 维护者 + vault 使用者
- 与本规范平行的:各 skill 自己的 `spec-<skill>.md`(细节),`10_schema/config.md`(vault 端 schema 唯一信息源),`reference/llm-wiki.zh.md`(思路源头)

---

## 1. 一句话定位

> **llm-wiki-plugin = 让 Claude Code 在你的本地 Obsidian vault 上,按 karpathy LLM Wiki 模式,自动化地摄取 / 查询 / 体检 / 冷启动一个持续演化的个人 wiki。**

人和 LLM 的分工对照 karpathy 原文:

| 角色 | 干什么 |
|---|---|
| **人** | 策展素材、提探索方向、问正确的问题、review 机器写入 |
| **LLM**(Claude Code) | 摘要、抽取实体/概念、交叉引用、归档、簿记 |
| **Obsidian** | IDE —— 浏览结果、看图谱、跟随链接 |
| **vault(本仓产物)** | 代码 —— 5 类 markdown 文件的 git 仓 |

---

## 2. 设计思想:从 karpathy 思路到 plugin 实现

### 2.1 karpathy 思路的三个关键洞察

`reference/llm-wiki.zh.md` 把模式抽象成「LLM 持续维护 wiki」三件事:

1. **wiki 是持久化的产物** —— 不是 RAG,不是每次查询重新检索;是累积的、可被 git 版本化的 markdown 文件集合
2. **schema 是纪律化配置** —— `CLAUDE.md` / `AGENTS.md` 让 LLM 从通用 chatbot 变成「有纪律的 wiki 维护者」
3. **好答案要归档回 wiki** —— 查询产物不是聊天记录,是新的 wiki 页

### 2.2 plugin 把这三点如何落地

| 思路 | plugin 实现 |
|---|---|
| 持久化 wiki | vault 是一个标准 Obsidian vault(14 个目录 + 5 类 markdown),在用户机器上有完整副本,通过 git 受版本管理 |
| schema 纪律化 | `10_schema/config.md` + `00_模板/标签词表.md` + `00_模板/读书笔记模板.md` 三件套作为 vault 端 Single Source of Truth;所有 skill / 脚本读这一份,不允许副本 |
| 答案归档 | `llm-wiki-query` 触发 Q1-Q5 强信号判定 → 全自动写 `03_问答区/` + append `Index.md` + `Log.md` |

### 2.3 plugin 在原文基础上加了什么

karpathy 原文是「思路文件」,刻意保持抽象。plugin 在它之上加了**工程纪律**:

| 工程纪律 | 体现 |
|---|---|
| **5 个 skill 显式触发** | 不做隐式激活(隐式会和 CLAUDE 铁律 #2「先检索仓库」重叠 + 浪费 token)。每个 skill 有明确的触发词清单 |
| **SKILL.md 文本流 + 脚本纯 IO 分离** | 所有 mkdir / cp / 拷贝脚本进 `scripts/*.mjs`(可单测、可 mock),SKILL.md 只负责 LLM 流程编排 |
| **目录命名保留中文** | `01_知识库/` / `02_读书笔记/` / `11_entities/` / `12_concepts/` / `03_问答区/` —— 中文目录保留 vault 浏览时的语义可读性,内部 wiki-link 全路径强制 |
| **frontmatter 强约束** | 4 层 markdown(source / entity / concept / qa)各自有不同的强制字段 + 引号约定 + 类型约束,由 `lint-wiki` 周期性体检 |
| **Log.md 倒序追加 + 自动入口** | `scripts/log-append.mjs` 把 5 个 skill 的写入收口,统一按 `10_schema/config.md §13.1` 倒序格式输出,人 / LLM 都能用 `grep "^## \[" Log.md \| tail -5` 解析 |
| **plugin 升级 + vault 解耦** | init 时拷 `scripts/` 到 vault(白名单覆盖);资产 md 用 `copyIfMissing` 保留用户修改 —— 两类资源策略不同 |

---

## 3. 三层架构:文档怎么组织

plugin 自身是分层交付物,和 karpathy 原文的「原始素材 / wiki / schema」三层一一对应:

```
┌──────────────────────────────────────────────────────────────────────┐
│ Layer 1:plugin 仓(f:\llm-wiki-plugin/)                              │
│   交付物:plugin 源码 + 模板 + schema + 文档                            │
│   角色:karpathy 思路 → Claude Code 可消费的具体实现                    │
│   关键文件:                                                         │
│     - skills/<name>/SKILL.md       5 份,LLM 流程编排                   │
│     - scripts/*.mjs                7 份,纯 IO(Node stdlib)            │
│     - scripts/*.test.mjs           5 份,node:test 内置单测              │
│     - 10_schema/config.md          vault 端 schema 唯一信息源             │
│     - 00_模板/                     4 类 markdown 模板                  │
│     - reference/llm-wiki.{md,zh.md} karpathy 原文 + 中文版             │
│     - docs/superpowers/specs/      plugin 端 spec 文档                  │
│     - .mcp.json                    qmd MCP server 声明(可选)           │
│     - hooks/hooks.json             SessionStart 升级检查               │
└──────────────────────────────────────────────────────────────────────┘
                              ↓ init 阶段拷贝
┌──────────────────────────────────────────────────────────────────────┐
│ Layer 2:vault(用户机器上的 Obsidian 仓,git 受版本管理)                │
│   交付物:14 个目录 + 5 类 markdown 笔记 + scripts/                   │
│   角色:LLM 写、用户读的持续累积产物                                     │
│   关键路径:                                                        │
│     - 01_知识库/                原始素材(不可变)                       │
│     - 02_读书笔记/              source 笔记(LLM 写)                  │
│     - 03_问答区/                qa 笔记(LLM 写,只读型)                │
│     - 11_entities/              entity 页(LLM 写,可 review 锁)       │
│     - 12_concepts/              concept 页(LLM 写,可 review 锁)       │
│     - 00_模板/                  笔记模板 + 标签词表                     │
│     - 10_schema/                wiki schema(vault 端 SoT)             │
│     - scripts/                  init 时拷入的 4 个 CLI 脚本             │
│     - Index.md / Log.md         索引 + 操作流水                         │
│     - CLAUDE.md                 用户自维护 + init 注入的 llm-wiki 段    │
└──────────────────────────────────────────────────────────────────────┘
                              ↓ Obsidian 打开浏览
┌──────────────────────────────────────────────────────────────────────┐
│ Layer 3:用户工作流                                                   │
│   - Obsidian:浏览、图谱视图、跟随链接                                  │
│   - Claude Code:在 vault 根或子目录触发 skill                         │
│   - Git:版本管理 vault + vault 内 Log.md 演进时间线                    │
└──────────────────────────────────────────────────────────────────────┘
```

### 3.1 5 类 markdown 笔记的角色对照

| 类型 | 目录 | 谁写 | 谁读 | 角色 |
|---|---|---|---|---|
| **source** | `02_读书笔记/` | LLM(obsidian-collacting / kg-sync) | LLM + 人 | 原始素材的逻辑表示 |
| **entity** | `11_entities/` | LLM,可被人 `reviewed: true` 锁 | LLM + 人 | 被多 source 引用的单点实体 |
| **concept** | `12_concepts/` | LLM,可被人 `reviewed: true` 锁 | LLM + 人 | 跨 source 抽象的单点概念 |
| **qa** | `03_问答区/` | LLM(llm-wiki-query) | LLM + 人 | 查询产物,只读型,不参与反向链接 |
| **template / schema** | `00_模板/` + `10_schema/` | 人工维护(偶尔) | LLM | schema + frontmatter 引号约定 |

### 3.2 模板层:5 个文件在 plugin 中的角色

plugin 的 5 类 markdown 笔记不是「LLM 凭空造出来的」——它们的形状由 `00_模板/` 下 5 个模板文件规定。每个模板都有明确角色:

| 文件 | 角色 | 谁读 | 谁维护 |
|---|---|---|---|
| [`00_模板/读书笔记模板.md`](../../00_模板/读书笔记模板.md) | source 笔记的**占位空壳** —— 含 5 字段 frontmatter + 4 段固定正文(摘要/重点摘录/我的思考/总结) | `sync-pdf-notes.mjs`(拷过去填占位)+ obsidian-collacting 阶段 2 sub agent(填充正文) | 人工偶改(改段名/加段要先升 schema) |
| [`00_模板/标签词表.md`](../../00_模板/标签词表.md) | **标签体系 single source of truth** —— 4 轴(domain/layer/phase/maturity)枚举 + entity 子类 + concept 子类 + 三层 type×tags 互斥规则 | 全部 5 个 skill 的 sub agent 打标前必读;lint-wiki `tag-drift` 检查 | 人工维护(词表外新候选由 obsidian-collacting 在报告里汇总,用户显式确认后补入) |
| [`00_模板/Log_Spec.md`](../../00_模板/Log_Spec.md) | **Log.md 写入唯一规范** —— §1 硬约束(不用 wiki 链接)+ §2 通用格式(倒序/H2 双空格/反引号路径)+ §3 4 skill 最小条目 | `scripts/log-append.mjs`(按 §2 格式输出);5 个 skill 收尾必须调 log-append | 人工偶改(加新 skill 最小条目) |
| [`00_模板/Index_Spec.md`](../../00_模板/Index_Spec.md) | **Index.md 写入唯一规范** —— §2 路径硬约束(必须 wiki-link,禁止 markdown link / 反引号)+ §3 表格结构 + §5 触发时机白名单 | obsidian-collacting 阶段 3 + llm-wiki-query 阶段 D4 | 人工偶改 |
| [`00_模板/CLAUDE_Template.md`](../../00_模板/CLAUDE_Template.md) | **vault 端 CLAUDE.md 的注入段** —— 包含仓库性质 / 5 条铁律 / 身份 / 5 skill 协作约定 | `scripts/init-vault.mjs`(注入到 vault/CLAUDE.md,begin/end 包裹) | 人工维护(plugin 升级时 init 会 in-place 刷新 begin/end 中间内容) |

**关键设计**:

- **`读书笔记模板.md` 是空壳,不是成品** —— 它的字段值是占位的(空字符串),由 sync 脚本或 sub agent 填实。这是「模板」与「成品笔记」的核心区别
- **`标签词表.md` 是 5 个 skill 的共同语言** —— 没有它,LLM 写笔记时 tags 字段会自由发挥,`lint-wiki tag-drift` 会大量误报。词表是「LLM 打标可枚举」的唯一约束
- **`Log_Spec.md` 和 `Index_Spec.md` 是收尾规范** —— 与 skill 行为契约解耦,所有 skill 共享同一份格式约束(避免每个 skill 自己定义一套)
- **`CLAUDE_Template.md` 是 vault 端 CLAUDE.md 的「注入段」** —— init 把它包在 `<!-- llm-wiki-plugin-init:begin/end -->` 之间;vault 用户的 CLAUDE.md 可能有自己写的「私人段」,begin/end 包裹保证那段一字不动

### 3.3 模板与 skill 的耦合关系

| 模板 | 哪个 skill 强依赖 | 怎么用 |
|---|---|---|
| `读书笔记模板.md` | obsidian-collacting(强) / lint-wiki(中,只检查空段) | sync 脚本 cp 到 `02_读书笔记/<主题>/<name>.md`,sub agent Edit 占位字段 |
| `标签词表.md` | obsidian-collacting(强,打标前必读)/ knowledge-graph-sync(强,entity/concept tags)/ llm-wiki-query(强,QA tags)/ lint-wiki(强,tag-drift 检查) | Read 全文锁定枚举;sub agent tags 字段仅从 §2 枚举取值 |
| `Log_Spec.md` | 5 个 skill 全部 | `scripts/log-append.mjs` 内嵌格式约束(与 §2 一一对应) |
| `Index_Spec.md` | obsidian-collacting(强) / llm-wiki-query(强) | 阶段 3 / D4 按 §3 表格 append 一行 |
| `CLAUDE_Template.md` | llm-wiki-plugin-init(强) | init 时按 begin/end 包裹注入 vault/CLAUDE.md |

---

## 4. 文档生命周期 pipeline:5 个 skill 在 wiki 演进中的角色

karpathy 原文给 wiki 生命周期定义了三个动作:**Ingest / Query / Lint**。plugin 在这之上加了**两个补集**:**Init**(冷启动)+ **kg-sync**(存量反链补全),构成完整的 5 步 pipeline。

**泳道图**:[`pipeline.puml`](pipeline.puml) — 5 个泳道 = 5 个 skill,渲染后可见各 skill 内部动作 + 跨 skill 数据流。

```
            ┌─────────────────────────────────────────────┐
            │      1. llm-wiki-plugin-init (cold start)   │
            │      用户首次:建 vault + 灌资产 + 注入 CLAUDE.md │
            └─────────────────────────────────────────────┘
                                  ↓
   ┌─────────────────┐    ┌─────────────────┐    ┌─────────────────┐
   │  2. obsidian-   │    │  3. knowledge-  │    │  4. llm-wiki-   │
   │  collacting     │    │  graph-sync     │    │  query          │
   │  Inbox→source   │    │  存量反链补全    │    │  查询+归档       │
   │  (摄取)         │    │  (kg-sync)      │    │  (Query)        │
   └─────────────────┘    └─────────────────┘    └─────────────────┘
            ↓                      ↓                      ↓
            └──────────────────────┴──────────────────────┘
                                  ↓
            ┌─────────────────────────────────────────────┐
            │      5. lint-wiki (周期性体检)              │
            │      扫三类问题:数据完整性 / 词表一致性 / 链接健康│
            └─────────────────────────────────────────────┘
```

### 4.1 Pipeline 各阶段详细动作

#### 阶段 1:llm-wiki-plugin-init(冷启动,一次性)

- **触发**:用户首次用 plugin / 新建 vault / 重装
- **做什么**:
  1. 在用户指定路径建 14 个目录 + 5 个顶层 md 占位文件
  2. 拷贝 plugin 自带资产到 vault(`00_模板/` `10_schema/` `Inbox/web_clipper/README.md`)
  3. 把 `00_模板/CLAUDE_Template.md` 注入到 `vault/CLAUDE.md`(begin/end 包裹,幂等不重复)
  4. 拷 4 个 CLI 脚本到 vault 根的 `scripts/`(白名单,覆盖写,plugin 升级同步)
- **不做什么**:不生成 `INIT_LOG.md`、不调 LLM 走 diff preview、不支持 `--force`
- **下一步**:`✅ vault 已就绪` → 用户可走 obsidian-collacting / lint-wiki / kg-sync

> 详细规范:[spec-init.md](spec-init.md)

#### 阶段 2:obsidian-collacting(Inbox → source,摄取)

- **触发**:用户把素材放进 `Inbox/`,说「整理」「Inbox」「web clipper」「office」「ppt」「word」「excel」「图片」
- **做什么**:把 Inbox 6 类源(PDF / web clipper md / PPT / Word / Excel / 图片)各自走不同路径
  - **PDF**:调 `sync-pdf-notes.mjs` 自动生成空模板
  - **web_clipper md**:手工 cp 模板(避开 sync 脚本的 `endsWith('.pdf')` 硬过滤)
  - **PPT / Word / Excel**:先调 `convert-office.mjs`(走 anydoc / pandoc / libreoffice fallback)预转 md,再 cp 模板
  - **图片**:先调 `convert-office.mjs`(走 PaddleOCR)预转 md,再 cp 模板
  - 全部走两步 sub agent 工作流:阶段 2 并行写笔记 → 阶段 3 串行抽 entity/concept(避免 sources 数组覆盖)
- **不做什么**:不读 PDF 内容本身写笔记(由 sub agent 读);不修改 reviewed: true 的 entity/concept 正文
- **强制收尾**:append `Index.md`(新建/删除对应)+ append `Log.md`(倒序,§13.1 格式)

> 详细规范:[spec-obsidian-collacting.md](spec-obsidian-collacting.md)

#### 阶段 3:knowledge-graph-sync(存量反链补全,kg-sync)

- **触发**:用户说「knowledge graph」「同步反向引用」「知识图谱同步」
- **做什么**:
  - 扫 `02_读书笔记/` 找**没有** `## Related Pages` 段的笔记(obsidian-collacting 已处理的会跳过)
  - 主对话直接抽取 entity/concept,写入 `11_entities/` `12_concepts/`
  - 为 source 笔记追加 `## Related Pages` 段
- **不做什么**:不读 PDF、不启动 sub agent、不修改 frontmatter 字段、不动 `01_知识库/` 的归档
- **强制收尾**:append `Log.md`

> 详细规范:[spec-knowledge-graph-sync.md](spec-knowledge-graph-sync.md) — 本文件待补,与本规范平级

#### 阶段 4:llm-wiki-query(查询 + 归档,Query)

- **触发**:用户说「查 wiki」「问个问题」「query」「查 vault」「知识库里有没有 X」「我问个问题」
- **做什么**:四阶段流程
  1. **A 触发判定**:必须显式含触发词
  2. **B 查询阶段**:优先 qmd MCP `query`/`get`(混合 BM25/vec + reranking);qmd 未装自动降级 Grep+Read
  3. **C 归档判定**:LLM 自检 Q1-Q5 强信号(≥3 事实点 / 跨 ≥2 source / 含图表 / 追问 ≥2 轮 / 揭示新连接)
  4. **D 归档阶段**:满足 ≥1 → 全自动写 `03_问答区/<主题>/<slug>.md`;路径冲突走 `## 续答` 段追加
- **不做什么**:不反向链接到 entity/concept 的 `sources:`(QA 是只读型);不为归档而捏造 Q 命中
- **强制收尾**(仅触发归档时):append `Index.md` + append `Log.md`(含 `召回方式` 字段)

> 详细规范:[spec-query.md](spec-query.md)

#### 阶段 5:lint-wiki(周期性体检,只读)

- **触发**:用户说「lint」「healthcheck」「检查 vault」「扫一遍」
- **做什么**:`scripts/lint-wiki.mjs` 扫 15 类问题 + 1 节 Vocab Suggestions 到 `scripts/_lint-report.md`
  - 6 类 source 笔记问题(missing-meta / orphan / stale / tag-drift / duplicate / contradictions)
  - 3 类 entity 页问题(missing-aliases / tag-drift / name-clash)
  - 3 类 concept 页问题(missing-aliases / tag-drift / name-clash)
  - 3 类跨目录问题(cross-dir-dup / sources-too-many / log-backlinks)
  - 1 节词表补全建议(从 3 类 tag-drift 归桶出词表外候选)
- **不做什么**:不修改任何笔记、不读 PDF、不动 `01_知识库/`
- **强制收尾**:append `Log.md`(诊断摘要)

> 详细规范:[spec-lint-wiki.md](spec-lint-wiki.md) — 本文件待补

### 4.2 skill 间依赖矩阵

| ↓ 上游 / → 下游 | init | obsidian-collacting | kg-sync | query | lint |
|---|---|---|---|---|---|
| **init** | — | 无依赖 | 无依赖 | 无依赖 | 无依赖 |
| **obsidian-collacting** | 无依赖 | — | 互补(kg-sync 补存量) | 无依赖 | 周期体检 |
| **kg-sync** | 无依赖 | 反向依赖(obsidian-collacting 跳过已 Related Pages 的) | — | 无依赖 | 周期体检 |
| **query** | 间接(init 时建 `03_问答区/`) | **互斥**(不调) | **互斥**(不调) | — | 周期体检 |
| **lint** | 无依赖 | 只读 | 只读 | 只读 | — |

**关键设计**:

- **obsidian-collacting ↔ kg-sync 是互补关系**:obsidian-collacting 处理 Inbox 新增 → 自动 append Related Pages;kg-sync 处理存量(无 Related Pages 的旧笔记)。两端都对 `02_读书笔记/` 写,但写的是不同段,互不冲突
- **query ↔ 其它都是互斥**:query 触发时不调任何其它写 vault 的 skill(它就是只调自己);但 lint-wiki 可以周期性体检 query 产出的 `03_问答区/`
- **所有 skill 都依赖 init**:没有 init 就没有 `01_知识库/` `02_读书笔记/` 等目录,但 init 是用户显式触发,其它 skill 不会自动调 init

### 4.3 数据流:一条素材从 Inbox 到被 query 引用的完整轨迹

```
用户从浏览器剪藏一篇文章到 Inbox/web_clipper/foo.md
       ↓
用户说"整理 Inbox"
       ↓
obsidian-collacting 触发:
  1. 扫 Inbox/web_clipper/foo.md
  2. 读 frontmatter 取 title/author → 推断主题(对比 01_知识库/ 已有子目录)
  3. mv Inbox/web_clipper/foo.md → 01_知识库/<主题>/foo.md
  4. cp 00_模板/读书笔记模板.md → 02_读书笔记/<主题>/foo.md
  5. Edit 替换 4 个占位字段(文章/作者/创建时间/source)
  6. 并行启动 sub agent × 1(本主题下 Created=1)写笔记(读 web clipper md 原文 + 词表)
  7. 串行启动 sub agent × 1 抽 entity/concept
     - 抽取 entity: "Foo Inc."(organization) → 11_entities/foo-inc.md 新建
     - 抽取 concept: "Bar Pattern"(method) → 12_concepts/bar-pattern.md 新建
     - 给两个页 append sources: [[02_读书笔记/<主题>/foo.md]]
     - 给两个页 ## Mentions in Source 段 append 原文片段
  8. 给 foo.md 末尾追加 ## Related Pages 段(Entities + Concepts)
  9. Index.md append 一条:[[02_读书笔记/<主题>/foo.md]]
  10. Log.md 倒序追加一条(obsidian-collacting 最小条目)
       ↓
几周后用户问:"vault 里有没有关于 Bar Pattern 的内容?"
       ↓
llm-wiki-query 触发:
  1. 调 qmd MCP query(vec: "Bar Pattern")
     - 命中:12_concepts/bar-pattern.md(score 0.85)
  2. 调 qmd MCP get(bar-pattern.md)取完整内容
  3. LLM 用引用合成答案:
     - 「Bar Pattern 是 Foo Inc. 在 [[02_读书笔记/<主题>/foo]] 第 3 段提出的设计模式,核心是……」
  4. 归档判定:命中 Q1(≥3 事实点)→ 走 D 归档
  5. 写 03_问答区/<主题>/bar-pattern-explained.md(双 frontmatter + 4 段)
  6. Index.md append 一条
  7. Log.md 倒序追加一条(query 最小条目,含 召回方式: qmd-mcp)
       ↓
下个月用户说"扫一遍 wiki"
       ↓
lint-wiki 触发:
  - 检查 02_读书笔记/<主题>/foo.md:无问题(有 Related Pages、tags 在枚举内、状态: true)
  - 检查 11_entities/foo-inc.md:无问题(aliases 填了、tag 是 organization)
  - 检查 12_concepts/bar-pattern.md:无问题
  - 检查 03_问答区/<主题>/bar-pattern-explained.md:无问题
  - Log.md append 一条诊断摘要:全部为 0
```

---

## 5. 关键设计决策(为什么这样)

### 5.1 SKILL.md + 脚本的分工

**决策**:所有 mkdir / cp / 拷贝 / 文件 IO 进 `scripts/*.mjs`,SKILL.md 只负责 LLM 流程编排。

**理由**:

- shell 单行难做失败处理(8 种场景见 [spec-check-update.md](spec-check-update.md) 的行为契约表)
- Node 脚本可被 `node --test` 覆盖(grep stderr / stdout / exit code)
- SKILL.md 是给 LLM 读的,纯流程文本,不需要维护 IO 边界

**当前脚本清单**(7 份):

| 脚本 | 职责 | 触发方 |
|---|---|---|
| `init-vault.mjs` | 建 vault 目录 + 拷资产 + 注入 CLAUDE.md | init skill |
| `sync-pdf-notes.mjs` | PDF → 空笔记模板 | obsidian-collacting 步骤 4 |
| `convert-office.mjs` | pptx/docx/xlsx/image → md | obsidian-collacting 步骤 4'' |
| `lint-wiki.mjs` | 扫 15 类问题 + 词表建议 | lint-wiki skill |
| `log-append.mjs` | Log.md 倒序追加(CLI + 函数双入口) | 5 个 skill 收尾 |
| `check-update.mjs` | SessionStart hook,git pull --ff-only | hooks/hooks.json |
| `migrate-quote-frontmatter.mjs` | frontmatter 引号迁移(一次性) | 手动 |

### 5.2 5 类 markdown 的 frontmatter 强约束

**决策**:每类笔记有固定字段、固定段数、固定引号约定。

**理由**:

- Obsidian Dataview 插件基于 frontmatter 跑查询 → 字段必须稳定
- lint-wiki 才能扫 `missing-meta` / `tag-drift` / `entity-missing-aliases` 等
- LLM 写新笔记时不需要重新决策 → 减少幻觉

**约定摘要**(完整见 [config.md](../../10_schema/config.md)):

- 标量字段必须带双引号(`type` / `created` / `source` / `文章` / `作者` 等)
- 数组字段不加引号(`tags` / `aliases` / `sources`)
- wiki-link 字段不加引号(`source: [[...]]`)
- `状态:` 是 checkbox → bare boolean(`状态: false`,不加引号)

### 5.3 reviewed / 状态 锁

**决策**:entity / concept 页有 `reviewed: true` 锁,机器遇到时跳过正文改写;source 笔记有 `状态: false/true` 控制 ingest 重跑语义。

**理由**:

- 人工 review 后,不希望 LLM 下次 ingest 把人写的 5 段正文覆盖掉
- `reviewed: true` 时,机器**只 append** `sources:` / `aliases:` / `## Mentions in Source`,不触碰正文
- source 笔记 `状态: false` 重跑 ingest 整体覆盖;`状态: true` 走 append-only(见 [config.md §9-bis](../../10_schema/config.md))

### 5.4 Log.md 倒序 + 自动入口

**决策**:`scripts/log-append.mjs` 把 5 个 skill 的写入收口,统一按 `config.md §13.1` 倒序(最新在顶部)格式输出。

**理由**:

- karpathy 原文说 log 是时序的,用 `grep "^## \[" Log.md \| tail -5` 能取最近 5 条 → 倒序就是 tail -5 直接拿
- 5 个 skill 各自收尾必须调,避免「用户没确认 Log 写入就丢记录」
- 双入口(CLI + 函数内嵌):SKILL.md 调 CLI;`scripts/lint-wiki.mjs` 同进程内 `import` `appendLog()`

### 5.5 qmd MCP 可选 + 降级

**决策**:query skill 优先调 qmd MCP server,失败自动降级到 Grep+Read。

**理由**:

- plugin 仓零运行时依赖(不动 README 的「手动装」步骤)
- qmd 未装 / 索引陈旧时,Grep+Read 在中等规模(~100 素材、~几百页)够用
- SKILL.md 阶段 B0 试探调一次 `query`,失败才走 Grep

### 5.6 plugin 升级 + vault 解耦

**决策**:init 时把 4 个 CLI 脚本拷到 vault 根的 `scripts/`(白名单,覆盖写);资产 md 沿用 `copyIfMissing`(保留用户修改)。

**理由**:

- SKILL.md `obsidian-collacting` 调 `node scripts/...` 依赖 cwd=vault 根;scripts 在 vault 里自带自洽
- 脚本是 plugin 行为载体 → plugin 升级必须同步(vault scripts 覆盖)
- 资产 md 是用户内容载体 → 用户可能改过(不覆盖)

### 5.7 SessionStart hook 自动升级

**决策**:`hooks/hooks.json` + `scripts/check-update.mjs` 在 Claude Code 启动时跑 `git pull --ff-only`。

**理由**:

- plugin 通过 marketplace 安装后,本地副本按 version 锁住,用户感知不到升级
- `--ff-only` 防止「本地有改动 + 远端有更新」时的合并冲突
- `async: true` 防止 git fetch 阻塞 session 启动
- 失败全部静默(exit 0),只 stdout 一行警告,LLM 看到会主动告知用户

---

## 6. 资产清单(plugin 端 vs vault 端)

### 6.1 plugin 仓根(交付物)

```
f:\llm-wiki-plugin\
├── .claude-plugin/             # plugin manifest
├── .mcp.json                   # qmd MCP server 声明(可选)
├── .gitignore
├── 00_模板/                    # 5 个模板文件,plugin 行为契约的「前置」约定
│   ├── 读书笔记模板.md          # source 笔记空壳(5 字段 frontmatter + 4 段正文)
│   ├── 标签词表.md             # 4 轴 35 枚举 + entity 7 子类 + concept 7 子类 + 三层互斥规则
│   ├── Log_Spec.md            # Log.md 写入唯一规范(倒序/H2 双空格/反引号路径)
│   ├── Index_Spec.md          # Index.md 写入唯一规范(wiki-link 硬约束 + 表格结构)
│   └── CLAUDE_Template.md     # vault 端 CLAUDE.md 的注入段(begin/end 包裹)
├── 10_schema/
│   └── config.md              # vault 端 Single Source of Truth
├── Inbox/
│   └── web_clipper/README.md  # 拷贝到 vault
├── hooks/
│   └── hooks.json             # SessionStart → check-update.mjs
├── scripts/                    # 7 个 .mjs + 5 个 .test.mjs
├── skills/                     # 5 个 skill
│   ├── llm-wiki-plugin-init/
│   ├── obsidian-collacting/
│   ├── knowledge-graph-sync/
│   ├── llm-wiki-query/
│   └── lint-wiki/
├── reference/                  # karpathy 原文 + 中文版
├── docs/superpowers/specs/     # plugin 端 spec 文档(spec-*.md 扁平命名)
├── CLAUDE.md
└── README.md
```

### 6.2 vault 端(用户机器上,init 之后)

```
<vaultRoot>/
├── 01_知识库/<主题>/           # 原始素材(不可变,人工归档)
├── 02_读书笔记/<主题>/         # source 笔记(LLM 写)
├── 03_问答区/<主题或_cross>/   # qa 笔记(LLM 写,只读型)
├── 11_entities/<slug>.md       # entity 页(LLM 写)
├── 12_concepts/<slug>.md       # concept 页(LLM 写)
├── 00_模板/                    # 从 plugin 拷贝(用户可改,init 不覆盖)
├── 10_schema/                  # 从 plugin 拷贝(config.md)
├── Inbox/
│   ├── .gitkeep
│   └── web_clipper/            # Web Clipper 写入
├── 附件文件夹/                 # Obsidian 附件目录
├── .obsidian/                  # Obsidian 自身配置(init 不创建,首次打开自动生成)
├── scripts/                    # init 时拷入的 4 个 CLI 脚本(覆盖写)
├── Index.md                    # 资料索引表
├── Log.md                      # 操作流水(倒序)
└── CLAUDE.md                   # 用户自维护 + init 注入的 llm-wiki 段
```

---

## 7. 开发与维护约定

### 7.1 spec 命名

- `docs/superpowers/specs/spec-<skill-name>.md` 扁平命名,**无日期前缀**
- 一份 spec 只体现当前最新设计状态,不保留历史;旧版本合并后删除
- 历史演化如果要留,放进独立增量小节(如 `## 增量:xxx`)承接,不另开文件

### 7.2 修改 spec 的流程

1. 改 `docs/superpowers/specs/spec-<skill>.md` 反映最新状态
2. 改 `skills/<name>/SKILL.md` 实施
3. 改 `scripts/<name>.mjs` + `<name>.test.mjs` 实现
4. `node --test scripts/<name>.test.mjs` 全绿
5. 改 `10_schema/config.md` 如果影响 vault 端 schema
6. 改 `README.md` / `CLAUDE.md` 如果影响用户工作流
7. 一次 commit 含所有改动,commit message 用 `feat/fix/docs(scope): 描述` 格式
8. push 到 `origin/main`

### 7.3 新增 skill 的检查清单

- [ ] `skills/<name>/SKILL.md` 有 frontmatter(name / description)+ 触发条件段
- [ ] `docs/superpowers/specs/spec-<name>.md` 存在,写清动机 / 行为契约 / 边界 / 测试
- [ ] 涉及 IO 的部分走 `scripts/<name>.mjs` + 单测
- [ ] 收尾调 `scripts/log-append.mjs`(CLI 或 `import`)
- [ ] vault 端 schema 改动同步到 `10_schema/config.md`
- [ ] README 加 1 行触发词表 + 1 段说明
- [ ] `package.json` 不需要(零运行时依赖)

### 7.4 模板修改纪律(改模板的影响链)

5 个模板文件不是「改了就好」—— 它们的修改会触发下游连锁反应:

| 改哪个模板 | 影响范围 | 必须同步 |
|---|---|---|
| `00_模板/读书笔记模板.md` | vault 端**所有**新建 source 笔记的字段 + 段结构;`scripts/sync-pdf-notes.mjs` 拷贝内容 | 同步改 `10_schema/config.md §2`(source 模板段);同步改 `00_模板/标签词表.md` 引用(若有);init 升级后老 vault 不会自动更新(cpIfMissing 保留用户修改) |
| `00_模板/标签词表.md` | 全部 5 skill 的 sub agent 打标行为;lint-wiki `tag-drift` 检查;`scripts/lint-wiki.mjs` 的枚举校验 | 同步改 `10_schema/config.md §3`(词表段,引用指向本文件);新枚举不需要「回填老笔记」(老笔记的旧 tag 走 lint-wiki 异步捕获) |
| `00_模板/Log_Spec.md` | 5 skill 的 log 条目格式;`scripts/log-append.mjs` 输出格式 | 同步改 `scripts/log-append.mjs`(与 §2 通用格式对齐);新 skill 要加 §3.x 最小条目 |
| `00_模板/Index_Spec.md` | obsidian-collacting / llm-wiki-query 的 index 条目 | 同步改 `obsidian-collacting/SKILL.md` 步骤 9 + `llm-wiki-query/SKILL.md` 阶段 D4 的渲染模板 |
| `00_模板/CLAUDE_Template.md` | vault 端所有 CLAUDE.md 的注入段 | 同步改 `scripts/init-vault.mjs` 的 in-place 替换逻辑(已经是 begin/end 包裹,无需改脚本);老 vault 跑一次 init 自动 in-place 刷新 |

**铁律**:

1. **不维护副本** —— `10_schema/config.md` 已删除模板相关段(指向模板文件);不允许在 config 里再抄一份
2. **改前先看 init 是否能同步** —— `读书笔记模板.md` / `Log_Spec.md` / `Index_Spec.md` / `CLAUDE_Template.md` 都通过 init 的 `copyIfMissing` 部署到 vault,init 升级**不覆盖**(保留用户修改);只有 `CLAUDE_Template.md` 的 begin/end 中间内容走 in-place 刷新
3. **改词表先评估下游** —— 词表新增一个 domain 值,会触发 lint-wiki 把它列入 Vocab Suggestions 的「已补入」桶(下次 lint 不再报),但不会回填老笔记(老笔记保留旧 tag,人工可决定是否改)
4. **改模板必须 commit message 显式标注** —— `docs(00_模板):<改了哪个文件>` + 在 PR description 里写「影响哪些 skill」

---

## 8. 参考

- 思路源头:`reference/llm-wiki.zh.md`(karpathy LLM Wiki 模式中文版)
- vault 端 schema:`10_schema/config.md`
- 5 个模板文件(行为契约前置):
  - [`00_模板/读书笔记模板.md`](../../00_模板/读书笔记模板.md)
  - [`00_模板/标签词表.md`](../../00_模板/标签词表.md)
  - [`00_模板/Log_Spec.md`](../../00_模板/Log_Spec.md)
  - [`00_模板/Index_Spec.md`](../../00_模板/Index_Spec.md)
  - [`00_模板/CLAUDE_Template.md`](../../00_模板/CLAUDE_Template.md)
- 各 skill 详细规范:
  - [spec-init.md](spec-init.md)
  - [spec-obsidian-collacting.md](spec-obsidian-collacting.md)
  - [spec-query.md](spec-query.md)
  - [spec-auto-log-append.md](spec-auto-log-append.md)
  - [spec-check-update.md](spec-check-update.md)
- 待补:`spec-knowledge-graph-sync.md` / `spec-lint-wiki.md`
