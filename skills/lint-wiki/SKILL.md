---
name: lint-wiki
description: lint、healthcheck、检查 vault、检查笔记、扫一遍、看下笔记健康度、跑一下 lint
---

# 触发条件

当用户说：lint、healthcheck、检查 vault、检查笔记、扫一遍、看下笔记健康度、跑一下 lint

# 这个 skill 做什么

**只读不写**——扫描 `02_读书笔记/` + `11_entities/` + `12_concepts/`，输出 14 类健康问题 + 1 节 **Vocab Suggestions（词表补全建议）** 到 `scripts/_lint-report.md`：

### source 笔记（02_读书笔记/，6 类）

| 检查 | 含义 |
|---|---|
| `missing-meta` | frontmatter 缺 `tags` 或 `source` 字段 |
| `orphan` | 无任何 `[[wiki 链接]]` 入向引用，**且**出向 < 3（叶节点阈值放宽） |
| `stale` | `状态: false` 且 `创建时间` > 阈值天数（默认 90） |
| `tag-drift` | `tags` 不在 `00_模板/标签词表.md` §2 词表枚举内 |
| `duplicate` | 相同 frontmatter.文章 + 路径不唯一 |
| `contradictions` | 笔记末尾出现 `## Contradictions` 段（多轮 ingest 冲突未消解） |

### entity 页（11_entities/，3 类）

| 检查 | 含义 |
|---|---|
| `entity-missing-aliases` | frontmatter 缺 `aliases` 或为空（必填 ≥ 1） |
| `entity-tag-drift` | tags 不在词表 §3 entity 子类枚举（7 个） |
| `entity-name-clash` | 同目录 normalize（去空格/连字符/下划线）后同名 |

### concept 页（12_concepts/，3 类）

| 检查 | 含义 |
|---|---|
| `concept-missing-aliases` | frontmatter 缺 `aliases` 或为空 |
| `concept-tag-drift` | tags 不在词表 §4 concept 子类枚举（7 个） |
| `concept-name-clash` | 同目录 normalize 后同名 |

### 跨目录 / 共享（2 类）

| 检查 | 含义 |
|---|---|
| `entity-cross-dir-dup` | entity 与 concept 跨目录 normalize 同名（语义冲突） |
| `sources-too-many` | entity / concept 的 `sources.length` ≥ 50（warning，建议合并） |

### 词表补全建议（1 节）

`## Vocab Suggestions` 报告节：从 `tag-drift` / `entity-tag-drift` / `concept-tag-drift` 三类问题归桶出**词表外 tag 候选**，提示哪些值可补到 `00_模板/标签词表.md`。

| 桶 | 来源 | 含义 |
|---|---|---|
| `§2 domain` / `layer` / `phase` / `maturity` | source 笔记 `tag-drift` 含 axis 前缀 | 该 axis 漏枚举值 |
| `§3 entity` | `entity-tag-drift` | entity 子类漏枚举值 |
| `§4 concept` | `concept-tag-drift` | concept 子类漏枚举值 |
| `待分类` | source 笔记 `tag-drift` 不含 axis 前缀 | 用户漏写 axis 前缀，需人工 review |

**仅报告，不入词表**——用户手动改 `00_模板/标签词表.md` 决定是否补枚举。ponytail：纯 grep 归桶，无 LLM；覆盖 80% 情况，剩 20% 落入"待分类"由人工决断。

# 不做什么（边界）

- ❌ 不修改任何笔记
- ❌ 不读 PDF（只读 md frontmatter + body 文本）
- ❌ 不更新 Index.md / Log.md
- ❌ 不删任何文件
- ❌ 不动 01_知识库/
- ❌ **不检查 entity-orphan / concept-orphan**：sources: 非必填字段（myconfig §4/§5），新建页必然为空，列入会全员误报

# 工作流

## Phase 1：执行

```bash
node scripts/lint-wiki.mjs [--stale-days=90] [--out=scripts/_lint-report.md]
```

退出码：
- `0` = 无问题
- `1` = 发现问题
- `2` = 脚本本身异常

## Phase 2：阅读报告

打开 `scripts/_lint-report.md`，按以下优先级处理：

1. **tag-drift / entity-tag-drift / concept-tag-drift**：最高优先级，破坏词表一致性。手动补 tag 或建议入表
2. **Vocab Suggestions**：报告节中"待分类"之外的桶 → 手动把候选补入 `00_模板/标签词表.md` 对应 §2/§3/§4。"待分类"桶需要先看来源文件、确认该写哪个 axis 再补
3. **name-clash / cross-dir-dup**：合并候选，先 normalize 再去重
4. **duplicate**：合并候选，路径不同但 `文章` 相同
5. **missing-meta / missing-aliases**：补 frontmatter
6. **orphan**：写反向引用 / 入 Index.md 让它被发现
7. **stale**：复审，更新状态或删除
8. **contradictions**：人工 review 双侧来源，决定保留或删除
9. **sources-too-many**：warning 量级，提示合并 source 列表

## Phase 3：Log 摘要（必做）

`obsidian-collacting` 不再自动调本 skill——3 skill 互不调用。本 skill 跑完后：

- **主对话必须在同次 commit 内 append `Log.md` 一条诊断摘要**（硬性约束见 `10_schema/myconfig.md` §3）
- 摘要至少含：扫描时间、扫描笔记数、问题总数、报告路径 `scripts/_lint-report.md`、5 类问题分项数
- 格式严格按 `10_schema/myconfig.md` §13.3 lint-wiki 最小条目
- 本 skill 仍只读 vault 笔记——**扩可写 vault 能力是独立工单**，与本规范无关

# 注意事项

- 退出码非 0 **不阻塞**主对话——只输出报告供你判断
- 词表文件不存在时跳过 `tag-drift` 检查（容错）
- 单笔记无入向且无出向**必报 orphan**（这是真实问题）

# 维护

- 脚本：`scripts/lint-wiki.mjs`（纯函数 + CLI 入口，含 `buildVocabSuggestions` 词表归桶）
- 测试：`scripts/lint-wiki.test.mjs`（82 个测试）
- 改动前必跑：`node --test scripts/lint-wiki.test.mjs`