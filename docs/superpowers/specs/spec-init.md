# llm-wiki-plugin-init Skill 设计

- 作者：zhigangliu
- 状态：待用户 review

## 背景

`llm-wiki-plugin` 当前 3 个 skill(`knowledge-graph-sync` / `lint-wiki` / `obsidian-collacting`)都假设 vault 已经按 `10_schema/config.md §1` 初始化完毕。但用户实际使用时常面临冷启动场景：

- 新 vault 完全空,需手动建 14 个目录 + 5 个 md 顶层文件
- `00_模板/` 和 `10_schema/` 需手动从 plugin 复制过来
- 漏建一个目录,后续 skill 就会扫不到笔记、报错

需要一个一键初始化 skill,让冷启动变成「一句触发词 → 1 份控制台报告」的零决策流程。

## 目标

新增 skill `llm-wiki-plugin-init`,触发后：

1. 在用户指定的 vault 路径下,按 `10_schema/config.md §1` 的 Wiki Structure 创建 14 个目录 + 5 个顶层 md 文件
2. 把 plugin 自带的资产拷贝到 vault 同名位置：`00_模板/读书笔记模板.md`、`00_模板/标签词表.md`、`10_schema/config.md`
3. 把 plugin 的 `00_模板/CLAUDE_Template.md` 注入到 vault 根 `CLAUDE.md`（末尾追加，分隔区包裹，幂等不重复）
4. 跳过 vault 已存在的同名资产(保留用户定制),不覆盖
5. 在控制台输出文本报告：创建目录数 / 拷贝文件数 / 跳过文件数 / CLAUDE.md 注入状态 / 错误数

非目标(YAGNI)：

- 不支持 `--force` 覆盖已有文件(违反"幂等 + 保留用户修改")
- 不生成 vault/INIT_LOG.md(违反"控制台文本报告")
- 不调 LLM 走 diff preview(违反"加脚本"原则,IO 与 LLM 边界模糊)
- 不实现 vault 路径自动发现(违反"skill 启动时问")

## 行为契约

| 行为 | 规则 |
|---|---|
| 幂等 | 同一 vault 重复调用,结果状态不变,只输出更多"跳过" |
| 目录创建 | vault 内 14 个目录不存在则 `mkdir -p`,已存在则跳过 |
| 文件拷贝 | vault 内 3 个文件不存在则 `cp`,已存在则跳过且不读内容对比 |
| CLAUDE.md 注入 | vault/CLAUDE.md 不存在 → 创建并写入 `<!-- llm-wiki-plugin-init:begin -->\n<模板内容>\n<!-- llm-wiki-plugin-init:end -->` 包裹块；已存在且无双标记 → 末尾追加该包裹块；已存在且有 begin/end 双标记 → **in-place 替换两标记之间的内容为最新模板**(段外一字不动)；重复调用不重复追加 |
| 资产来源 | 拷贝源 = plugin 的 `00_模板/` + `10_schema/`(`{pluginRoot}/skills/llm-wiki-plugin-init/../../` 即可定位)|
| 顶层 md | `Index.md` / `Log.md` / `Inbox/.gitkeep` 创建空文件占位(内容由后续 skill 生成) |
| vault 不存在 | 报错退出,exit code 2 |
| vault 是文件 | 报错退出,exit code 2 |
| 资产源不可读 | 报错退出,exit code 3 |

## 架构

```
┌──────────────────────────────────────────────────────────────────┐
│ skills/llm-wiki-plugin-init/SKILL.md        # LLM 走流程指引      │
│   步骤 1: 问 vault 路径                                            │
│   步骤 2: 读 plugin 资产确认存在                                    │
│   步骤 3: 调起 scripts/init-vault.mjs <vault>                      │
│   步骤 4: 输出控制台报告                                            │
├──────────────────────────────────────────────────────────────────┤
│ scripts/init-vault.mjs                     # 纯 IO 机械动作          │
│   exports:                                                         │
│     - ensureVaultRoot(path) -> {ok, error?}                       │
│     - copyTemplateIfMissing(src, dst) -> {action: 'copied'|'skipped'|'failed', error?} │
│     - copySchemaIfMissing(src, dst) -> 同上                          │
│     - ensureDir(path) -> {created: bool}                          │
│     - runInit({vaultRoot, pluginRoot}) -> {report, counters, exitCode}  │
│                                                                  │
│   CLI 入口(被 import 时不触发):                                        │
│     main() → parseArgs → runInit → stdout 报告 → process.exit    │
├──────────────────────────────────────────────────────────────────┤
│ scripts/init-vault.test.mjs                # 单元测试             │
│   describe: ensureDir / copyIfMissing / runInit 集成                │
└──────────────────────────────────────────────────────────────────┘
```

### SKILL.md 与脚本分工

- **SKILL.md** 负责：用户交互(问 vault 路径)、输出报告时调起主对话文案、解释 skill 触发后的预期行为。
- **脚本** 负责：所有 mkdir / copy IO、退出码、计数器。不读 vault 路径之外的环境变量、不读 stdin、不调 LLM。

## Wiki Structure → 创建清单

源：`10_schema/config.md §1`（9 目录 + 5 顶层 md），§1 已删除 `.claude/skills/` 和 `scripts/` 两行（commit `937db40`），实际待建：

```js
const DIRECTORIES = [
  '01_知识库',
  '02_读书笔记',
  '11_entities',
  '12_concepts',
  'Inbox',
  '00_模板',          // plugin 已自带资产
  '10_schema',        // plugin 已自带资产
  '附件文件夹',
  '.obsidian',        // 隐含：Obsidian 自身配置目录
];

const TOP_LEVEL_FILES = [
  'Index.md',         // 占位空文件
  'Log.md',           // 占位空文件
  'Inbox/.gitkeep',   // 占位空文件
];
```

> `.obsidian/` 不在 Wiki Structure 里但必需(否则 Obsidian 打开 vault 报错)。作为隐含项加入,不写进 SKILL.md 报告,只在日志记录。

## 资产拷贝清单

| 源(plugin 仓相对路径) | 目标(vault 相对路径) | 冲突策略 |
|---|---|---|
| `00_模板/读书笔记模板.md` | `00_模板/读书笔记模板.md` | 跳过(保留用户修改)|
| `00_模板/标签词表.md` | `00_模板/标签词表.md` | 跳过 |
| `10_schema/config.md` | `10_schema/config.md` | 跳过 |
| `00_模板/CLAUDE_Template.md` | `CLAUDE.md` | 首次创建 / 末尾追加 / 已存在则 in-place 刷新 begin/end 中间内容；模板自身不拷贝到 vault |

## 数据流

```
1. 用户触发 (e.g. "初始化 vault")
   ↓
2. SKILL.md 指引 LLM 问用户 vault 路径
   ↓
3. LLM 调起 `node scripts/init-vault.mjs <vaultPath>`
   ↓
4. 脚本：ensureVaultRoot → 14 × ensureDir → 3 × copyIfMissing → .obsidian 创建
   ↓
5. 脚本：stdout JSON 报告 { dirs_created, dirs_skipped, files_copied, files_skipped, errors }
   ↓
6. SKILL.md 指引 LLM 把 JSON 转成中文文本报告输出给用户
```

## 错误处理

| 场景 | 退出码 | 报告字段 |
|---|---|---|
| vault 不存在 | 2 | `errors: [{kind: 'vault-not-found', path}]` |
| vault 是文件不是目录 | 2 | `errors: [{kind: 'vault-is-file', path}]` |
| plugin 资产读失败(权限 / 缺失)| 3 | `errors: [{kind: 'asset-read-failed', src}]` |
| 拷贝失败(权限) | 4 | `errors: [{kind: 'copy-failed', src, dst}]` |

任何错误都不影响已有目录/文件,只跳过当前 IO。退出码 = max(已发生的 errors 对应码)。

## 输出格式

stdout JSON（脚本）+ LLM 渲染为中文文本：

```text
vault: <vaultPath>
创建目录: 12 (新) / 2 (已存在)
拷贝文件: 1 (新) / 2 (已跳过,保留你的修改)
顶层 md: 3 个占位文件
错误: 0
CLAUDE.md: 已注入模板 | 首次 | 已存在并追加分隔区 | 已存在且模板已注入(已就地刷新为最新模板)

✅ vault 已就绪。下一步：/plugin knowledge-graph-sync @ llm-wiki-plugin
```

### CLAUDE.md 注入细则

- 模板源 = `00_模板/CLAUDE_Template.md`，**不拷贝到 vault**，仅内容注入
- 分隔区格式（不可改，幂等性依赖）：
  ```markdown
  <!-- llm-wiki-plugin-init:begin -->
  <模板原内容, 去最末换行>
  <!-- llm-wiki-plugin-init:end -->
  ```
- 三种状态：
  - `created`：文件不存在 → 写入 `begin\n<模板>\nend\n`
  - `appended`：文件存在但无双标记 → 末尾追加 `\nbegin\n<模板>\nend\n`（用户原文不动）
  - `refreshed`：文件存在且有 begin/end 双标记 → 用正则定位 begin/end index,**只替换中间内容为最新模板**,begin 之前的原文 + end 之后的原文均一字不动。plugin 升级后跑 init = 自动把 begin/end 中间内容刷新成新模板
- 用户手动删了分隔区（无双标记）再跑 init：回到 appended 状态重新追加
- 用户手动只删 begin 或只删 end（孤标记）：回到 appended 状态追加新块,孤标记不会被清理（留给用户手工处理,避免脚本对用户私域内容做未授权写入）

## 测试计划

| 测试 | 验证 |
|---|---|
| `ensureDir(newPath)` 返回 `{created: true}` | 目录创建逻辑 |
| `ensureDir(existingPath)` 返回 `{created: false}` | 跳过逻辑 |
| `copyIfMissing(src, newDst)` 返回 `{action: 'copied'}` | 拷贝逻辑 |
| `copyIfMissing(src, existingDst)` 返回 `{action: 'skipped'}` | 跳过逻辑 |
| `runInit(emptyVault)` 计数器全为创建 | 集成场景 |
| `runInit(halfInitVault)` 部分创建/部分跳过 | 集成场景 |
| `runInit(nonExistentVault)` 退出码 2 | 错误路径 |
| `runInit(fileAsVault)` 退出码 2 | 错误路径 |
| `injectClaudeMd(emptyVault)` → CLAUDE.md 含完整模板, status=created | 首次注入 |
| `injectClaudeMd(vaultWithExistingClaudeMd, noBlock)` → 末尾追加 begin/end 包裹区，原内容不动, status=appended | 已存在追加 |
| `injectClaudeMd(vaultWithAlreadyInjected, staleTemplate)` → status=refreshed, 开头/结尾一字不动, 中间内容替换为新模板, begin/end 仍各 1 个 | 幂等刷新(plugin 升级场景) |
| `injectClaudeMd(vaultWithAlreadyInjected)` 第二次 → 文件字节数不变 | 不重复追加 |
| `injectClaudeMd(vaultWithManuallyRemovedBlock)` → status=appended, 重新追加一次 | 恢复注入 |

测试用 `mkdtemp` 在 `os.tmpdir()` 建合成 vault；plugin 资产用真实 plugin 路径(`process.cwd() + '../../'` 之类)。

## 边界 / 不做

- **不做 `--force`**：违反用户决策"保留用户修改"
- **不做 vault 路径发现**：违反"skill 启动时问"
- **不做 INIT_LOG.md**：违反"控制台文本报告"
- **不做 diff preview**：违反"加脚本"原则
- **不删除已存在文件**：即使是空文件
- **不检查 vault 是否已是合法 wiki**：可能 vault 已手动建过部分目录，init 不会识别"已初始化"状态

## 风险

| 风险 | 缓解 |
|---|---|
| 用户给错 vault 路径 | SKILL.md 步骤 1 在用户确认后才调脚本；脚本再加一次 `ensureVaultRoot` 校验 |
| 拷贝覆盖用户修改 | 拷贝前必须 `fs.access(dst)` 跳过 |
| plugin 升级后 vault 不一致 | README 加"vault 内 00_模板 / 10_schema 是独立拷贝，plugin 升级不会自动同步"声明 |
| 权限错误（如 vault 只读） | 退出码 4，错误信息含 src/dst |

## 实现路线

按 writing-plans skill 产出 plan，4 步：

1. 写 `scripts/init-vault.mjs` 纯函数骨架 + 6 个测试通过
2. 加 CLI 入口 + 集成测试（runInit 2 个场景）
3. 写 `skills/llm-wiki-plugin-init/SKILL.md`（参考 `obsidian-collacting` SKILL.md 的"流程"型风格）
4. 在 plugin README 加 1 行触发词表 + 1 段"vault 初始化"说明

---

## 增量：scripts 拷贝（plugin 升级同步）

> 把 4 个 CLI 脚本在 init 时拷到 vault 根的 `scripts/`,解决 SKILL.md 调 `node scripts/...` 时 cwd 不一定是 vault 根导致的 ENOENT。

### 动机

1. SKILL.md `obsidian-collacting` 步骤 4 写 `node scripts/sync-pdf-notes.mjs --overwrite=false --source-field=source`,**依赖 cwd = vault 根**(`scripts/sync-pdf-notes.mjs:27` `vault = process.cwd()`)
2. 用户机器上 vault 目录里**根本没有 `scripts/`** —— scripts 只在 plugin 开发仓 `f:\llm-wiki-plugin\scripts\` 下存在
3. claude agent 在 vault 子目录里被触发、或通过 plugin loader 触发时,cwd 不一定是 vault 根 —— `scripts/...` 路径找不到就报 ENOENT
4. 已观察到:有时 skill 从工程目录(开发仓根)下去找脚本能找到,有时从用户实际 vault 目录下找不到 —— 表现就是"有时候从工程目录下去找脚本了"

目标:

- SKILL.md 调用脚本时**不依赖 cwd**,只要 vault 根下有 `scripts/` 就一定能跑通
- 用户机器上的 vault 与开发仓解耦:scripts 在 init 时被拷到 vault 里,自带自洽

### 方案

**1. init-vault.mjs 增加脚本拷贝**

新增白名单常量（只拷 CLI 入口本身,不拷 `*.test.mjs`）:

```js
export const SCRIPT_FILES = [
  'scripts/init-vault.mjs',
  'scripts/sync-pdf-notes.mjs',
  'scripts/check-update.mjs',
  'scripts/lint-wiki.mjs',
];
```

`runInit` 第 3 步(目前是拷贝 4 个资产)后插入新步骤。**脚本直接覆盖 vault/scripts/ 已有同名文件**(plugin 升级时同步修复,不保留用户本地修改):

```js
// 3.5 拷贝脚本到 vault 根的 scripts/ 目录(直接覆盖,不保留本地修改)
for (const relPath of SCRIPT_FILES) {
  const src = path.join(pluginRoot, relPath);
  const dst = path.join(vaultRoot, relPath);
  try {
    await fs.access(src);
  } catch {
    errors.push({ kind: 'asset-missing', src });
    continue;
  }
  try {
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.copyFile(src, dst);  // 覆盖写
    counters.scriptsWritten++;
  } catch (e) {
    errors.push({ kind: 'copy-failed', src, dst, error: { code: e.code, message: e.message } });
  }
}
```

`counters` 新增 `scriptsWritten` 字段。错误处理复用现有 `asset-missing` / `copy-failed` kind,**不新增 kind**。

**为什么覆盖(不沿用 copyIfMissing)**:
- scripts 是 plugin 行为载体,plugin 升级必须同步到 vault,否则新逻辑调不到
- 资产 md(模板/词表)是用户内容载体,用户可能改过 → 不覆盖(沿用 copyIfMissing)
- 两类资产策略不同,所以分两个步骤,counters 也分两个字段(`filesCopied/Skipped` 与 `scriptsWritten`)

**2. SKILL.md `obsidian-collacting` — 顶部加执行前置约束**

在 `# 触发条件` 段后、第一个 H2 段前插入:

```markdown
# 执行前置(强制)

调用任何 `node scripts/...` 命令前,**必须保证当前工作目录是 vault 根**(`<vaultRoot>/`,即含 `01_知识库/` `02_读书笔记/` `00_模板/` 的目录)。

两种方式二选一:

1. 主对话执行 `cd "<vaultRoot>" && node scripts/<name>.mjs ...`(显式 cd)
2. 主对话先用 Bash 切换 cwd 到 vault 根,后续命令省略 cd 前缀

**禁止**:
- 在 skill 所在 plugin 目录下直接调 `node scripts/...` —— `scripts/` 不在 plugin 仓根,而在 vault 根
- 用相对路径 `../../../scripts/...` 跨层跳 —— 不可移植,vault 路径变化就崩

init 阶段会保证 `<vaultRoot>/scripts/` 存在(见 `llm-wiki-plugin-init` 步骤 2.5),但**不保证 cwd**。
```

步骤 4 命令**保持原样**(依赖 cwd 已经满足):`node scripts/sync-pdf-notes.mjs --overwrite=false --source-field=source`

**3. SKILL.md `llm-wiki-plugin-init` — 步骤 3 渲染报告加脚本行**

```text
vault: <vaultRoot>
创建目录: <dirsCreated> (新) / <dirsSkipped> (已存在)
拷贝资产: <filesCopied> (新) / <filesSkipped> (已跳过,保留你的修改)
拷贝脚本: <scriptsWritten> (每次 init 覆盖写,含新增与升级)
顶层 md: <placeholdersCreated> 个占位文件
CLAUDE.md: <claudeMd.status>
错误: <errors.length>
```

新增边界段:

> vault/scripts/ 下脚本每次 init 都会**被覆盖**(plugin 升级同步语义);用户对脚本的本地修改会被覆盖丢失。资产 md(`00_模板/` / `10_schema/`)仍沿用 `copyIfMissing`,保留用户修改。

**4. 测试**

`scripts/init-vault.test.mjs` 新增 3 个 case:

1. 全新 vault → `scriptsWritten = 4`,且 vault/scripts/ 下 4 个文件都在
2. 已有 vault + 用户改过脚本 → `scriptsWritten = 4`(包含覆盖的那 1 个),且 vault/scripts/ 下全部 4 个文件与 pluginRoot 源一致(用户的本地修改**确实被覆盖**)
3. 缺一个脚本源 → `errors` 含 `kind: 'asset-missing'` 且 `src` 指向它,`exitCode = 3`,且其他 3 个脚本仍被拷贝

其他 `.test.mjs` **不动** —— 它们本就 chdir 到 tempdir vault 跑,行为不变。

**5. 不动的事项**

- `scripts/sync-pdf-notes.mjs` 等 4 个脚本的 `vault = process.cwd()` 默认行为**不变**
- SKILL.md `obsidian-collacting` 步骤 1–10 业务逻辑不变
- `00_模板/` / `10_schema/` 拷贝逻辑不变
- marketplace 仓 `f:\myself-marketplace\` 不动

### 风险

| 风险 | 缓解 |
|---|---|
| 用户机器 vault/scripts/ 与 plugin 升级漂移 | 覆盖语义保证已拷的脚本一定升级;**新增**脚本不会自动出现(因是白名单,常量需手动改) |
| 测试用临时 vault,不会污染用户机器 | 测试用 `fs.mkdtemp` 自清理,与现状一致 |
| 白名单漏拷某个脚本 | `SCRIPT_FILES` 是常量,加新脚本时必须改这里;code review 能看到 |

### 验收

1. `cd f:\llm-wiki-plugin && node scripts/init-vault.mjs <某个临时空目录>` → exitCode 0,vault 下有 `scripts/` + 4 个 mjs
2. 再次跑同一命令 → `scriptsWritten = 4`(覆盖,不是 0)
3. 从 vault 子目录(如 `vault/01_知识库/`)直接跑 `cd <vault> && node scripts/sync-pdf-notes.mjs --help` 不报错
4. `node --test scripts/init-vault.test.mjs` 全绿(原有用例 + 新 3 个)
5. SKILL.md `obsidian-collacting` 步骤 4 命令从 vault 根跑通,生成 PDF 笔记

### 不在范围

- 改 `vault = process.cwd()` 为按 `import.meta.url` 推导(避免动 4 个脚本 + 7+ 测试)
- 给 plugin 升级加自动 sync scripts 机制
- 拷 `*.test.mjs` 到 vault(明确不拷,白名单保证)
