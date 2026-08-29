# Index.md v2 规范 + sync-index.mjs 设计（终稿）

> 修订版。本 spec 是仓库根 `Index.md` 与配套脚本 `scripts/sync-index.mjs` 的单一权威来源。
>
> 关联：
> - 取代 [00_模板/Index_Spec.md](../../../00_模板/Index_Spec.md) v1（**保留为 deprecated 引用，本 spec 定稿后归档**）
> - 遵循 [reference/llm-wiki.md §"Indexing and logging"](../../../reference/llm-wiki.md)（Karpathy 原版）
> - 配套脚本 [scripts/init-vault.mjs](../../../scripts/init-vault.mjs)（创建 Index.md 占位）
> - 配套脚本 [scripts/lint-wiki.mjs](../../../scripts/lint-wiki.mjs)（orphan / index-missing / index-ghost 检查升级）
> - 被引用方：[skills/obsidian-collacting/SKILL.md](../../../skills/obsidian-collacting/SKILL.md) §9、[skills/llm-wiki-query/SKILL.md](../../../skills/llm-wiki-query/SKILL.md) §D4、[skills/knowledge-graph-sync/SKILL.md](../../../skills/knowledge-graph-sync/SKILL.md) §Phase 5、[skills/lint-wiki/SKILL.md](../../../skills/lint-wiki/SKILL.md) §6

---

## 1. 背景与动机

### 1.1 现状（v1）的 3 个问题

| # | 问题 | 后果 |
|---|------|------|
| 1 | entities / concepts 不进 Index.md | 违反 Karpathy "catalog of **everything** in the wiki"；LLM 查 query 必须再 grep `11/` `12/`，违反"LLM 优先读此区"承诺 |
| 2 | LLM 自审写表格 | 漏 append、字段填错无 enforcement |
| 3 | "关键概念"列数据来源不明确（spec 写 slug，实战填长摘要） | 脚本无法确定性渲染；LLM 写表格时语义漂移 |

### 1.2 v2 目标

按 Karpathy 原版 §"Indexing and logging"：

1. **Index.md 是 wiki 全集目录**——包含 source（02/03）+ entities（11）+ concepts（12）
2. **按 category 组织**——entities / concepts / sources 是 Karpathy 原文分类
3. **每次 ingest 都更新**——由 `sync-index.mjs` 强制执行
4. **LLM 先读 index 再钻页**——Index.md 是查询入口

---

## 2. 文件定位（继承 v1 §1）

- `Index.md` 是路由表，**不**是知识图谱节点
- 路由目标（全集）：
  - `02_读书笔记/<主题>/<厂商?>/<name>.md`（source 笔记）
  - `03_问答区/<主题>/<slug>.md`（Q 笔记）
  - `11_entities/<slug>.md`（实体页）
  - `12_concepts/<slug>.md`（概念页）
- 由 `node scripts/sync-index.mjs` 维护；其他 skill **只读 + 触发**脚本
- LLM 优先读此区（与 v1 §1 一致）

---

## 3. 路径格式（继承 v1 §2，不变）

- **必须**使用 Obsidian wiki-link：`[[02_读书笔记/...md]]`
- **禁止** markdown link `[text](url)`（URL 含空格 / `&` / 特殊字符时 Obsidian 解析失败）
- **禁止** 反引号纯文本：`` `path` ``
- 文件名带空格 / `&` / 中文时 wiki-link 鲁棒，照写不转义
- **保留 `.md` 后缀**（与 Index_Spec.md §3 行 33 一致）

---

## 4. 表格结构（v2 主要变更点）

### 4.1 列定义（4 列固定）

| 列 | 格式 | 数据来源 | 必填 |
|----|------|---------|------|
| **标题** | `<文章标题>` | frontmatter `文章:`（02/03）/`title:`（11/12）| ✅ |
| **分类** | `<主题>` / `<主题>/<厂商>` / `entity` / `concept` | 路径前缀（02/03 取主题目录；11 固定 `entity`；12 固定 `concept`）| ✅ |
| **关键概念** | `概念 1 / 概念 2 / ...`（3-8 个，逗号或`/`分隔）| frontmatter `tags:`（合并 4 轴为单一字符串列）| ⚠️ 缺则写 `—` |
| **路径** | `[[...md]]` | 实际文件路径 | ✅ |

### 4.2 与 v1 的对比

| 列 | v1 | v2 | 变更原因 |
|----|----|----|---------|
| 标题 | ✅ | ✅ | 不变 |
| 分类 | ✅ | ✅ | 不变；新增 `entity` / `concept` 取值 |
| 关键概念 | ✅ slug | ✅ **frontmatter tags 合并** | 解决 spec 与实战漂移；数据确定性可脚本化 |
| 路径 | ✅ | ✅ | 不变 |

### 4.3 "关键概念"列渲染规则（v2 明确）

```ts
// pseudocode
function renderConcepts(frontmatter): string {
  const tags = frontmatter.tags ?? []              // 02 笔记的 4 轴 tags
  const own  = frontmatter['关键概念'] ?? frontmatter.concepts ?? []  // 11/12 自己的概念 slug
  const merged = [...new Set([...tags, ...own])]
                 .slice(0, 8)
  return merged.length === 0
    ? '—'
    : merged.join(' / ')
}
```

- 优先级：frontmatter 显式 `关键概念:` / `concepts:` 字段（11/12 已审页用）> `tags:` 合并（02/03 自动入库）
- 截断到 8 个
- 单 slug 用原样，多个用 ` / ` 分隔
- 含 `|` 的 slug 转义为 `\\|`

---

## 5. 双层结构（v2 核心设计）

### 5.1 Index.md 整体结构

```markdown
# 资料索引
> LLM 优先读此区。本表路由到 vault 内全部 wiki 页面，由 `node scripts/sync-index.mjs` 维护。
> 路径列统一使用 Obsidian wiki-link 格式 `[[...md]]`。

<!-- sync-index:begin v2 -->

## AI                       ← 第一级：主题目录（按 02_读书笔记/<主题> 提取）
| 标题 | 分类 | 关键概念 | 路径 |
| ... | ... | ... | ... |

## 芯片
| 标题 | 分类 | 关键概念 | 路径 |
| ... | ... | ... | ... |

## Entities                ← 第二级：entities 全集（按字母序）
| 标题 | 分类 | 关键概念 | 路径 |
| ... | entity | ... | ... |

## Concepts                ← 第二级：concepts 全集（按字母序）
| 标题 | 分类 | 关键概念 | 路径 |
| ... | concept | ... | ... |

<!-- sync-index:end -->
```

### 5.2 分组规则

| 段 | 路径来源 | 排序 |
|----|---------|------|
| `## <主题>` | `02_读书笔记/<主题>/` 与 `03_问答区/<主题>/` | 主题目录字母序 |
| `## Entities` | `11_entities/` | 标题（`title:` 字段）字母序 |
| `## Concepts` | `12_concepts/` | 标题（`title:` 字段）字母序 |

- `## Entities` / `## Concepts` 固定在 Index.md 末尾
- 同一主题段内**不分子段**（note / concept 不再细分）——表格列"分类"已含 type 信息
- 同段内按 frontmatter `文章:` / `title:` 字母序（CJK 用 `localeCompare` `zh-Hans-CN`）

### 5.3 Entities / Concepts 段示例

```markdown
## Entities

| 标题 | 分类 | 关键概念 | 路径 |
| --- | --- | --- | --- |
| Andrew Ng | entity | DeepLearning.AI / 斯坦福 / Coursera | [[11_entities/andrew-ng.md]] |
| Apple Inc. | entity | FAANG / iPhone / M-series | [[11_entities/apple-inc.md]] |

## Concepts

| 标题 | 分类 | 关键概念 | 路径 |
| --- | --- | --- | --- |
| Attention | concept | 自注意力 / scaled dot-product / 序列加权 | [[12_concepts/attention.md]] |
| Transformer | concept | encoder-decoder / attention / 2017 | [[12_concepts/transformer.md]] |
```

---

## 6. 排序规则（v2 修订）

1. 主题段（`## AI` `## 芯片` ...）按主题目录字母序
2. 同主题段内按 frontmatter `文章:` 字母序（zh-Hans-CN locale）
3. `## Entities` / `## Concepts` 固定在所有主题段之后
4. Entities / Concepts 段内按 frontmatter `title:` 字母序（zh-Hans-CN locale）

---

## 7. 触发时机（v2 修订）

### 7.1 必须调用 `node scripts/sync-index.mjs` 的时机

| 动作 | 路径变化 | 调用方式 |
|------|---------|---------|
| `obsidian-collacting` 新建 `02_读书笔记/` 笔记 | 新增 | `--add <vault-rel-path>` 或全量 `--all` |
| `obsidian-collacting` 删除 `02_读书笔记/` 笔记 | 删除 | `--remove <path>` 或全量 `--all` |
| `obsidian-collacting` 移动 `01_知识库/` 文件 | 重命名 | `--all`（路径前缀变了） |
| `llm-wiki-query` 新建 `03_问答区/` Q 笔记 | 新增 | `--add <path>` |
| `knowledge-graph-sync` 新建 / 删除 entity/concept 页 | 增删 | `--add` / `--remove` / `--all` |
| 手动 frontmatter `文章:` / `tags:` 修订 | 字段更新 | 全量 `--all` |

### 7.2 **不**触发 sync-index 的时机

- 单纯修改 4 skill 自身的 `SKILL.md`
- `scripts/*.mjs` / `scripts/_lint-report.md` 改动
- `Index.md` 自身更新（D4 产物）
- 人工纯翻 `状态:` false → true
- `llm-wiki-query` 未触发归档（无 Q 命中）
- **修改既有笔记但路径与 frontmatter `文章:` / `tags:` 均不变**（lint-wiki 体检类操作）

### 7.3 调用约定

- **不允许** LLM 手动写 Index.md 表格行
- SKILL.md 内出现"更新 Index.md"的指令 → 改为"调用 `node scripts/sync-index.mjs --all`"
- 写盘前给用户展示 diff（`--dry-run` 默认开）
- 在 commit message 里记录：`node scripts/sync-index.mjs --all` 或 `--add/--remove <paths>`

---

## 8. `scripts/sync-index.mjs` 脚本设计

### 8.1 CLI 接口

```bash
# 全量重建（默认 dry-run）
node scripts/sync-index.mjs --all [--write]

# 单文件增量
node scripts/sync-index.mjs --add <vault-rel-path>
node scripts/sync-index.mjs --remove <vault-rel-path>

# 校验一致性（不写盘，输出 diff；exit 1 表示不一致）
node scripts/sync-index.mjs --check

# 公共参数
--vault-root <path>      # 默认 cwd
--plugin-root <path>     # 默认 cwd 的父目录
--json                   # 输出 JSON 报告而非人类可读
--write                  # 实际写盘（默认 dry-run）
--no-color
```

### 8.2 算法

```
parseArgs(args) → { mode, paths, write, ... }

ensureVaultRoot(vaultRoot)

loadIndexMd(vaultRoot) → { header, syncBlock, footer }

switch mode:
  case 'all':
    currentFiles = scanAll(vaultRoot)  // 02/03/11/12 全扫
  case 'add':
    currentFiles = new Map([[path, read(path)]])
  case 'remove':
    currentFiles = new Map()
  case 'check':
    expected = render(scanAll(vaultRoot))
    diff(actual, expected)
    exit 0/1

// 行级 merge
newRows = rowsFromSyncBlock(syncBlock)
for each file in currentFiles:
  if path in newRows: update row
  else: append row
for each removedPath: delete row from newRows

// 排序
groupByCategory(newRows)         // 主题段 + 末尾 Entities/Concepts
sortWithinGroup(newRows)

// 渲染
newBlock = renderSyncBlock(newRows)

// 标记块包裹法
newContent = header + newBlock + footer

if --write: atomic write (.tmp + rename)
else:        print unified diff to stdout
```

### 8.3 渲染规则（行模板）

```markdown
| <title> | <category> | <concepts> | [[<path>]] |
```

- `<title>` 不转义，原样（中文 / 空格 / `&` 直接写）
- `<category>` 取主题目录（02/03）或 `entity`（11）/ `concept`（12）
- `<concepts>` 来自 §4.3 合并逻辑；缺失填 `—`
- `<path>` 保留 `.md` 后缀（§3 硬约束）
- 含 `|` 转义为 `\\|`

### 8.4 标记块包裹法

```markdown
<!-- sync-index:begin v2 -->
（脚本生成的所有 ## 段）
<!-- sync-index:end -->
```

- 标记块**外**的 `# 资料索引` 标题、引用块、用户手工段（如 `## Favorites`）**保留**
- 脚本只重渲染 begin/end 之间的内容
- `init-vault.mjs` 创建 Index.md 时写入完整骨架（含空 begin/end 标记块）
- 用户手工段（标记块外的 `## Favorites` 之类）必须放在 `<!-- sync-index:end -->` **之后**

### 8.5 边界与豁免

| 边界 | 处理 |
|------|------|
| frontmatter 解析失败 | warn（不抛），跳过该文件 |
| `tags:` 含 `\|` | 转义为 `\\|` |
| 文件名含空格 / `&` / 中文 | wiki-link 直接写 |
| `Index.md` 自身 | 不出现在扫描列表 |
| `_draft/` / `.trash/` / `Inbox/` 等 | 白名单路径前缀过滤 |
| 同一文件被多个 `--add` 指定 | 幂等 dedupe by path |
| 文件 frontmatter `tags:` 缺失 | 关键概念列填 `—` |
| 文件 frontmatter `文章:` / `title:` 缺失 | 关键概念列填文件名（去 `.md`）|

### 8.6 幂等与原子写

- 标记块包裹法（§8.4）保证幂等
- 原子写：`writeFile(tmpPath)` → `rename(tmpPath, IndexPath)`
- 写盘前对比新旧 hash，相同则跳过实际 IO（节省 fs 操作）

### 8.7 错误码

| exitCode | 含义 |
|----------|------|
| 0 | 成功 / check 通过 / dry-run |
| 1 | --check 发现差异 |
| 2 | vaultRoot 缺失 / 不是目录 |
| 3 | 模板 / 资产缺失 |
| 4 | IO 失败（权限 / ENOSPC） |

### 8.8 与 init-vault.mjs 的协作

`init-vault.mjs` 第 4 步改为拷贝 `00_模板/Index_Skeleton.md` 到 vault `Index.md`，内容：

```markdown
# 资料索引
> LLM 优先读此区。本表路由到 vault 内全部 wiki 页面，由 `node scripts/sync-index.mjs` 维护。
> 路径列统一使用 Obsidian wiki-link 格式 `[[...md]]`，**不要**用 markdown link `[text](url)` 或反引号纯文本。

<!-- sync-index:begin v2 -->
<!-- sync-index:end -->
```

init-vault 改动最小：assetMap 加一行 `['00_模板/Index_Skeleton.md', 'Index.md']`。

---

## 9. 修改既有文件清单

| 文件 | 修改类型 | 依赖 |
|------|---------|------|
| `00_模板/Index_Spec.md` | **被本 spec 取代**（保留文件作为 deprecated 引用，顶部加 deprecation 块指回本 spec） | 本 spec 定稿后 |
| `00_模板/Index_Skeleton.md` | **新增**（init 资产） | §8.4 §8.8 |
| `scripts/sync-index.mjs` | **新增** | §8 |
| `scripts/sync-index.test.mjs` | **新增** | TDD 要求（§10） |
| `scripts/init-vault.mjs` | **改 2 行**：assetMap 加 `Index_Skeleton.md` | §8.8 |
| `scripts/lint-wiki.mjs` | 新增 2 类问题（`index-missing` / `index-ghost`） | §11 |
| `skills/obsidian-collacting/SKILL.md` | §9 改为调脚本 | §7 |
| `skills/llm-wiki-query/SKILL.md` | §D4 改为调脚本 | §7 |
| `skills/knowledge-graph-sync/SKILL.md` | Phase 5 报告加 "Index.md N 条 → 由 sync-index.mjs 写入" | §7 |
| `skills/lint-wiki/SKILL.md` | §6 orphan 检查升级为校验 Index.md 收录 | §11 |
| `00_模板/Log_Spec.md` | §3.1 改动范围字段：移除手工 "Index.md 追加 N 条"（改由 sync-index 报告） | §7 |
| `00_模板/CLAUDE_Template.md` | 铁律 #2 加注："Index.md 仅 sync-index.mjs 写" | §7 |
| `10_schema/config.md` | §1 Wiki Structure 表格加"Index.md 由 sync-index.mjs 维护" | §2 |
| `docs/superpowers/plans/YYYY-MM-DD-index-v2.md` | **新增**：实施 plan，按 commit 拆分 | 后续 |

---

## 10. 测试用例（MVP 必跑）

| # | 场景 | 断言 |
|---|------|------|
| 1 | 空 vault → `--all --write` | 生成带标记块的 Index.md，表体为空 |
| 2 | 单文件 `--add 02_读书笔记/AI/transformer.md` | 该文件以 1 行形式出现在 `## AI` 段 |
| 3 | `--remove` 已存在文件 | 对应行消失 |
| 4 | `--all` 后再 `--all`（幂等） | 文件无修改（mtime 不变 / 内容 hash 不变） |
| 5 | frontmatter 缺 `tags:` | 该行关键概念列显示 `—` |
| 6 | frontmatter 缺 `文章:` | 该行标题列显示文件名（去 `.md`） |
| 7 | frontmatter `tags:` 含 `\|` | 渲染时转义为 `\\|`，Obsidian 解析无歧义 |
| 8 | 文件名含空格 / `&` / 中文 | wiki-link 直接写 |
| 9 | 11_entities 文件单独成 `## Entities` 段 | 末尾段，不参与主题目录分组 |
| 10 | 12_concepts 文件单独成 `## Concepts` 段 | 末尾段 |
| 11 | 排序：同主题段内按 `文章:` zh-Hans-CN locale | 断言行顺序 |
| 12 | Entities / Concepts 段内按 `title:` zh-Hans-CN locale | 断言行顺序 |
| 13 | 用户在 `<!-- sync-index:end -->` 后加 `## Favorites` 段 | `--all --write` 后该段保留 |
| 14 | `--check` 与磁盘一致 | exit 0，stdout 空 |
| 15 | `--check` 与磁盘不一致（用户手工改了一行） | exit 1，stdout 输出 diff |
| 16 | frontmatter 解析失败 | warn 到 stderr，跳过该文件，其它正常处理 |
| 17 | 文件路径越界（含 `..`） | refuse，不写盘 |
| 18 | 原子写：模拟写一半中断 | 旧 Index.md 完整保留 |
| 19 | 多文件一次 `--add a.md b.md c.md` | 三行都出现在对应段 |
| 20 | Entities / Concepts 段放在所有主题段**之后** | 断言段顺序 |

---

## 11. lint-wiki 升级

新增 2 类问题：

| 问题 ID | 检测内容 | 严重级别 |
|---------|---------|---------|
| `index-missing` | `02_读书笔记/` / `03_问答区/` / `11_entities/` / `12_concepts/` 下文件未在 Index.md 出现 | warn |
| `index-ghost` | Index.md 表格中的 `[[...]]` 路径在磁盘不存在 | error |

实现思路：在 [scripts/lint-wiki.mjs](../../../scripts/lint-wiki.mjs) 中复用 [scripts/sync-index.mjs](../../../scripts/sync-index.mjs) 的 scan + render 函数，对比输出 diff。

---

## 12. 不做什么（YAGNI 边界）

- ❌ **不做** LLM 自动生成 `description:` 字段——v2 沿用现有 frontmatter，不引入新必填字段
- ❌ **不做** 增量 diff（不维护 `.sync-index-cache.json`）——每次 `--all` 全量扫，规模小（~几百页）足够快
- ❌ **不做** 实时 file watcher——LLM/skill 显式触发即可
- ❌ **不做** Dataview 集成——Obsidian 插件层职责，与本脚本无关
- ❌ **不做** 跨 vault 合并——单 vault 自治
- ❌ **不做** Markdown link 反向兜底——v1 §2 已禁止
- ❌ **不做** Wikipedia / 远端索引同步——纯本地
- ❌ **不**修改 `Index.md` 标记块**外**的任何内容（包括 `# 资料索引` 标题、引用块、`## Favorites` 等用户段）
- ❌ **不**强制 tags / `文章:` 字段必填——缺失就显示 `—` 或文件名兜底
- ❌ **不**做 entity/concept 自动去重——`## Entities` / `## Concepts` 段允许同 title 多 slug 共存

---

## 13. 验收清单（doD）

- [ ] §10 全部 20 个测试用例通过
- [ ] `node scripts/sync-index.mjs --check` 在示例 vault（你当前 `F:\zhigangliu_lib\mynotes`）上 exit 0
- [ ] 真实 vault 跑一次 `--all --write` 后 Index.md 包含 entities / concepts 段
- [ ] `node scripts/lint-wiki.mjs` 新增 2 类问题（index-missing / index-ghost）有覆盖测试
- [ ] 4 个 skill 的 SKILL.md 已更新为"调脚本"措辞
- [ ] `00_模板/Index_Skeleton.md` 资产已拷贝到 vault `Index.md`
- [ ] 一份 plan 文档（`YYYY-MM-DD-index-v2.md`）说明本次改动按 commit 拆分
- [ ] 跑一遍 [CLAUDE.md](../../../CLAUDE.md) 要求的"写代码前测试用例先写完"——`scripts/sync-index.test.mjs` 必须先于 `scripts/sync-index.mjs` 提交