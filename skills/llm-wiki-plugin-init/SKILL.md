---
name: llm-wiki-plugin-init
description: 初始化 vault、Inbox、新建知识库
---

# 触发条件

当用户说：初始化 vault、初始化知识库、新建 vault、cold start、init vault

# 流程

## 步骤 1: 问 vault 路径

用 AskUserQuestion 工具问用户：**"请提供 vault 路径（绝对路径，例如 `D:/my-vault`）。注意：路径若已存在内容，会跳过同名文件，不会覆盖。"**

用户确认后记录 `vaultRoot = <path>`。

## 步骤 2: 调起脚本

在 plugin 仓根目录下执行：

```bash
cd "f:/llm-wiki-plugin" && node scripts/init-vault.mjs "<vaultRoot>"
```

脚本会输出 JSON 报告到 stdout（结构见下）。

## 步骤 3: 渲染中文报告

把 JSON 转成中文文本报告输出给用户：

```text
vault: <vaultRoot>
创建目录: <dirsCreated> (新) / <dirsSkipped> (已存在)
拷贝文件: <filesCopied> (新) / <filesSkipped> (已跳过,保留你的修改)
顶层 md: <placeholdersCreated> 个占位文件
CLAUDE.md: <claudeMd.status>
错误: <errors.length>

<如有错误,列出每个 errors[].kind + errors[].path/src/file>

✅ vault 已就绪。下一步：
   - 整理 Inbox → obsidian-collacting
   - 健康检查 → lint-wiki
   - 反向链接 → knowledge-graph-sync
```

## 步骤 4: 失败兜底

| exitCode | 含义 | 主对话应对 |
|---|---|---|
| 0 | 成功 | 步骤 3 渲染报告 |
| 2 | vault 不存在或不是目录 | 告诉用户去检查路径(报告里会附 vault-not-found / vault-is-file) |
| 3 | plugin 资产缺失 / CLAUDE.md 模板缺失 | 提示用户重装 plugin,或检查 --plugin-root 是否正确 |
| 4 | IO 失败(目录创建 / 文件拷贝 / placeholder) | 告诉用户检查 vault 写入权限(报告里附 errno.code) |
| 64 | 命令行参数错误 | 防御性,LLM 不会触发(自己拼命令就忽略这条) |

**任何 exitCode > 0 → 主对话不自动重试,等用户确认。**

# 边界

- **不覆盖** vault 已存在的资产文件(`00_模板/读书笔记模板.md` / `00_模板/标签词表.md` / `10_schema/config.md` / `Inbox/web_clipper/README.md`)
- **不覆盖** vault/CLAUDE.md 的 begin/end 段外内容:首次注入走 append,后续注入走 in-place 替换 begin/end 中间内容(段外一字不动);plugin 升级后再跑一次 init 就能拿到新模板,不会重复追加
- **不删除** vault 任何文件
- **不创建** `.obsidian/`(Obsidian 首次打开会自动生成)
- 重复调用 init 是安全的(幂等);同一 vault 第二次跑只输出更多"已存在"
- `placeholdersCreated` 实际包含 `Index.md` / `Log.md` / `Inbox/.gitkeep` / `Inbox/web_clipper/.gitkeep` / `03_问答区/_cross/.gitkeep` 五件套,字段名偏窄但语义正确(本期保留,后续若分裂再调整)

# 资产清单

来源均为 `f:/llm-wiki-plugin/` 仓根的 `00_模板/` 与 `10_schema/`：

- 拷贝到 vault: `00_模板/读书笔记模板.md`、`00_模板/标签词表.md`、`10_schema/config.md`、`Inbox/web_clipper/README.md`
- 创建到 vault（不拷贝内容）: `03_问答区/` 目录 + `03_问答区/_cross/.gitkeep` 占位
- 注入到 vault/CLAUDE.md: `00_模板/CLAUDE_Template.md`(模板文件本身不拷到 vault)

详见 spec: [myself-marketplace 仓 spec](https://github.com/zhigangliu-bot/myself-marketplace/blob/main/docs/superpowers/specs/2026-08-23-llm-wiki-plugin-init-design.md)