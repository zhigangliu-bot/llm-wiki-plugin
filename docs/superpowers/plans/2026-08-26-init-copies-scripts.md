# init 拷贝 scripts 到 vault 实现 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `llm-wiki-plugin-init` 在初始化 vault 时把 plugin 仓根 `scripts/` 下 4 个白名单脚本(`init-vault.mjs` / `sync-pdf-notes.mjs` / `check-update.mjs` / `lint-wiki.mjs`)拷贝到 `<vault>/scripts/`,使 SKILL.md 调用 `node scripts/<name>.mjs ...` 时不再依赖 cwd = 开发仓根,用户机器上的 vault 与开发仓解耦。

**Architecture:** init-vault.mjs 增加常量 `SCRIPT_FILES` 与新步骤"覆盖写脚本到 vault 根";counters 新增 `scriptsWritten` 字段;SKILL.md `obsidian-collacting` 加顶部执行前置约束;SKILL.md `llm-wiki-plugin-init` 报告加脚本行。脚本与资产 md 走不同拷贝策略(脚本覆盖、资产 copyIfMissing),通过 step 3.5 独立实现。

**Tech Stack:** Node.js 22+ `node:fs/promises` / `node:test` / ESM `.mjs`。

**Spec:** [docs/superpowers/specs/2026-08-26-init-copies-scripts-design.md](../specs/2026-08-26-init-copies-scripts-design.md)

---

## File Structure

**Modify:**
- `scripts/init-vault.mjs` — 增加 `SCRIPT_FILES` 常量、`runInit` 第 3.5 步、`counters.scriptsWritten` 字段
- `scripts/init-vault.test.mjs` — 改 2 个现有 case(覆盖 `filesCopied/Skipped=4/0` 等) + 新增 3 个脚本拷贝 case
- `skills/obsidian-collacting/SKILL.md` — 在 `# 触发条件` 后插入 `# 执行前置(强制)` 段
- `skills/llm-wiki-plugin-init/SKILL.md` — 步骤 3 中文报告模板加 `拷贝脚本` 行;边界段加一条

**Not modified:**
- 其他 4 个 `*.test.mjs`(本就 chdir 到 tempdir vault 跑)
- 其他 4 个 `scripts/*.mjs` 代码
- `00_模板/` / `10_schema/` 拷贝逻辑
- marketplace 仓 `f:\myself-marketplace\`

---

## Task 1: 在 init-vault.mjs 增加 SCRIPT_FILES 常量

**Files:**
- Modify: `scripts/init-vault.mjs:75-99`(DIRECTORIES/TOP_LEVEL_MD/PLACEHOLDER_FILES 常量附近)

- [ ] **Step 1: 在 PLACEHOLDER_FILES 之后插入 SCRIPT_FILES 常量**

打开 [scripts/init-vault.mjs](scripts/init-vault.mjs),定位到:

```js
export const PLACEHOLDER_FILES = [
  'Inbox/.gitkeep',
  'Inbox/web_clipper/.gitkeep',
  '03_问答区/_cross/.gitkeep',
];
```

在 `PLACEHOLDER_FILES` 数组后(空行之后)插入:

```js

/* ===================== 脚本拷贝白名单(覆盖语义) ===================== */

/**
 * init 时拷贝到 <vault>/scripts/ 的脚本列表(白名单)。
 *
 * 策略:每次 init **覆盖** vault/scripts/ 已有同名文件(不复用 copyIfMissing),
 * 因为 scripts 是 plugin 行为载体,plugin 升级必须同步到 vault 才能生效。
 *
 * 不通配 scripts/ 整个目录,是为了防止 *.test.mjs 被误拷到用户 vault。
 */
export const SCRIPT_FILES = [
  'scripts/init-vault.mjs',
  'scripts/sync-pdf-notes.mjs',
  'scripts/check-update.mjs',
  'scripts/lint-wiki.mjs',
];
```

- [ ] **Step 2: 验证语法**

```bash
cd "f:/llm-wiki-plugin" && node --check scripts/init-vault.mjs
```

Expected: exit 0,无输出。

- [ ] **Step 3: Commit**

```bash
cd "f:/llm-wiki-plugin" && git add scripts/init-vault.mjs && git commit -m "feat(init-vault): add SCRIPT_FILES whitelist for plugin script copy"
```

---

## Task 2: 改 init-vault.mjs — counters 新增 scriptsWritten 字段

**Files:**
- Modify: `scripts/init-vault.mjs:209-217`(counters 初始化块)

- [ ] **Step 1: 在 counters 对象里追加 scriptsWritten 字段**

定位到 `runInit` 函数顶部:

```js
  const counters = {
    dirsCreated: 0,
    dirsSkipped: 0,
    filesCopied: 0,
    filesSkipped: 0,
    placeholdersCreated: 0,
    placeholdersSkipped: 0,
  };
```

在 `placeholdersSkipped: 0,` 之后加一行:

```js
    scriptsWritten: 0,
```

变成:

```js
  const counters = {
    dirsCreated: 0,
    dirsSkipped: 0,
    filesCopied: 0,
    filesSkipped: 0,
    placeholdersCreated: 0,
    placeholdersSkipped: 0,
    scriptsWritten: 0,
  };
```

- [ ] **Step 2: 验证语法**

```bash
cd "f:/llm-wiki-plugin" && node --check scripts/init-vault.mjs
```

Expected: exit 0,无输出。

- [ ] **Step 3: Commit**

```bash
cd "f:/llm-wiki-plugin" && git add scripts/init-vault.mjs && git commit -m "feat(init-vault): add scriptsWritten counter"
```

---

## Task 3: 改 init-vault.mjs — runInit 第 3.5 步覆盖写脚本

**Files:**
- Modify: `scripts/init-vault.mjs:241-261`(assetMap 拷贝步骤之后)

- [ ] **Step 1: 在 assetMap 拷贝循环之后、占位文件循环之前插入新步骤**

定位到 assetMap 拷贝结束(第 261 行附近,具体位置以文件实际内容为准——找 `// 4. 顶层 md + 占位文件` 这行注释):

```js
  // 4. 顶层 md + 占位文件
  for (const f of [...TOP_LEVEL_MD, ...PLACEHOLDER_FILES]) {
```

在 `// 4.` 注释**之前**插入:

```js
  // 3.5 拷贝脚本到 vault 根的 scripts/ 目录(直接覆盖,不沿用 copyIfMissing)
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
      await fs.copyFile(src, dst);
      counters.scriptsWritten += 1;
    } catch (e) {
      errors.push({ kind: 'copy-failed', src, dst, error: { code: e.code, message: e.message } });
    }
  }

```

- [ ] **Step 2: 验证语法**

```bash
cd "f:/llm-wiki-plugin" && node --check scripts/init-vault.mjs
```

Expected: exit 0,无输出。

- [ ] **Step 3: 手测一次,确认行为**

```bash
cd "f:/llm-wiki-plugin" && node -e "
import('./scripts/init-vault.mjs').then(async ({ runInit }) => {
  const { mkdtemp, rm, stat } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const t = await mkdtemp(join(tmpdir(), 'init-test-'));
  const r = await runInit({ vaultRoot: t });
  console.log(JSON.stringify(r, null, 2));
  await rm(t, { recursive: true, force: true });
});
"
```

Expected: 看到 `counters.scriptsWritten: 4`、`exitCode: 0`、`errors: []`,且报告里 `paths` 正常。

- [ ] **Step 4: Commit**

```bash
cd "f:/llm-wiki-plugin" && git add scripts/init-vault.mjs && git commit -m "feat(init-vault): overwrite-copy plugin scripts to vault/scripts/"
```

---

## Task 4: 改 init-vault.test.mjs — 现有 case 断言新增 scriptsWritten

**Files:**
- Modify: `scripts/init-vault.test.mjs:145-222`(5 个 runInit integration case)

- [ ] **Step 1: 在 "empty vault" case 加 scriptsWritten 断言**

定位到 `'empty vault: 10 dirs + 5 placeholders + 4 assets + CLAUDE.md created'` case,在 `assert.equal(report.claudeMd.status, 'created');` 之后追加:

```js
    assert.equal(report.counters.scriptsWritten, 4);
```

- [ ] **Step 2: 在 "half-init vault" case 加 scriptsWritten 断言**

定位到 `'half-init vault: ...'` case,在 `assert.equal(await readFile(...));` 那行之后追加:

```js
    assert.equal(report.counters.scriptsWritten, 4);  // 脚本总是覆盖写,与资产不同
```

- [ ] **Step 3: 在 "idempotent" case 加 scriptsWritten 断言**

定位到 `'idempotent: second runInit on same vault → ...'` case,在 `assert.equal(r2.counters.placeholdersSkipped, 5);` 之后追加:

```js
    assert.equal(r2.counters.scriptsWritten, 4);  // 第二次也覆盖写 4 个
```

- [ ] **Step 4: 跑测试,确认现有 5 个 case 全过**

```bash
cd "f:/llm-wiki-plugin" && node --test scripts/init-vault.test.mjs
```

Expected: 全绿(`# pass 12` 或更高;旧的 case 数 + 3 个新 case),无 fail。

- [ ] **Step 5: Commit**

```bash
cd "f:/llm-wiki-plugin" && git add scripts/init-vault.test.mjs && git commit -m "test(init-vault): assert scriptsWritten=4 across empty/half-init/idempotent cases"
```

---

## Task 5: 在 init-vault.test.mjs 新增 3 个脚本拷贝 case

**Files:**
- Modify: `scripts/init-vault.test.mjs`(在 `describe('runInit (integration)'` 块末尾、`'injectClaudeMd'` 之前)

- [ ] **Step 1: 找到 runInit describe 块结束位置**

定位到 `'03_问答区/ + _cross/.gitkeep created on empty vault'` case 结束的 `});`(在 describe('runInit (integration)' 内部最后一行,后面紧跟 `});` 关闭整个 describe 块)。在最后一个 `});` 之前、`describe('injectClaudeMd'...)` 之前,新增 3 个 test。

具体位置:在 `'03_问答区/ + _cross/.gitkeep created on empty vault'` case 末尾的 `});` 之后,空一行,插入:

```js

  test('copies 4 plugin scripts to vault/scripts/ on empty vault (scriptsWritten=4)', async () => {
    const vault = await makeVault('rs1');
    const report = await runInit({ vaultRoot: vault, pluginRoot: PLUGIN_ROOT });
    assert.equal(report.counters.scriptsWritten, 4);
    assert.equal(report.errors.length, 0);
    // 4 个文件确实存在
    for (const rel of [
      'scripts/init-vault.mjs',
      'scripts/sync-pdf-notes.mjs',
      'scripts/check-update.mjs',
      'scripts/lint-wiki.mjs',
    ]) {
      const s = await stat(join(vault, rel));
      assert.ok(s.isFile(), `${rel} must exist in vault/scripts/`);
    }
  });

  test('overwrites user-modified scripts in vault/scripts/ on re-init (no copyIfMissing)', async () => {
    const vault = await makeVault('rs2');
    // 用户手工预放一个"被改过"的脚本
    await mkdir(join(vault, 'scripts'), { recursive: true });
    await writeFile(join(vault, 'scripts/init-vault.mjs'), '// USER MODIFIED CONTENT', 'utf8');

    const report = await runInit({ vaultRoot: vault, pluginRoot: PLUGIN_ROOT });
    assert.equal(report.exitCode, 0);
    assert.equal(report.counters.scriptsWritten, 4);  // 含覆盖的那 1 个
    // 用户修改**确实被覆盖**(断言内容哈希 == 源哈希)
    const pluginSrc = await readFile(join(PLUGIN_ROOT, 'scripts/init-vault.mjs'), 'utf8');
    const vaultDst = await readFile(join(vault, 'scripts/init-vault.mjs'), 'utf8');
    assert.equal(vaultDst, pluginSrc, 'user-modified script must be overwritten by plugin source');
    assert.ok(!vaultDst.includes('USER MODIFIED CONTENT'), 'user content must be gone');
  });

  test('missing one plugin script source: exitCode 3 + asset-missing error, other 3 still copied', async () => {
    const vault = await makeVault('rs3');
    // 临时把 sync-pdf-notes.mjs 移走,模拟"plugin 资产缺失"
    const original = join(PLUGIN_ROOT, 'scripts/sync-pdf-notes.mjs');
    const stash = join(PLUGIN_ROOT, 'scripts/sync-pdf-notes.mjs.stash');
    const { rename } = await import('node:fs/promises');
    await rename(original, stash);
    try {
      const report = await runInit({ vaultRoot: vault, pluginRoot: PLUGIN_ROOT });
      assert.equal(report.exitCode, 3);  // asset-missing 优先于 copy-failed
      const err = report.errors.find((e) => e.kind === 'asset-missing');
      assert.ok(err, 'must have asset-missing error');
      assert.equal(err.src, original);
      // 其他 3 个脚本仍被拷贝
      assert.equal(report.counters.scriptsWritten, 3);
      assert.equal(
        await stat(join(vault, 'scripts/init-vault.mjs')).isFile(),
        true,
        'init-vault.mjs must still be copied'
      );
      assert.equal(
        await stat(join(vault, 'scripts/lint-wiki.mjs')).isFile(),
        true,
        'lint-wiki.mjs must still be copied'
      );
    } finally {
      // 还原:无论 case pass/fail 都要把脚本放回去,避免污染后续测试
      await rename(stash, original);
    }
  });
```

- [ ] **Step 2: 跑全部测试,确认新增 3 个 case 通过 + 旧 case 不回归**

```bash
cd "f:/llm-wiki-plugin" && node --test scripts/init-vault.test.mjs
```

Expected: 全绿(case 数 = 旧 12 + 新 3 = 15,pass 数对得上)。**注意 case 3 会 rename plugin 源文件,必须保证 try/finally 还原,否则会污染后续测试。**

- [ ] **Step 3: Commit**

```bash
cd "f:/llm-wiki-plugin" && git add scripts/init-vault.test.mjs && git commit -m "test(init-vault): cover SCRIPT_FILES copy/overwrite/missing-source cases"
```

---

## Task 6: 改 SKILL.md obsidian-collacting — 顶部加执行前置约束

**Files:**
- Modify: `skills/obsidian-collacting/SKILL.md`(在 `# 触发条件` 段后、`# Inbox 双源扫描` 段前)

- [ ] **Step 1: 打开文件,定位插入位置**

打开 [skills/obsidian-collacting/SKILL.md](skills/obsidian-collacting/SKILL.md),找到:

```
---

# 触发条件
```

与紧随其后的 `# Inbox 双源扫描` 段之间。

- [ ] **Step 2: 插入执行前置段**

在 `# Inbox 双源扫描` 段**之前**插入:

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

- [ ] **Step 3: 通读一次,确认 `node scripts/...` 命令本身**不变

用 Grep 工具查 `node scripts/`,确认步骤 4 / 步骤 4' 等命令**没有 `cd` 前缀也没有 `../../../scripts/` 跨层**,保持依赖"cwd 已是 vault 根"的前提。

- [ ] **Step 4: Commit**

```bash
cd "f:/llm-wiki-plugin" && git add skills/obsidian-collacting/SKILL.md && git commit -m "docs(skill): add 执行前置 constraint for node scripts/ invocations"
```

---

## Task 7: 改 SKILL.md llm-wiki-plugin-init — 报告加脚本行 + 边界补一条

**Files:**
- Modify: `skills/llm-wiki-plugin-init/SKILL.md`(步骤 3 报告模板 + 边界段)

- [ ] **Step 1: 在步骤 3 中文报告模板里加 `拷贝脚本` 行**

定位到:

```text
拷贝文件: <filesCopied> (新) / <filesSkipped> (已跳过,保留你的修改)
```

在它**之后**插入一行:

```text
拷贝脚本: <scriptsWritten> (每次 init 覆盖写,含新增与升级)
```

变成:

```text
拷贝文件: <filesCopied> (新) / <filesSkipped> (已跳过,保留你的修改)
拷贝脚本: <scriptsWritten> (每次 init 覆盖写,含新增与升级)
```

- [ ] **Step 2: 在边界段加一条**

定位到 `# 边界` 段(在 `不覆盖 vault 已存在的资产文件` 那条附近),在该段**末尾**(`幂等` 那条之后)追加一条:

```markdown
- 每次 init 都会**覆盖** vault/scripts/ 下已有脚本(plugin 升级同步语义);用户对脚本的本地修改会被覆盖丢失
```

- [ ] **Step 3: 通读全文,确认模板与边界一致**

打开文件核对:`拷贝脚本` 行与边界段新条目语义对齐(都是"覆盖"语义)。

- [ ] **Step 4: Commit**

```bash
cd "f:/llm-wiki-plugin" && git add skills/llm-wiki-plugin-init/SKILL.md && git commit -m "docs(skill): report scriptsWritten + boundary note on script overwrite"
```

---

## Task 8: 端到端验收

**Files:** 无修改

- [ ] **Step 1: 跑全部 init-vault 测试**

```bash
cd "f:/llm-wiki-plugin" && node --test scripts/init-vault.test.mjs
```

Expected: 全绿,15 个 case 全 pass。

- [ ] **Step 2: 跑其他脚本测试,确认无回归**

```bash
cd "f:/llm-wiki-plugin" && for f in scripts/*.test.mjs; do echo "--- $f ---"; node --test "$f"; done
```

Expected: 所有 `*.test.mjs` 全绿。

- [ ] **Step 3: 手测 init → 用户 vault → scripts 可调用**

```bash
cd "f:/llm-wiki-plugin" && node -e "
import('./scripts/init-vault.mjs').then(async ({ runInit }) => {
  const { mkdtemp, rm, stat } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const t = await mkdtemp(join(tmpdir(), 'e2e-'));
  await runInit({ vaultRoot: t });
  // 验证 scripts 4 个都在,且能从 vault 根调用
  const { execSync } = await import('node:child_process');
  const out = execSync('node scripts/init-vault.mjs --help 2>&1 || true', { cwd: t }).toString();
  console.log('called from vault root, output:', out.slice(0, 100));
  await rm(t, { recursive: true, force: true });
});
"
```

Expected: 看到从临时 vault 根调 `node scripts/init-vault.mjs` 不报 ENOENT(可能 exit 64 因无 vaultRoot 参数,但不报"找不到 scripts")。

- [ ] **Step 4: 最后一次 commit(如果 Step 1–3 有 leftover 改动)**

```bash
cd "f:/llm-wiki-plugin" && git status
```

如果有未 commit 改动:`git add -A && git commit -m "chore: post-verification cleanup"`。否则无需 commit。

---

## Self-Review Checklist(写完计划后自查)

- [x] Spec coverage:
  - §1 init-vault.mjs 拷贝逻辑 → Task 1 + Task 2 + Task 3
  - §2 SKILL.md obsidian-collacting 前置约束 → Task 6
  - §3 SKILL.md llm-wiki-plugin-init 报告 + 边界 → Task 7
  - §4 测试 3 个新 case → Task 5(全新 vault / 覆盖 / 缺源)
- [x] Placeholder scan: 无 TBD / "类似 Task N" / "实现 X" 无代码
- [x] Type consistency: `scriptsWritten` 在 Task 2 定义、Task 3 递增、Task 4/5 断言,命名一致
- [x] exitCode 语义保留:`asset-missing` → 3,`copy-failed` → 4,与 Task 3 错误 push 一致

---

## 验收(对应 spec §5)

1. ✅ `node scripts/init-vault.mjs <某个临时空目录>` → exitCode 0,vault 下有 `scripts/` + 4 个 mjs
2. ✅ 再次跑同一命令 → `scriptsWritten = 4`(覆盖)
3. ✅ 从 vault 子目录直接跑 `node scripts/sync-pdf-notes.mjs --help` 不报 ENOENT
4. ✅ `node --test scripts/init-vault.test.mjs` 全绿
5. ✅ SKILL.md obsidian-collacting 步骤 4 命令从 vault 根跑通

## 不在范围(对应 spec §6)

- 不改 `vault = process.cwd()` 默认行为
- 不加 plugin 升级自动 sync scripts 机制
- 不拷 `*.test.mjs` 到 vault
