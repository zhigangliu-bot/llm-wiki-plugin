# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# 仓库性质

Claude Code **plugin 仓**（不是 marketplace 注册表）。本仓提供 4 个核心 skill（`knowledge-graph-sync` / `lint-wiki` / `obsidian-collacting` / `llm-wiki-query`）+ 1 个 init skill（`llm-wiki-plugin-init`）+ 4 个 Node.js 脚本 + 1 个 SessionStart hook。所有资产自包含、随 plugin 一起分发，vault 用户无需单独下载。

## 跟 marketplace 仓的关系

本仓在 [zhigangliu-bot/myself-marketplace](https://github.com/zhigangliu-bot/myself-marketplace) 的 `marketplace.json` 里以 `source.repo` 引用。改本仓 = 直接影响 marketplace 安装的 plugin。

## SessionStart hook 行为

`hooks/hooks.json` 注册了 `SessionStart:startup` 匹配器，触发 `node scripts/check-update.mjs`。该 hook:
- 异步执行（`async: true`），**永不阻塞** session start
- 跑 `git pull --ff-only` 拉本仓最新版本
- 退出码永远 0（失败兜底 = warning + exit 0）
- 有更新会打 `✓ llm-wiki-plugin updated: aaaa..bbbb`，Claude 在下次对话里 surface 出来

详见 [docs/superpowers/specs/2026-08-23-session-start-update-check-design.md](docs/superpowers/specs/2026-08-23-session-start-update-check-design.md)。

# 关键命令

## 测试

```bash
# 跑单个脚本的测试
node --test scripts/lint-wiki.test.mjs
node --test scripts/check-update.test.mjs
node --test scripts/init-vault.test.mjs
node --test scripts/sync-pdf-notes.test.mjs

# 跑全部测试
node --test scripts/*.test.mjs
```

## Lint

无独立 lint 流水线——脚本里的代码靠单元测试 + 头注释里的契约保证。改脚本前必跑对应 `.test.mjs`。

## 手动跑（开发期）

```bash
# lint-wiki（用户视角跑法）
node scripts/lint-wiki.mjs [--stale-days=90] [--out=scripts/_lint-report.md] [--vault=<vaultRoot>]

# sync-pdf-notes（obsidian-collacting 阶段 2 用）
node scripts/sync-pdf-notes.mjs --overwrite=false --source-field=source

# check-update（模拟 hook 跑）
node scripts/check-update.mjs

# init-vault（llm-wiki-plugin-init skill 用）
node scripts/init-vault.mjs --vault=<vaultRoot>
```

## 提交 / 推送

```bash
git add -p                    # 必加 -p，单文件改动走单文件提交
git commit -m "feat(<scope>): <中文一句话>"
git push origin main
```

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com> 由 Claude 自动追加。

# 架构（big picture）

## 五 skill 协作模型

```
                  ┌─────────────────────────────────┐
                  │   Inbox/ (PDF + web_clipper md) │
                  └────────────────┬────────────────┘
                                   │
                                   ▼
            ┌──────────────────────────────────────────┐
            │  obsidian-collacting                     │
            │  • 扫描 + 归档到 01_知识库/<主题>/       │
            │  • sync-pdf-notes.mjs 生成 02_读书笔记/  │
            │  • 阶段 2 sub agent 写阅读笔记           │
            │  • 阶段 3 sub agent 抽 entity/concept    │
            │  • ★ 新：词表更新建议（强信号判定）      │
            └──────────┬───────────────────────────────┘
                       │ 写 vault 笔记
                       ▼
       ┌─────────────────────────────────────┐
       │ 02_读书笔记/ + 11_entities/ + 12_concepts/ │
       └──────┬─────────────────────────┬──────┘
              │                         │
              ▼                         ▼
   ┌────────────────────┐    ┌──────────────────────────┐
   │ lint-wiki          │    │ knowledge-graph-sync      │
   │ • 只读 vault       │    │ • 只补 ## Related Pages   │
   │ • 15 类健康检查     │    │ • 不读 PDF / 不写正文     │
   │ • 写 _lint-report  │    │ • 处理 obsidian-collacting │
   │ • Vocab Suggestions│    │   漏的反向引用             │
   └────────────────────┘    └──────────────────────────┘
       ┌─────────────────────────────────────────┐
       │ 02_读书笔记/ + 11_entities/ + 12_concepts/ + 01_知识库/ │
       └────────────────┬────────────────────────┘
                        │ 朴素 Grep 召回（按 vault 优先级）
                        ▼
       ┌─────────────────────────────────────┐
       │  llm-wiki-query                       │
       │  • 显式触发（4 个触发词）             │
       │  • SessionStart 注入路径决策          │
       │  • 多 anchor Grep / qmd (按 effective │
       │    _path) + Read 深读                 │
       │  • Q1-Q5 自检 → 仅作「建议归档」提示  │
       │  • 用户明示「归档」后才写 03_问答区/  │
       └──────────┬───────────────────────────┘
                  │ 写 vault（仅好答案）
                  ▼
       ┌─────────────────────────────────────┐
       │ 03_问答区/ + Log.md §3.4 llm-wiki-query 归档 │
       └─────────────────────────────────────┘
```

**互斥规则**：`## Related Pages` 段由 obsidian-collacting 自动处理 ingest 笔记，kg-sync 只补存量旧笔记。llm-wiki-query 与 obsidian-collacting / lint-wiki / knowledge-graph-sync 互不调用。

## 资产分层（plugin 自包含）

| 资产 | 用途 | 谁读 |
|---|---|---|
| `00_模板/标签词表.md` | 4 轴（§2）+ entity 子类（§3）+ concept 子类（§4）的 single source of truth | obsidian-collacting / lint-wiki / kg-sync |
| `00_模板/读书笔记模板.md` | 02_读书笔记/ frontmatter + 4 段正文模板 | obsidian-collacting |
| `00_模板/CLAUDE_Template.md` | vault/CLAUDE.md 追加段（含铁律、身份、工作流） | llm-wiki-plugin-init |
| `10_schema/config.md` | §4 entity / §5 concept / §10 verbatim 规则 | obsidian-collacting（阶段 3）+ kg-sync |

修改这些文件 = 修改 vault 行为的契约，**改动前必读 SKILL.md 引用处的语义**。

## 脚本设计哲学

所有 `.mjs` 脚本统一遵循：

1. **顶部 JSDoc 块**列契约（行为 / 入参 / 退出码 / 测试要求）
2. **纯函数 + CLI 入口**分层：纯函数 `export` 出来供单测，CLI `main()` 仅做 I/O 包装
3. **依赖注入**：Node 22 内置模块 namespace 冻结时绕开用 DI（如 `check-update.mjs` 的 `execFn`）
4. **失败兜底 = exit 0 + warning**（仅 lint-wiki 例外：它退出码 1 表示"发现问题"，符合 lint 惯例）

新写脚本前先 Read 一个现有 `.mjs` 套模板，不要自由发挥。

## Vault 改动流水（硬性约束）

任一 skill 对 vault 笔记（`02_读书笔记/` `11_entities/` `12_concepts/`）有写操作，**或** lint-wiki 完成一次扫描 → 主对话必须在**同次 commit** 内 append `Log.md` 一条（详见 `00_模板/Log_Spec.md`）。

在 `02_读书笔记/` 或 `03_问答区/` 下**新建 / 删除**笔记 → 主对话必须在**同次 commit** 内 `Index.md` 同步（新增 append 一条 / 删除移除对应条目，标题 / 分类 / `[[wiki 路径]]`）。**修改**既有笔记（路径不变）不触发 Index 更新。

详情见 `00_模板/CLAUDE_Template.md`。

# 工作约束

继承用户全局 CLAUDE.md（位于 `C:/Users/ThinkPad/.claude/CLAUDE.md`）：

- AI 回答 / 生成的文档优先中文
- 写代码前必先写架构设计文档让用户确认
- 写代码前必先写测试用例
- 写完代码必跑所能做的测试
- skill 是纯规范文件，**不要把日志、历史、过程产物塞进去**（用完的临时文件放仓库根 `temp/`，按 `.gitignore` 排除）
- Execution 默认 Subagent-Driven
- 模块化原则：一个功能的文档、代码都放一个目录

# 关键文件索引（按改动频次）

| 文件 | 改动频次 | 改时必读 |
|---|---|---|
| `skills/obsidian-collacting/SKILL.md` | 高 | 本仓 `00_模板/标签词表.md` §1-§5 |
| `skills/lint-wiki/SKILL.md` | 中 | `00_模板/标签词表.md` + `scripts/lint-wiki.mjs` 头注释 |
| `skills/knowledge-graph-sync/SKILL.md` | 低 | `10_schema/config.md` |
| `skills/llm-wiki-query/SKILL.md` | 中 | `10_schema/config.md §1` + `00_模板/Log_Spec.md §3.4` + `00_模板/CLAUDE_Template.md` 铁律 #2（检索优先级）+ `scripts/qmd-detect.mjs`（v3 路径选择脚本）。**设计依据**：[reference/llm-wiki.md](reference/llm-wiki.md) L51-L53 "Optional: CLI tools" + spec v3 [docs/superpowers/specs/spec-query.md](docs/superpowers/specs/spec-query.md) (commit `779324a`) |
| `skills/llm-wiki-plugin-init/SKILL.md` | 低 | `scripts/init-vault.mjs` |
| `scripts/*.mjs` | 中 | 顶部 JSDoc 契约 + 对应 `.test.mjs` |
| `00_模板/标签词表.md` | 中 | 一旦改 → 触发 Log.md append（`10_schema/config.md` §3） |
| `00_模板/读书笔记模板.md` | 低 | — |
| `00_模板/CLAUDE_Template.md` | 低 | 改动 = 所有 vault 用户行为契约变更 |
| `10_schema/config.md` | 低 | — |
| `hooks/hooks.json` | 极低 | 改前 review [session-start-update-check spec](docs/superpowers/specs/2026-08-23-session-start-update-check-design.md) |
| `.claude-plugin/plugin.json` | 极低 | `name` 字段不可变（变 = 已安装用户全报 plugin-not-found） |

# License

MIT