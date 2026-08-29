---
name: knowledge-graph-sync
description: knowledge graph、同步反向引用、知识图谱同步
---
# 触发条件

当用户说：knowledge graph / 同步反向引用 / 知识图谱同步

> **手动触发**——不再自动运行。仅在用户明确说上述触发词时跑。

# 这个 skill 做什么

只做**一件事**——**不读 PDF**、**不写新笔记**、**不做归档**：

1. **存量 source 笔记反链补全**：扫描 `02_读书笔记/` 下所有**没有** `## Related Pages` 段的笔记，从内容抽取实体和概念，写入 `11_entities/` `12_concepts/`（如不存在），并为该 source 笔记追加 `## Related Pages` 段

> obsidian-collacting 已处理的笔记末尾有 `## Related Pages` 段，会被自动跳过。

# 不做什么（边界）

- ❌ **不读 PDF**——只读 `02_读书笔记/**/*.md` 已有内容
- ❌ **不写新笔记**——笔记正文（摘要/重点摘录/我的思考）由 `obsidian-collacting` 技能负责
- ❌ **不修改 frontmatter** 的 `source` / `tags` / `状态` 字段
- ❌ **不启动 sub agent**——只读 md 文件，主对话直接处理
- ❌ **不动 `01_知识库/`** 的归档
- ❌ **不手写 `Index.md`**——见 Phase 6 强制步骤，由 `sync-index.mjs` 维护（spec-index-v2 §7）
- ❌ **不修改 reviewed: true 的 entity/concept 页**——仅 append `sources:` 与 Mentions

# 工作流

## Phase 1：扫描存量 source 笔记

列出 `02_读书笔记/**/*.md`，**只处理末尾没有 `## Related Pages` 段的**。entity/concept 模板与子类枚举按 `10_schema/config.md §4/§5` + `00_模板/标签词表.md §3/§4`。

## Phase 2：抽取实体和概念

主对话直接处理（不启动 sub agent）。对每篇待处理笔记：

1. 读全文（frontmatter + 4 段正文）
2. 抽取实体（按词表 §3 子类枚举）：person / organization / project / product / event / place / other
3. 抽取概念（按词表 §4 子类枚举）：theory / method / field / phenomenon / standard / term / other
4. 去重（同笔记多提 = 一份 entity/concept 页）

## Phase 3：写 / 追加 entity/concept 页

对每个抽取的实体/概念：

1. 不存在 → 按 config §4 / §5 模板新建；frontmatter `reviewed:` 留空（保持缺失 = 机器可改正文）；`tags:` 从词表 §3 / §4 选
2. 存在 + `reviewed: true` → 只 append `sources:` + `## Mentions in Source` 段。**必须用 Edit 工具读后修改，禁止 Write 全量覆盖**——保证最小变更与 idempotency
3. 存在 + `reviewed` 缺失或 `reviewed: false` → 直接 Edit 5/6 段正文（LLM 重写 + 补充），append `sources:` / `aliases:` / `## Mentions in Source`，**不动 `reviewed` 字段**

verbatim 引用规则（config §10）：

- 原 PDF 原文片段，**不翻译、不意译**
- 每条引用必须带 source wiki-link

## Phase 4：source 笔记追加 `## Related Pages` 段

为每篇待处理 source 笔记追加：

```markdown
## Related Pages

### Entities
- [[11_entities/<entity-slug-1|Display]]
- [[11_entities/<entity-slug-2|Display]]

### Concepts
- [[12_concepts/<concept-slug-1|Display]]
```

只有实体没概念时省略 Concepts 子标题，反之亦然。

## Phase 5：报告

完成后告诉用户：

1. 扫描了多少篇存量笔记
2. 处理了多少篇（追加 `## Related Pages` 段）
3. 跳过多少篇（已有 `## Related Pages` 段）
4. 新建 / 追加了多少 entity/concept 页
5. 是否有存量笔记未归入任何实体/概念（人工 review）

## Phase 6：强制步骤 — 同步 Index.md

新增 / 删除 entity/concept 页后，Index.md 路由表会过期。**严禁 LLM 手写** Index.md 行（spec-index-v2 §7）。正确路径：

```bash
cd <vaultRoot> && node scripts/sync-index.mjs --all --write
```

脚本会按 `<!-- sync-index:begin v2 --> ... <!-- sync-index:end -->` 标记块原子重写 Index.md，
Entities / Concepts 段（11_entities + 12_concepts）会按字母序同步。

完成后调 `node scripts/lint-wiki.mjs` 验收——无 `index-ghost` / `index-missing` 报错即与磁盘一致。

## Phase 7：强制步骤 — 追加 Log

在仓库根 `Log.md` 末尾 append 本次操作的 Log 条目（必须、与主任务同次 commit 完成）。格式严格按 `00_模板/Log_Spec.md §3` 要求。

# 注意事项

- 严格遵循"最小变更"——不修改 frontmatter 字段、不改写正文
- 反向引用的 Wiki 链接必须是**已存在的笔记**（不要凭空写链接）
- 触发后**先报告扫描结果**，再执行写入——给用户一次撤销机会