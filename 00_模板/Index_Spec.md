# Index.md 资料索引规范（v1 — 已弃用）

> **⚠️ v1 已弃用（2026-08-29）**。新规则见 `docs/superpowers/specs/spec-index-v2.md`
> （plugin 仓内的单一权威源；本文件仅保留给旧 vault 用户对照）。维护方式也变：LLM
> **不再手写** Index.md 行——由 `scripts/sync-index.mjs` 按 `<!-- sync-index:begin v2 -->`
> 标记块原子重写。

---

## v1 → v2 主要差异（迁移须知）

| 维度 | v1（本文档旧版） | v2（spec-index-v2.md） |
|---|---|---|
| 维护者 | LLM 手写 append | `node scripts/sync-index.mjs --all --write` 脚本维护 |
| 路由范围 | `02_读书笔记/` + `03_问答区/` | + `11_entities/` + `12_concepts/`（4 列，Entities/Concepts 固定末尾） |
| 关键概念列 | "正文实际出现的标准名词" 自由文本 | `concepts:` 字段优先，否则 `tags:` fallback，截断 8 个 |
| 包裹方式 | 无（直接表格） | `<!-- sync-index:begin v2 -->` ... `<!-- sync-index:end -->` 标记块 |
| 健康检查 | 无 | `node scripts/lint-wiki.mjs` 报 `index-missing` / `index-ghost` |

## 迁移步骤

1. 在 vault 根手动重命名为（**不要**自己改 v1 表格内容）：
   ```bash
   cd <vaultRoot>
   mv Index.md Index.md.v1.bak
   ```
2. 跑 `node scripts/init-vault.mjs <vaultRoot>`（v2 起 init 会注入 `00_模板/Index_Skeleton.md`
   作为新 `Index.md` 骨架）。
3. 跑 `node scripts/sync-index.mjs --all --write` 全量重建 v2 表格。
4. 跑 `node scripts/lint-wiki.mjs` 验收——若 `index-ghost` 报 `Index.md.v1.bak` 是因为旧表
   wiki-link 在新表找不到（正常，删除 `.bak` 即可）。

## v1 旧规范存档

> 以下仅为历史存档；不再有约束力。

### 文件定位

- `Index.md` 是路由表，**不**是知识图谱节点
- 路由目标：`02_读书笔记/<主题>/<厂商?>/<name>.md` 与 `03_问答区/<主题>/<slug>.md`
- 由 `obsidian-collacting` / `llm-wiki-query` 维护；其他 skill 只读

### 路径格式（硬约束）

- **必须**使用 Obsidian wiki-link：`[[02_读书笔记/...md]]`
- **禁止**用 markdown link `[`<path>`](url)`（URL 含空格 / `&` / 特殊字符时 Obsidian 解析失败）
- **禁止**用反引号纯文本 `` `<path>` ``（LLM 看到反引号路径无 click 入口）

### v1 表格结构（4 列：标题 / 分类 / 关键概念 / 路径）

| 列       | 格式                                          |
| -------- | --------------------------------------------- |
| 标题     | 用 `文章:` frontmatter 字段值                |
| 分类     | 与 `02_读书笔记/<主题>/<厂商?>/` 路径对齐   |
| 关键概念 | 3-8 个小写 slug（自由文本，已废止）            |
| 路径     | wiki-link，参见上文                            |

### v1 触发时机（白名单）

- `obsidian-collacting` 在 `02_读书笔记/` 新建笔记 → append
- `llm-wiki-query` 在 `03_问答区/` 新建问答笔记 → append
- 其他场景（修改既有笔记 / 单纯改 SKILL.md / lint 报告）→ 不触发

### v1 追加协议（已废止）

- 同次会话内 append；不在 Log 之后追补
- 按 §排序规则插入
- 追加失败：本次 commit **不允许**跳过 Index.md append

> v1 后续维护请直接读 [spec-index-v2.md](../../docs/superpowers/specs/spec-index-v2.md)。