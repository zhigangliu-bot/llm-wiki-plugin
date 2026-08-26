# obsidian-collacting 多源 Inbox 扩展设计

- 日期：2026-08-26
- 作者：zhigangliu
- 状态：待用户 review
- 涉及 skill：`skills/obsidian-collacting/SKILL.md`
- 涉及脚本：新增 `scripts/convert-office.mjs` + `scripts/convert-office.test.mjs`

## 背景

`obsidian-collacting` skill 当前只覆盖两类 Inbox 源：

1. `Inbox/**/*.pdf` — 走 `scripts/sync-pdf-notes.mjs` 自动生成 PDF 笔记
2. `Inbox/web_clipper/*.md` — 手工 cp 读书笔记模板，sub agent 补内容

实际使用中，Inbox 还会收到 PPT / Word / Excel / 图片 截图等类型资料，当前 skill 无法处理这些文件。本次扩展目标：在不动 `sync-pdf-notes.mjs` 的前提下，新增 office 三件套 + 图片两类源的支持。

## 关键决策（与用户对齐结果）

| # | 决策点 | 选择 |
|---|---|---|
| 1 | 同步路径 | 全部走手工 cp 模板（与现有 web_clipper md 路径一致） |
| 2 | Inbox 布局 | 不限定目录，按扩展名识别，按内容主题归档 |
| 3 | sub agent 读取源文件 | 提供 node 脚本预转 md（office→md；图片→OCR md） |
| 4 | 笔记模板 | 复用 `00_模板/读书笔记模板.md` |
| 5 | OCR 引擎 | PaddleOCR（不用 tesseract，中文识别更准） |
| 6 | 设计文档位置 | `f:/llm-wiki-plugin/docs/superpowers/specs/` |

## 架构总览

```
[Inbox 扫描]
   ↓ 递归 Inbox/**/*.{pdf,pptx,docx,xlsx,png,jpg,jpeg,md}
   ↓ 排除 Inbox/web_clipper/ 子目录（保持现有单层 md 路径不变）
   ↓ 按扩展名分桶：pdf / md / office / image
[类型路由]
   ↓ pdf  → 原 sync-pdf-notes.mjs 路径（不变）
   ↓ md   → 原 web_clipper 手工路径（不变）
   ↓ office/image → 新增手工路径
   ↓   └─ 归档前先调 convert-office.mjs 预转 md → temp/ingest/<basename>.md
[归档 + 模板复制]
   ↓ mv Inbox/<file> → 01_知识库/<主题>/
   ↓ cp 00_模板/读书笔记模板.md → 02_读书笔记/<主题>/<name>.md
   ↓ Edit 替换 frontmatter 占位字段
   ↓ 同名冲突 → 跳过并报告
[sub agent 两层流]
   ↓ 阶段 2：每篇 source 一个 sub agent 写笔记
   ↓   pdf：读 PDF 二进制；office/image：读 temp/ingest/<basename>.md
   ↓ 阶段 3：抽取 entity/concept（不变）
[Index.md / Log.md 强制同步]
```

## convert-office.mjs 脚本契约

**职责**：把 office / image 二进制文件预转 md，写到 `<vaultRoot>/temp/ingest/<basename>.md`。

**CLI 接口**：

```bash
node scripts/convert-office.mjs --input=<abs_path> --output=<abs_path> --type=<pptx|docx|xlsx|png|jpg|jpeg>
```

**返回**：
- 成功：`{ ok: true, md_path, char_count, page_count }`
- 失败：`{ ok: false, error, stderr }`（非零退出码 + JSON 到 stdout）

**类型→命令 映射**：

| `--type` | 命令 |
|---|---|
| `pptx` | `libreoffice --headless --convert-to md --outdir <tmpdir> <input>` |
| `docx` | `pandoc -f docx -t markdown -o <output> <input>`（优先 pandoc，缺失则 fallback libreoffice） |
| `xlsx` | `libreoffice --headless --convert-to csv --outdir <tmpdir> <input>` → 脚本拼接多 sheet CSV 为 md 表格 |
| `png` / `jpg` / `jpeg` | `paddleocr --image_dir=<input> --lang=ch --use_angle_cls=true --use_gpu=false` → 解析 stdout JSON 的 `rec_texts` → 写 md |

**行为细节**：

1. **类型检测**：`--type` 与扩展名双重校验，不一致报错
2. **临时目录**：`<vaultRoot>/temp/ingest/`，归档完成后由 skill 删除
3. **超时**：默认 60s，kill 子进程退出码 3
4. **失败处理**：
   - `paddleocr` 缺失 → 图片跳过，**不阻塞**其他类型（`tool_missing`）
   - `libreoffice` 缺失 → pptx/docx/xlsx 报错，**整个 skill 中止**要求用户安装
   - `pandoc` 缺失 → 自动 fallback libreoffice，无感
   - 加密 office → 透传 stderr 报错，跳过该文件
5. **不做的事**：不解析图片里的公式/图表；不保留 pptx 动画；不处理加密文件

**输出 md 格式约定**（sub agent verbatim 引用依赖）：

```markdown
---
source_file: <原文件名>
source_type: <pptx|docx|xlsx|png|jpg|jpeg>
converted_at: <YYYY-MM-DD>
---

<!-- 第 N 段 -->
...文本...

<!-- 第 N+1 段 -->
...文本...
```

- pptx：每张幻灯片一个 `<!-- 第 N 段 -->` 块
- docx：每段一个块
- xlsx：每 sheet 一个块，CSV 转 md 表格
- image：OCR 识别行用空行分段，每段一个块

无页码信息的源（pptx 动画/图片 OCR）在 sub agent prompt 里明示「标注源文件名 + 段序号」即可。

**PaddleOCR 调用**：

```bash
paddleocr --image_dir=<abs_path> --lang=ch --use_angle_cls=true --use_gpu=false
```

- 解析 stdout JSON 的 `rec_texts` 数组，join 为段落写入 md
- 依赖：`pip install paddleocr paddlepaddle`
- 缺失时不阻塞其他类型，仅跳过图片

## SKILL.md 改动范围

| 段 | 改动 |
|---|---|
| 触发条件 | 关键词追加 `office / ppt / word / excel / 图片` |
| 执行前置 | 不变 |
| **新增** # convert-office 依赖前置 | 检查 `paddleocr` / `libreoffice` / `pandoc` 是否在 PATH；缺失则列出清单，图片自动跳过、其他类型报错 |
| # Inbox 双源扫描 → # Inbox 多源扫描 | 表格扩为 6 行（pdf / md / pptx / docx / xlsx / image） |
| # 执行动作 步骤 1 | `Inbox/**/*.{pdf,pptx,docx,xlsx,png,jpg,jpeg}` + `Inbox/web_clipper/*.md` |
| # 执行动作 步骤 4 / 4' | 不变 |
| **新增** 步骤 4''（office/image 同步） | 对每篇 office/image：① 调 `convert-office.mjs` 生成 `temp/ingest/<name>.md`；② `cp 00_模板/读书笔记模板.md 02_读书笔记/<主题>/<name>.md`；③ Edit frontmatter 占位字段；④ 删 temp md |
| 步骤 5（sub agent 写笔记） | 新增 office/image 分支：读 `temp/ingest/<name>.md`；verbatim 引用标注「页码不可用，标注源文件名 + 段落序号」 |
| 步骤 8（汇报） | 报告新增 office / image 分类计数 |
| # 两层 sub agent 工作流 | 阶段 2 prompt 模板的 source 类型差异表新增 office/image 行 |

## 错误处理矩阵

| 场景 | 行为 | 退出/上报 |
|---|---|---|
| `paddleocr` 未安装 | 图片跳过 | 不阻塞，报告 |
| `libreoffice` 未安装 | pptx/docx/xlsx 报错 | skill 中止 |
| `pandoc` 缺失 | docx fallback libreoffice | 自动降级 |
| office 文件密码保护 | 透传 stderr 报错，跳过该文件 | 报告 |
| pptx 含复杂图表 | libreoffice 简化，仅留文本 | 报告 |
| xlsx 超大 (>10MB) | 60s 超时 kill | 报告 |
| 同名文件已归档 | 跳过该文件 | 报告 |
| temp/ingest/ 已存在残留 | skill 启动时清空 | 静默 |
| frontmatter Edit 失败 | skill 中止，已归档文件保持现状 | 人工 review |

## 测试策略

**convert-office.mjs 单测**（`scripts/convert-office.test.mjs`，node:test）：

| 用例 | 断言 |
|---|---|
| `test_pptx_to_md_success` | 最小 pptx fixture → 输出 md 含幻灯片分隔符 |
| `test_docx_pandoc_preferred` | mock pandoc 存在 → 不调 libreoffice |
| `test_xlsx_multi_sheet` | 多 sheet fixture → 输出含多个 markdown 表格 |
| `test_png_paddleocr_missing` | mock paddleocr 不在 PATH → 返回 `tool_missing` 退出码 2 |
| `test_type_mismatch` | 扩展名与 `--type` 不一致 → 报错 |
| `test_timeout` | mock hang 命令 → 60s 后超时退出 |

**集成测试**（手工跑一遍）：
- 准备：`Inbox/` 放 6 种类型各 1 个样本文件
- 执行：触发 skill "整理"
- 验收清单：
  - [ ] 6 个文件都被 mv 到 `01_知识库/<主题>/`
  - [ ] 6 个空模板生成在 `02_读书笔记/<主题>/`
  - [ ] sub agent 写完 6 篇笔记（每篇含 摘要/重点摘录/我的思考/总结）
  - [ ] Index.md append 6 条
  - [ ] Log.md append 1 条
  - [ ] `temp/ingest/` 清空
  - [ ] frontmatter 4 字段正确

**回归测试**：原 PDF + web_clipper md 路径不受影响，跑 2 个原 fixture 断言输出不变。

## 验收成功标准（DoD）

1. ✅ `scripts/convert-office.mjs` + `scripts/convert-office.test.mjs` 落地，6 个单测全过
2. ✅ `SKILL.md` 改动落地，触发关键词扩展为 8 个
3. ✅ 集成测试 7 条清单全过
4. ✅ 原 PDF + web_clipper md 回归测试通过
5. ✅ design doc + plan doc 提交到 plugin 仓 `docs/superpowers/`
6. ✅ 一次 commit 含所有改动

## 不做（YAGNI）

- 不做 office→md 转换结果的二次校验（依赖工具自身正确性）
- 不做并发 sub agent 的 LLM 速率限制
- 不做图片哈希去重（与本次扩展正交，独立需求）

## 文件清单

| 文件 | 状态 |
|---|---|
| `skills/obsidian-collacting/SKILL.md` | 修改 |
| `scripts/convert-office.mjs` | 新增 |
| `scripts/convert-office.test.mjs` | 新增 |
| `docs/superpowers/specs/2026-08-26-obsidian-collacting-multisource-design.md` | 新增（本文件） |
| `docs/superpowers/plans/2026-08-26-obsidian-collacting-multisource-plan.md` | 新增（implementation plan） |
