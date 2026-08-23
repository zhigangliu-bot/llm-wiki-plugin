# LLM Wiki Plugin

Obsidian 知识库的 3 个 Claude Code skill 包。

## 安装

通过 marketplace 安装（推荐）：

```
/plugin install llm-wiki-plugin@myself-marketplace
```

或在 Claude Code 中 `/plugin > Discover` 浏览 marketplace 后安装。

## 三个 skill 定位

| Skill | 触发词 | 做什么 |
|---|---|---|
| `knowledge-graph-sync` | knowledge graph / 同步反向引用 / 知识图谱同步 | 手动触发；只补存量 `02_读书笔记/` 的反向引用 `## Related Pages`，不读 PDF、不写正文 |
| `lint-wiki` | lint / healthcheck / 检查 vault / 扫一遍笔记 / 跑 lint | 只读不写；扫 source/entity/concept 14 类健康问题到 `scripts/_lint-report.md` |
| `obsidian-collacting` | 整理 / Inbox / web clipper | `Inbox/` 双源（PDF + web clipper md）→ 归档到 `01_知识库/` → 生成 `02_读书笔记/` 模板 → 写正文 → 抽 entity/concept |

## 内含资产

```
llm-wiki-plugin/
├── skills/                     # 3 个 SKILL.md（Claude Code 自动识别）
├── scripts/
│   ├── lint-wiki.mjs           # lint-wiki 主脚本
│   ├── lint-wiki.test.mjs      # lint-wiki 单元测试 (82 cases)
│   └── sync-pdf-notes.mjs      # obsidian-collacting 同步 PDF 笔记
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
| `obsidian-collacting` | `00_模板/读书笔记模板.md`、`00_模板/标签词表.md`、`10_schema/config.md`、`scripts/sync-pdf-notes.mjs` |

> ⚠️ 缺 schema/模板时 skill 会失败（lint-wiki 会自动跳过 tag-drift 检查；其它两个会直接报错）。

## 本地开发

```bash
cd <plugin-repo>
node --test scripts/lint-wiki.test.mjs   # 82 cases
```

改动前必跑；改动后提交前必跑。

## 源 vault

源 vault 路径（开发参考）：`F:\zhigangliu_lib\mynotes`

## License

MIT