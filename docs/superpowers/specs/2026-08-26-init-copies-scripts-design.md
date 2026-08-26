# Skill 脚本调用规范化 — init 时拷贝 scripts 到 vault

- **日期**: 2026-08-26
- **作者**: Claude (brainstorming 会话)
- **状态**: 待用户确认
- **影响范围**:
  - `scripts/init-vault.mjs` — 增加 scripts/ 拷贝逻辑
  - `scripts/init-vault.test.mjs` — 新增 3 个 case
  - `skills/obsidian-collacting/SKILL.md` — 顶部加执行前置约束
  - `skills/llm-wiki-plugin-init/SKILL.md` — 步骤 3 渲染报告加脚本行

## 背景与动机

现状问题:

1. SKILL.md `obsidian-collacting` 步骤 4 写 `node scripts/sync-pdf-notes.mjs --overwrite=false --source-field=source`,**依赖 cwd = vault 根**(`scripts/sync-pdf-notes.mjs:27` `vault = process.cwd()`)
2. 用户机器上 vault 目录里**根本没有 `scripts/`** —— scripts 只在 plugin 开发仓 `f:\llm-wiki-plugin\scripts\` 下存在
3. claude agent 在 vault 子目录里被触发、或通过 plugin loader 触发时,cwd 不一定是 vault 根 —— `scripts/...` 路径找不到就报 ENOENT
4. 已观察到:有时 skill 从工程目录(开发仓根)下去找脚本能找到,有时从用户实际 vault 目录下找不到 —— 表现就是"有时候从工程目录下去找脚本了"

目标:

- SKILL.md 调用脚本时**不依赖 cwd**,只要 vault 根下有 `scripts/` 就一定能跑通
- 用户机器上的 vault 与开发仓解耦:scripts 在 init 时被拷到 vault 里,自带自洽

## 方案

### 1. init-vault.mjs 增加脚本拷贝

新增常量:

```js
// 白名单:只拷 CLI 入口本身,不拷 *.test.mjs(测试不上用户机器)
export const SCRIPT_FILES = [
  'scripts/init-vault.mjs',
  'scripts/sync-pdf-notes.mjs',
  'scripts/check-update.mjs',
  'scripts/lint-wiki.mjs',
];
```

注:**白名单**,不扫整个目录 —— 防止 `*.test.mjs` 被误拷到用户 vault 里。

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

`counters` 新增字段:

```js
counters = {
  ...,
  scriptsWritten: 0,  // 总写入数(含覆盖)
};
```

错误处理复用现有 `asset-missing` / `copy-failed` kind —— **不新增 kind**,exitCode 优先级已能覆盖(3 类 / 4 类)。

**为什么覆盖(不沿用 copyIfMissing)**:
- scripts 是 plugin 行为载体,plugin 升级必须同步到 vault,否则新逻辑调不到
- 资产 md(模板/词表)是用户内容载体,用户可能改过 → 不覆盖(沿用 copyIfMissing)
- 两类资产策略不同,所以分两个步骤,counters 也分两个字段(`filesCopied/Skipped` 与 `scriptsWritten`)

### 2. SKILL.md `obsidian-collacting` — 顶部加执行前置约束

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

步骤 4 命令**保持原样**(依赖 cwd 已经满足):

```bash
node scripts/sync-pdf-notes.mjs --overwrite=false --source-field=source
```

### 3. SKILL.md `llm-wiki-plugin-init` — 步骤 3 渲染报告加脚本行

步骤 3 中文报告模板新增一行:

```text
vault: <vaultRoot>
创建目录: <dirsCreated> (新) / <dirsSkipped> (已存在)
拷贝资产: <filesCopied> (新) / <filesSkipped> (已跳过,保留你的修改)
拷贝脚本: <scriptsWritten> (每次 init 覆盖写,含新增与升级)
顶层 md: <placeholdersCreated> 个占位文件
CLAUDE.md: <claudeMd.status>
错误: <errors.length>
```

退出码表 / 资产清单 / 边界 不变,**新增**边界段一条(已在前面"拷贝策略"段说明语义,此处不重复):

> vault/scripts/ 下脚本每次 init 都会**被覆盖**(plugin 升级同步语义);用户对脚本的本地修改会被覆盖丢失。资产 md(`00_模板/` / `10_schema/`)仍沿用 `copyIfMissing`,保留用户修改。

### 4. 测试

`scripts/init-vault.test.mjs` 新增 3 个 case:

1. **全新 vault** → `scriptsWritten = 4`,且 vault/scripts/ 下 4 个文件都在
2. **已有 vault + 用户改过脚本**(手工预放一个脚本,内容是 `// user-modified`)→ `scriptsWritten = 4`(包含覆盖的那 1 个),且 vault/scripts/ 下**全部 4 个文件**与 pluginRoot 源一致(断言内容哈希 == 源哈希;用户的本地修改**确实被覆盖**)
3. **缺一个脚本源**(临时把 pluginRoot/scripts/sync-pdf-notes.mjs mv 走)→ `errors` 含 `kind: 'asset-missing'` 且 `src` 指向它,`exitCode = 3`,**且其他 3 个脚本仍被拷贝**

其他 `.test.mjs` **不动** —— 它们本就 chdir 到 tempdir vault 跑,行为不变。

### 5. 不动的事项

- `scripts/sync-pdf-notes.mjs` 等 4 个脚本的 `vault = process.cwd()` 默认行为**不变**
- SKILL.md `obsidian-collacting` 步骤 1–10 业务逻辑不变
- `00_模板/` / `10_schema/` 拷贝逻辑不变
- marketplace 仓 `f:\myself-marketplace\` 不动

## 风险

| 风险 | 缓解 |
|---|---|
| 用户机器 vault/scripts/ 与 plugin 升级漂移 | 覆盖语义保证已拷的脚本一定升级;**新增**脚本不会自动出现(因是白名单,常量需手动改) |
| 测试用临时 vault,不会污染用户机器 | 测试用 `fs.mkdtemp` 自清理,与现状一致 |
| 白名单漏拷某个脚本 | `SCRIPT_FILES` 是常量,加新脚本时必须改这里;code review 能看到 |

## 验收

1. `cd f:\llm-wiki-plugin && node scripts/init-vault.mjs <某个临时空目录>` → exitCode 0,vault 下有 `scripts/` + 4 个 mjs
2. 再次跑同一命令 → `scriptsWritten = 4`(覆盖,不是 0)
3. 从 vault 子目录(如 `vault/01_知识库/`)直接跑 `cd <vault> && node scripts/sync-pdf-notes.mjs --help` 不报错
4. `node --test scripts/init-vault.test.mjs` 全绿(原有用例 + 新 3 个)
5. SKILL.md `obsidian-collacting` 步骤 4 命令从 vault 根跑通,生成 PDF 笔记

## 不在范围

- 改 `vault = process.cwd()` 为按 `import.meta.url` 推导(避免动 4 个脚本 + 7+ 测试)
- 给 plugin 升级加自动 sync scripts 机制
- 拷 `*.test.mjs` 到 vault(明确不拷,白名单保证)
