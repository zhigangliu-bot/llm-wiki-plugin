# LLM Wiki Plugin

Obsidian 知识库的 5 个 Claude Code skill 包。

## 安装

通过 marketplace 安装（推荐）：

```
/plugin install llm-wiki-plugin@myself-marketplace
```

或在 Claude Code 中 `/plugin > Discover` 浏览 marketplace 后安装。

## 环境依赖（开箱即用清单）

> plugin 自身无 `package.json`,所有脚本都只调 Node 内置模块(无第三方 npm 依赖)。
> 装好后用户机器上必须有以下工具才能跑全部 skill。

| 工具 | 必需 | 用途 | 校验命令 |
|---|---|---|---|
| **Node.js ≥ 22** | ✅ | `node --test` / `init-vault.mjs` / `lint-wiki.mjs` / `sync-pdf-notes.mjs` 都用 `node:fs/promises`、`node:test` 等内置 API,Node 22 起 ESM namespace 才稳定 | `node -v` ≥ `v22.x.x` |
| **git** | ✅ | SessionStart 自动更新 hook 跑 `git pull --ff-only`(详见下节) | `git --version` |
| **Obsidian** | ✅ | vault 是 Obsidian 知识库,需要 Obsidian 打开目录才能可视化(`.obsidian/` 由 Obsidian 首次打开自动生成) | — |
| **Claude Code** | ✅ | plugin 是 Claude Code 的 marketplace 包,需要 Claude Code 加载才能调起 skill | `claude --version` |

| 工具 | 可选 | 用途 | 触发场景 |
|---|---|---|---|
| **[@tobilu/qmd](https://www.npmjs.com/package/@tobilu/qmd)** | ⚙️ | `llm-wiki-query` 的混合 BM25+向量+LLM 重排搜索引擎;未装时自动降级为 `Grep + Read`,小 vault 也够用 | 大 vault(笔记 > 500 篇) 或需要语义搜索时 |
| **Templater plugin** | ⚙️ | Obsidian 端用 Templater 一键新建 `02_读书笔记/` 笔记;纯手动也行 | 想用快捷键新建笔记时 |
| **Obsidian Web Clipper** | ⚙️ | 浏览器一键把网页存为 md 到 `Inbox/web_clipper/`,供 `obsidian-collacting` skill 批量归档 | 想自动收网页笔记时 |
| **libreoffice** | ⚙️ | `obsidian-collacting` 预转 pptx / docx / xlsx(统一走 LibreOffice);`apt install libreoffice` / `brew install --cask libreoffice` | Inbox 里有 pptx/docx/xlsx 文件时 |
| **paddleocr** | ⚙️ | `obsidian-collacting` 预转 png/jpg/jpeg 图片 OCR(中文识别优于 tesseract);`pip install paddleocr paddlepaddle`;缺失时图片文件跳过,其他类型继续;**首次运行 PaddleOCR 会加载 ~1GB 模型到 `C:\Users\<u>\.paddlex\`,需 3–5 分钟冷启动** | Inbox 里有图片文件时 |

### 快速安装（Windows / macOS / Linux）

```bash
# 1. Node ≥ 22 (Windows: 用 nvm-windows; macOS/Linux: 用 nvm)
nvm install 22 && nvm use 22

# 2. git (Linux: apt install git; macOS: brew install git; Windows: https://git-scm.com/)

# 3. Obsidian → https://obsidian.md/download

# 4. Claude Code → https://docs.claude.com/claude-code

# 5. (可选) qmd — 装好后见下文"qmd 接入"
npm i -g @tobilu/qmd
```

### 校验清单

装好上面 4 个硬依赖后,在 vault 根目录跑一行验证全部跑通:

```bash
node ~/.claude/plugins/cache/myself-marketplace/llm-wiki-plugin/*/scripts/init-vault.mjs .
```

(glob `*` 匹配当前版本号;Windows 用户把 `~/.claude/plugins/cache/` 换成 `%USERPROFILE%\.claude\plugins\cache\`。)

期望:`exitCode: 0`,控制台 JSON 报告里 `claudeMd.status` 是 `created` 或 `refreshed`,`errors` 为空。

## Auto-Update

This plugin auto-updates from GitHub on every Claude Code startup via a `SessionStart` hook (matcher: `startup`). The hook runs `git pull --ff-only` against the plugin's local cache copy, so you always have the latest version without manually reinstalling.

**When the hook fires:**
- ✅ **Update available** → pulls fast-forward and prints `✓ llm-wiki-plugin updated: aaaaaaa..bbbbbbb`. Claude will surface this in your next conversation.
- ⚠ **Local changes conflict** → prints warning, leaves local alone (non-fast-forward safe).
- ⚠ **Network down** → silent fallback, prints warning, session continues normally.
- **(silent)** **Already up-to-date** → no output.

The hook is **async** and **never blocks session start**. Exit code is always 0.

**Disable auto-update:**
Edit `hooks/hooks.json` in the installed plugin cache (`~/.claude/plugins/cache/myself-marketplace/llm-wiki-plugin/<version>/hooks/hooks.json`) or comment out the hook.

**Manual update:**
```bash
cd ~/.claude/plugins/cache/myself-marketplace/llm-wiki-plugin/<version>
git pull --ff-only
```

## 五个 skill 定位

| Skill | 触发词 | 做什么 |
|---|---|---|
| `knowledge-graph-sync` | knowledge graph / 同步反向引用 / 知识图谱同步 | 手动触发；只补存量 `02_读书笔记/` 的反向引用 `## Related Pages`，不读 PDF、不写正文 |
| `lint-wiki` | lint / healthcheck / 检查 vault / 扫一遍笔记 / 跑 lint | 只读不写；扫 source/entity/concept 14 类健康问题到 `scripts/_lint-report.md` |
| `obsidian-collacting` | 整理 / Inbox / web clipper / office / ppt / word / excel / 图片 | `Inbox/` 6 源（pdf / web_clipper md / pptx / docx / xlsx / png-jpg）→ 归档到 `01_知识库/` → 生成 `02_读书笔记/` 模板 → 写正文 → 抽 entity/concept；office 与图片走 `scripts/convert-office.mjs` 预转 md |
| `llm-wiki-query` | 查 wiki / 问个问题 / 问一下 / query / 查 vault / 知识库里有没有 X / 我问个问题 | 显式触发；用 qmd MCP 召回 + 引用合成答案；好答案自动归档到 `03_问答区/` |

## 内含资产

```
llm-wiki-plugin/
├── skills/                     # 5 个 SKILL.md（Claude Code 自动识别）
├── scripts/
│   ├── lint-wiki.mjs           # lint-wiki 主脚本
│   ├── lint-wiki.test.mjs      # lint-wiki 单元测试 (82 cases)
│   ├── sync-pdf-notes.mjs      # obsidian-collacting 同步 PDF 笔记
│   ├── convert-office.mjs      # obsidian-collacting 预转 office/image 为 md（libreoffice/pandoc/paddleocr）
│   └── convert-office.test.mjs # convert-office 单元测试 (11 cases)
├── 10_schema/
│   └── config.md             # §4 entity / §5 concept / §10 verbatim 规则
└── 00_模板/
    ├── 读书笔记模板.md         # 02_读书笔记/ 模板
    └── 标签词表.md             # §2/§3/§4 词表
```

> plugin 自带 schema + 模板，是**完整可移植包**。插件被 Claude Code 加载后，skill 通过 Read 工具按相对路径引用这些资产。

## 每个 skill 依赖的资产

| Skill | 必需资产（plugin 内） |
| --- | --- |
| `knowledge-graph-sync` | `10_schema/config.md`、`00_模板/标签词表.md` |
| `lint-wiki` | `00_模板/标签词表.md` |
| `obsidian-collacting` | `00_模板/读书笔记模板.md`、`00_模板/标签词表.md`、`10_schema/config.md`、`scripts/sync-pdf-notes.mjs`、`scripts/convert-office.mjs` |

> ⚠️ 缺 schema/模板时 skill 会失败（lint-wiki 会自动跳过 tag-drift 检查；其它四个会直接报错）。

## 本地开发

```bash
cd <plugin-repo>
node --test scripts/lint-wiki.test.mjs           # 82 cases
node --test scripts/convert-office.test.mjs      # 11 cases
```

改动前必跑；改动后提交前必跑。

## 源 vault

源 vault 路径（开发参考）：`F:\zhigangliu_lib\mynotes`

## Skill: `llm-wiki-plugin-init`（新增 v0.1）

冷启动初始化：**给 vault 一句话触发词，1 份控制台报告** 完成。

触发词：初始化 vault、初始化知识库、新建 vault、cold start、init vault

行为：
- 创建 8 个 wiki 目录（`01_知识库/` `02_读书笔记/` `11_entities/` `12_concepts/` `Inbox/` `00_模板/` `10_schema/` `附件文件夹/`）+ `03_问答区/`（llm-wiki-query skill 的归档区）
- 创建 2 个顶层 md 占位（`Index.md` `Log.md`）+ `Inbox/.gitkeep` + `03_问答区/_cross/.gitkeep`
- 拷贝 3 个 plugin 资产到 vault 同名位置（已存在则跳过,**不覆盖**）
- 把 `00_模板/CLAUDE_Template.md` 内容追加到 vault/CLAUDE.md 末尾（`<!-- llm-wiki-plugin-init:begin/end -->` 包裹,幂等）

幂等可重复跑,vault 已部分初始化时只输出"已存在"。

详见 spec：[myself-marketplace 仓 spec](https://github.com/zhigangliu-bot/myself-marketplace/blob/main/docs/superpowers/specs/2026-08-23-llm-wiki-plugin-init-design.md)

## 可选：qmd 接入（llm-wiki-query skill 的搜索引擎）

`llm-wiki-query` skill 默认走 **qmd MCP server**（混合 BM25 + 向量搜索 + LLM 重排，全部本地）。未装 qmd 时自动降级为 LLM `Grep` + `Read`（小 vault 也够用）。

**手动接入步骤**：

```bash
# 1. 装 qmd（需 Node ≥22 或 Bun ≥1.0）
npm i -g @tobilu/qmd

# 2. 在 vault 根目录添加 collection（每个 vault 一次）
cd <vaultRoot>
qmd collection add . --name my-vault
qmd embed

# 3. 在 plugin 仓根 `.mcp.json` 加 qmd 条目（plugin 默认 `.mcp.json` 在 .gitignore，敏感）
{
  "mcpServers": {
    "qmd": { "command": "qmd", "args": ["mcp"] }
  }
}

# 4. 重启 Claude Code 让 .mcp.json 生效
```

首次 `qmd embed` 对大 vault 可能耗时数分钟——README 不代理这一步，用户自己跑。

详见 spec：[docs/superpowers/specs/2026-08-23-query-skill-design.md](docs/superpowers/specs/2026-08-23-query-skill-design.md)。

## License

MIT