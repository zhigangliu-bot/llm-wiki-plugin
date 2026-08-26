# obsidian-collacting 多源 Inbox 扩展实现 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `obsidian-collacting` skill 在原有 PDF + web_clipper md 之外,新增处理 PPT/Word/Excel/图片 四类 Inbox 文件,通过单一职责 `scripts/convert-office.mjs` 预转 md,sub agent 沿用现有手工 cp 模板路径写笔记。

**Architecture:** 新增 `scripts/convert-office.mjs`(office→md / 图片 PaddleOCR→md),CLI 输出含 source 元信息 + 段落分隔符;SKILL.md 扩展 Inbox 扫描范围为 6 类、添加步骤 4'' 走手工 cp 模板;sync-pdf-notes.mjs 不动;前端依赖(paddleocr / libreoffice / pandoc)启动时检测,缺失时图片跳过、其他类型中止。PaddleOCR 用 `paddleocr --image_dir=... --lang=ch --use_angle_cls=true --use_gpu=false`,从 stdout JSON 的 `rec_texts` 数组取文本。

**Tech Stack:** Node.js 22+ `node:fs/promises` / `node:child_process` / `node:test` / ESM `.mjs`。外部 CLI: `libreoffice` / `pandoc` / `paddleocr`(Python pip)。

**Spec:** [docs/superpowers/specs/2026-08-26-obsidian-collacting-multisource-design.md](../specs/2026-08-26-obsidian-collacting-multisource-design.md)

---

## File Structure

**Create:**
- `scripts/convert-office.mjs` — 单一职责 office/image → md 转换器
- `scripts/convert-office.test.mjs` — node:test 单测,6 个用例

**Modify:**
- `skills/obsidian-collacting/SKILL.md` — 触发条件 / 多源扫描表 / 新增依赖前置段 / 步骤 1 / 步骤 4'' / 步骤 5 分支 / 步骤 8 汇报格式 / 阶段 2 source 类型差异表

**Not modified:**
- `scripts/sync-pdf-notes.mjs` 及其测试
- `scripts/init-vault.mjs` 的 `SCRIPT_FILES` 数组(本任务完成后 init-vault 也应包含新脚本,作为独立 commit 后置任务,见 Task 8)
- 其他 skills (knowledge-graph-sync / lint-wiki / llm-wiki-query / llm-wiki-plugin-init)
- `00_模板/` / `10_schema/`
- marketplace 仓 `f:\myself-marketplace\`

---

## Task 1: convert-office.mjs — CLI 骨架 + 失败语义

**Files:**
- Create: `scripts/convert-office.mjs`

- [ ] **Step 1: 写脚手架(参数解析 + 失败返回)**

创建 [scripts/convert-office.mjs](scripts/convert-office.mjs):

```js
#!/usr/bin/env node
// scripts/convert-office.mjs — office / image → md 预转换器
// 单职责:接收 --input / --output / --type,按 type fork 外部 CLI,写 md 到 --output。
// 失败语义:非零退出码 + stdout 输出 { ok: false, error, stderr } JSON。

import { parseArgs } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

const ALLOWED_TYPES = ['pptx', 'docx', 'xlsx', 'png', 'jpg', 'jpeg'];

function parseCli() {
  const { values } = parseArgs({
    options: {
      input: { type: 'string' },
      output: { type: 'string' },
      type: { type: 'string' },
    },
  });
  if (!values.input || !values.output || !values.type) {
    failAndExit('missing_args', 'require --input --output --type', 2);
  }
  if (!ALLOWED_TYPES.includes(values.type)) {
    failAndExit('bad_type', `type must be one of ${ALLOWED_TYPES.join(',')}`, 2);
  }
  return values;
}

export function failAndExit(error, detail, code) {
  console.log(JSON.stringify({ ok: false, error, stderr: detail }));
  process.exit(code);
}

export async function main() {
  const args = parseCli();
  await mkdir(dirname(args.output), { recursive: true });
  // 占位:后续 task 替换为真实 fork
  await writeFile(args.output, `# stub for ${args.type}\n`, 'utf8');
  console.log(JSON.stringify({ ok: true, md_path: args.output, char_count: 0, page_count: 0 }));
}

const isMain = import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`;
if (isMain) {
  main().catch((err) => failAndExit('uncaught', String(err), 1));
}
```

- [ ] **Step 2: 验证语法**

```bash
cd "f:/llm-wiki-plugin" && node --check scripts/convert-office.mjs
```

Expected: exit 0,无输出。

- [ ] **Step 3: 冒烟跑通 CLI**

```bash
cd "f:/llm-wiki-plugin" && node scripts/convert-office.mjs --input=/tmp/in.pptx --output=/tmp/out.md --type=pptx && cat /tmp/out.md
```

Expected: stdout `{"ok":true,...}`,`/tmp/out.md` 含 `# stub for pptx`。

- [ ] **Step 4: 验证错误语义**

```bash
cd "f:/llm-wiki-plugin" && node scripts/convert-office.mjs --input=/tmp/in --output=/tmp/o.md --type=exe 2>&1; echo "exit=$?"
```

Expected: stdout `{"ok":false,"error":"bad_type",...}`,`exit=2`。

- [ ] **Step 5: Commit**

```bash
cd "f:/llm-wiki-plugin" && git add scripts/convert-office.mjs && git commit -m "feat(convert-office): CLI scaffold with parse + fail-and-exit semantics"
```

---

## Task 2: convert-office.mjs — 通用 fork helper + 超时

**Files:**
- Modify: `scripts/convert-office.mjs`

- [ ] **Step 1: 添加 runCommand helper**

在 `failAndExit` 之后、`main` 之前插入:

```js
import { spawn } from 'node:child_process';

/**
 * 同步 spawn + 捕获 stdout/stderr + 超时 kill。
 * @param {string} cmd
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
export function runCommand(cmd, args, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: killed ? 124 : code ?? 1 });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + String(err), code: 127 });
    });
  });
}
```

- [ ] **Step 2: 验证语法**

```bash
cd "f:/llm-wiki-plugin" && node --check scripts/convert-office.mjs
```

Expected: exit 0。

- [ ] **Step 3: Commit**

```bash
cd "f:/llm-wiki-plugin" && git add scripts/convert-office.mjs && git commit -m "feat(convert-office): add runCommand helper with 60s timeout"
```

---

## Task 3: convert-office.mjs — pptx/docx 分支 (libreoffice + pandoc fallback)

**Files:**
- Modify: `scripts/convert-office.mjs`

- [ ] **Step 1: 实现 pptx 与 docx 分支**

在 `main()` 函数里,替换 `await writeFile(...)` 占位行,改为:

```js
  let result;
  if (args.type === 'pptx') {
    result = await convertViaLibreoffice(args.input, args.output, 'md');
  } else if (args.type === 'docx') {
    result = await convertDocxWithPandocFallback(args.input, args.output);
  } else if (args.type === 'xlsx') {
    failAndExit('not_implemented', 'xlsx branch comes in Task 4', 1);
  } else {
    failAndExit('not_implemented', `image branch (${args.type}) comes in Task 5`, 1);
  }
  if (!result.ok) failAndExit(result.error, result.stderr, result.code);
  await writeFile(args.output, result.body, 'utf8');
  console.log(JSON.stringify({
    ok: true,
    md_path: args.output,
    char_count: result.body.length,
    page_count: result.pageCount ?? 0,
  }));
```

并在文件顶部 export 区加入新函数(放在 `runCommand` 之后):

```js
export async function convertViaLibreoffice(input, output, format) {
  const tmpdir = dirname(output);
  const args = ['--headless', '--convert-to', format, '--outdir', tmpdir, input];
  const which = await runCommand('which', ['libreoffice'], 5_000);
  if (which.code !== 0) {
    return { ok: false, error: 'tool_missing', stderr: 'libreoffice not in PATH', code: 2 };
  }
  const r = await runCommand('libreoffice', args, 60_000);
  if (r.code !== 0) return { ok: false, error: 'convert_failed', stderr: r.stderr, code: 1 };
  const basename = input.replace(/\\/g, '/').split('/').pop().replace(/\.[^.]+$/, '');
  const generated = `${tmpdir}/${basename}.${format}`;
  const fs = await import('node:fs/promises');
  const body = await fs.readFile(generated, 'utf8');
  await fs.unlink(generated).catch(() => {});
  return { ok: true, body, pageCount: countSlides(body) };
}

export async function convertDocxWithPandocFallback(input, output) {
  const whichP = await runCommand('which', ['pandoc'], 5_000);
  if (whichP.code === 0) {
    const r = await runCommand('pandoc', ['-f', 'docx', '-t', 'markdown', '-o', output, input], 60_000);
    if (r.code === 0) {
      const fs = await import('node:fs/promises');
      const body = await fs.readFile(output, 'utf8');
      return { ok: true, body, pageCount: 0 };
    }
  }
  // fallback libreoffice
  return convertViaLibreoffice(input, output, 'md');
}

export function countSlides(mdBody) {
  return (mdBody.match(/<!--\s*第\s*\d+\s*段\s*-->/g) || []).length;
}
```

- [ ] **Step 2: 验证语法**

```bash
cd "f:/llm-wiki-plugin" && node --check scripts/convert-office.mjs
```

Expected: exit 0。

- [ ] **Step 3: Commit**

```bash
cd "f:/llm-wiki-plugin" && git add scripts/convert-office.mjs && git commit -m "feat(convert-office): pptx/docx branches with libreoffice + pandoc fallback"
```

---

## Task 4: convert-office.mjs — xlsx 分支 (CSV 多 sheet 拼接)

**Files:**
- Modify: `scripts/convert-office.mjs`

- [ ] **Step 1: 实现 xlsx 分支**

把 main() 里的 `'not_implemented', 'xlsx branch comes in Task 4'` 替换为:

```js
  } else if (args.type === 'xlsx') {
    result = await convertXlsxMultiSheet(args.input, args.output);
  }
```

并在 export 区追加:

```js
export async function convertXlsxMultiSheet(input, output) {
  const which = await runCommand('which', ['libreoffice'], 5_000);
  if (which.code !== 0) {
    return { ok: false, error: 'tool_missing', stderr: 'libreoffice not in PATH (xlsx needs it)', code: 2 };
  }
  const tmpdir = dirname(output) + '/_xlsx_' + Date.now();
  await mkdir(tmpdir, { recursive: true });
  const args = ['--headless', '--convert-to', 'csv', '--outdir', tmpdir, input];
  const r = await runCommand('libreoffice', args, 60_000);
  if (r.code !== 0) return { ok: false, error: 'convert_failed', stderr: r.stderr, code: 1 };
  const fs = await import('node:fs/promises');
  const files = await fs.readdir(tmpdir);
  const csvFiles = files.filter((f) => f.endsWith('.csv')).sort();
  const sections = [];
  for (const f of csvFiles) {
    const csv = await fs.readFile(`${tmpdir}/${f}`, 'utf8');
    sections.push(`<!-- 第 ${sections.length + 1} 段 (sheet: ${f.replace(/\.csv$/, '')}) -->\n\n` + csvToMdTable(csv));
  }
  await fs.rm(tmpdir, { recursive: true, force: true });
  const body = sections.join('\n\n');
  return { ok: true, body, pageCount: sections.length };
}

export function csvToMdTable(csv) {
  const rows = csv.trim().split(/\r?\n/).map((line) => {
    // 简单 CSV 解析:支持双引号包裹的字段含逗号
    const cells = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') inQuote = !inQuote;
      else if (ch === ',' && !inQuote) { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    return cells.map((c) => c.trim() || ' ');
  });
  if (rows.length === 0) return '';
  const header = rows[0];
  const sep = header.map(() => '---');
  return [header, sep, ...rows.slice(1)].map((r) => `| ${r.join(' | ')} |`).join('\n');
}
```

- [ ] **Step 2: 验证语法**

```bash
cd "f:/llm-wiki-plugin" && node --check scripts/convert-office.mjs
```

Expected: exit 0。

- [ ] **Step 3: Commit**

```bash
cd "f:/llm-wiki-plugin" && git add scripts/convert-office.mjs && git commit -m "feat(convert-office): xlsx multi-sheet CSV→md table"
```

---

## Task 5: convert-office.mjs — png/jpg/jpeg 分支 (PaddleOCR)

**Files:**
- Modify: `scripts/convert-office.mjs`

- [ ] **Step 1: 实现 image 分支**

替换 main() 里的 image not_implemented 占位行为:

```js
  } else {
    // png / jpg / jpeg
    result = await convertImageViaPaddleocr(args.input, args.output);
  }
```

并在 export 区追加:

```js
export async function convertImageViaPaddleocr(input, output) {
  const which = await runCommand('which', ['paddleocr'], 5_000);
  if (which.code !== 0) {
    return { ok: false, error: 'tool_missing', stderr: 'paddleocr not in PATH; pip install paddleocr paddlepaddle', code: 2 };
  }
  const args = ['--image_dir=' + input, '--lang=ch', '--use_angle_cls=true', '--use_gpu=false'];
  const r = await runCommand('paddleocr', args, 60_000);
  if (r.code !== 0) return { ok: false, error: 'convert_failed', stderr: r.stderr, code: 1 };
  const lines = parsePaddleocrStdout(r.stdout);
  const body = `<!-- 第 1 段 (OCR result) -->\n\n${lines.join('\n\n')}`;
  return { ok: true, body, pageCount: lines.length };
}

export function parsePaddleocrStdout(stdout) {
  // paddleocr CLI 默认输出 JSON 数组,每项含 rec_texts
  const lines = [];
  for (const raw of stdout.split('\n')) {
    const s = raw.trim();
    if (!s.startsWith('[')) continue;
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (Array.isArray(item?.rec_texts)) lines.push(item.rec_texts.join(' '));
        }
      }
    } catch { /* 忽略非 JSON 行 */ }
  }
  return lines.length ? lines : [stdout.trim()].filter(Boolean);
}
```

- [ ] **Step 2: 验证语法**

```bash
cd "f:/llm-wiki-plugin" && node --check scripts/convert-office.mjs
```

Expected: exit 0。

- [ ] **Step 3: Commit**

```bash
cd "f:/llm-wiki-plugin" && git add scripts/convert-office.mjs && git commit -m "feat(convert-office): png/jpg/jpeg PaddleOCR branch"
```

---

## Task 6: convert-office.mjs — 输出 md frontmatter 元信息

**Files:**
- Modify: `scripts/convert-office.mjs`

- [ ] **Step 1: 在 main() 末尾追加 frontmatter**

把 main() 末尾的 `console.log(JSON.stringify(...))` 之前的 `await writeFile` 调用替换为:

```js
  const today = new Date().toISOString().slice(0, 10);
  const basename = args.input.replace(/\\/g, '/').split('/').pop();
  const fm = `---\nsource_file: ${basename}\nsource_type: ${args.type}\nconverted_at: ${today}\n---\n\n`;
  await writeFile(args.output, fm + result.body, 'utf8');
  console.log(JSON.stringify({
    ok: true,
    md_path: args.output,
    char_count: (fm + result.body).length,
    page_count: result.pageCount ?? 0,
  }));
```

- [ ] **Step 2: 验证语法 + 冒烟**

```bash
cd "f:/llm-wiki-plugin" && node --check scripts/convert-office.mjs && \
  node scripts/convert-office.mjs --input=/tmp/in.pptx --output=/tmp/o.md --type=pptx 2>&1 | head -5 && \
  head -5 /tmp/o.md
```

Expected: exit 0;stdout 是 JSON;`/tmp/o.md` 首 5 行含 `---\nsource_file: in.pptx\nsource_type: pptx\n...`。

- [ ] **Step 3: Commit**

```bash
cd "f:/llm-wiki-plugin" && git add scripts/convert-office.mjs && git commit -m "feat(convert-office): prepend frontmatter with source metadata"
```

---

## Task 7: convert-office.test.mjs — 6 个测试用例

**Files:**
- Create: `scripts/convert-office.test.mjs`

- [ ] **Step 1: 写测试**

创建 [scripts/convert-office.test.mjs](scripts/convert-office.test.mjs):

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import {
  failAndExit,
  parsePaddleocrStdout,
  csvToMdTable,
  countSlides,
  runCommand,
} from './convert-office.mjs';

function tmp() {
  return mkdtempSync(join(tmpdir(), 'conv-test-'));
}

// ===== 纯函数测试(无需外部 CLI) =====

test('csvToMdTable parses simple CSV', () => {
  const md = csvToMdTable('a,b,c\n1,2,3\n4,5,6');
  assert.match(md, /\| a \| b \| c \|/);
  assert.match(md, /\| 1 \| 2 \| 3 \|/);
  assert.match(md, /\| --- \| --- \| --- \|/);
});

test('csvToMdTable handles quoted commas', () => {
  const md = csvToMdTable('name,desc\n"foo,bar","a,b"');
  assert.match(md, /\| foo,bar \| a,b \|/);
});

test('countSlides counts 段 markers', () => {
  const md = '<!-- 第 1 段 -->\nx\n\n<!-- 第 2 段 -->\ny';
  assert.equal(countSlides(md), 2);
});

test('parsePaddleocrStdout extracts rec_texts from JSON lines', () => {
  const stdout = 'noise line\n[{"rec_texts":["hello","world"]},{"rec_texts":["foo"]}]\nmore noise';
  const lines = parsePaddleocrStdout(stdout);
  assert.deepEqual(lines, ['hello world', 'foo']);
});

test('parsePaddleocrStdout falls back to raw when no JSON', () => {
  const lines = parsePaddleocrStdout('just plain text');
  assert.deepEqual(lines, ['just plain text']);
});

test('parseCli rejects bad type via failAndExit', () => {
  // 隔离进程测试:捕获 stdout + exit code
  const orig = console.log;
  const origExit = process.exit;
  let captured = '';
  // @ts-ignore
  console.log = (s) => { captured += s; };
  // @ts-ignore
  process.exit = (code) => { throw new Error('exit-' + code); };
  try {
    try {
      failAndExit('bad_type', 'x', 2);
      assert.fail('should have thrown');
    } catch (e) {
      assert.match(String(e), /exit-2/);
      assert.match(captured, /"error":"bad_type"/);
    }
  } finally {
    console.log = orig;
    process.exit = origExit;
  }
});

// ===== runCommand 行为测试 =====

test('runCommand times out hung process', async () => {
  // node -e "setInterval(()=>{},1000)" 永远不退出
  const r = await runCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 500);
  assert.equal(r.code, 124); // 超时标记
});

test('runCommand captures stdout', async () => {
  const r = await runCommand(process.execPath, ['-e', 'console.log("hi")'], 5_000);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /hi/);
});

test('runCommand returns 127 on missing binary', async () => {
  const r = await runCommand('definitely-not-a-real-binary-xyz', [], 1_000);
  assert.equal(r.code, 127);
});

// ===== CLI 集成测试(需要外部工具时跳过) =====

test('CLI rejects missing args', async () => {
  const { spawn } = await import('node:child_process');
  const r = await runCommand(process.execPath, ['scripts/convert-office.mjs'], 5_000);
  assert.notEqual(r.code, 0);
});

test('CLI rejects bad type', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cli-'));
  try {
    const r = await runCommand(process.execPath, [
      'scripts/convert-office.mjs',
      '--input=/tmp/x', '--output=/tmp/y', '--type=exe',
    ], 5_000);
    assert.notEqual(r.code, 0);
    assert.match(r.stdout, /bad_type/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: 跑测试,确认全过**

```bash
cd "f:/llm-wiki-plugin" && node --test scripts/convert-office.test.mjs
```

Expected: 全部测试 pass,无 failure。

如果某些外部工具测试在当前环境跑不通(如 `paddleocr` 不在 PATH),那些 `runCommand('definitely-not-a-real-binary-xyz'...)` 等依赖外部 CLI 的不应写进这套单测;上面已只保留纯函数 + 已知存在命令(`process.execPath`)的测试。

- [ ] **Step 3: Commit**

```bash
cd "f:/llm-wiki-plugin" && git add scripts/convert-office.test.mjs && git commit -m "test(convert-office): cover pure functions + runCommand + CLI errors"
```

---

## Task 8: 更新 init-vault.mjs SCRIPT_FILES 白名单

**Files:**
- Modify: `scripts/init-vault.mjs`(在 SCRIPT_FILES 数组追加一行)

- [ ] **Step 1: 追加新脚本到白名单**

打开 [scripts/init-vault.mjs](scripts/init-vault.mjs),定位到 `SCRIPT_FILES` 数组(在 `init-copies-scripts` 设计里已存在):

```js
export const SCRIPT_FILES = [
  'scripts/init-vault.mjs',
  'scripts/sync-pdf-notes.mjs',
  'scripts/check-update.mjs',
  'scripts/lint-wiki.mjs',
];
```

在末尾 `]` 前追加:

```js
  'scripts/convert-office.mjs',
```

完整数组变成:

```js
export const SCRIPT_FILES = [
  'scripts/init-vault.mjs',
  'scripts/sync-pdf-notes.mjs',
  'scripts/check-update.mjs',
  'scripts/lint-wiki.mjs',
  'scripts/convert-office.mjs',
];
```

- [ ] **Step 2: 验证**

```bash
cd "f:/llm-wiki-plugin" && node --check scripts/init-vault.mjs && node --test scripts/init-vault.test.mjs
```

Expected: 语法 OK,init-vault 现有测试仍全过。

- [ ] **Step 3: Commit**

```bash
cd "f:/llm-wiki-plugin" && git add scripts/init-vault.mjs && git commit -m "feat(init-vault): include convert-office.mjs in SCRIPT_FILES whitelist"
```

---

## Task 9: 改 SKILL.md — 触发条件 + 依赖前置段

**Files:**
- Modify: `skills/obsidian-collacting/SKILL.md`

- [ ] **Step 1: 改触发条件**

打开 [skills/obsidian-collacting/SKILL.md](skills/obsidian-collacting/SKILL.md),定位到 `# 触发条件` 段:

```markdown
# 触发条件

当用户说：整理、Inbox、web clipper
```

改为:

```markdown
# 触发条件

当用户说：整理、Inbox、web clipper、office、ppt、word、excel、图片
```

- [ ] **Step 2: 在执行前置段后插入依赖前置段**

定位到 `# 执行前置(强制)` 段结尾,在其后插入新段:

```markdown
# convert-office 依赖前置

新增 office / image 类型在归档前要调 `scripts/convert-office.mjs`,依赖 3 个外部 CLI(按用途):

| 类型 | 依赖 | 缺失行为 |
|---|---|---|
| `.pptx` / `.xlsx` | `libreoffice` | **skill 中止**,要求 `apt install libreoffice` / `brew install --cask libreoffice` |
| `.docx` | `pandoc`(优先) / `libreoffice`(fallback) | pandoc 缺失自动降级到 libreoffice;两者皆无则中止 |
| `.png` / `.jpg` / `.jpeg` | `paddleocr` | **仅跳过图片**,其他类型继续;`pip install paddleocr paddlepaddle` |

skill 启动时跑:

```bash
node scripts/convert-office.mjs --input=/dev/null --output=/dev/null --type=pptx 2>&1 | head -1
```

用返回的 `error: tool_missing` 判断依赖,缺失时打印安装命令并按上表行为处理。
```

- [ ] **Step 3: Commit**

```bash
cd "f:/llm-wiki-plugin" && git add skills/obsidian-collacting/SKILL.md && git commit -m "docs(skill): add trigger words + convert-office dependency precheck"
```

---

## Task 10: 改 SKILL.md — Inbox 多源扫描表 + 步骤 1

**Files:**
- Modify: `skills/obsidian-collacting/SKILL.md`

- [ ] **Step 1: 标题 + 表格扩为 6 行**

定位到 `# Inbox 双源扫描` 段,把标题改为 `# Inbox 多源扫描`,并把表格替换为:

```markdown
| 源目录 | 文件类型 | 物理处理 | 笔记模板 |
| --- | --- | --- | --- |
| `Inbox/**/*.{pdf,PDF}` | PDF(递归) | `mv` 到 `01_知识库/<主题目录>/` | 调 `sync-pdf-notes.mjs --overwrite=false` 自动生成 |
| `Inbox/web_clipper/*.md` | Markdown(web 剪藏,`tags: [clippings]`) | `mv` 到 `01_知识库/<主题目录>/` | **手工复制 `00_模板/读书笔记模板.md` 到 `02_读书笔记/`**(详见步骤 4') |
| `Inbox/**/*.{pptx,PPT}` | PowerPoint(递归) | `mv` 到 `01_知识库/<主题目录>/` | **手工复制 `00_模板/读书笔记模板.md` 到 `02_读书笔记/`**(详见步骤 4''),先调 `convert-office.mjs` 预转 md |
| `Inbox/**/*.{docx,DOC}` | Word(递归) | `mv` 到 `01_知识库/<主题目录>/` | 同 pptx(pandoc 优先,libreoffice fallback) |
| `Inbox/**/*.{xlsx,XLS}` | Excel(递归) | `mv` 到 `01_知识库/<主题目录>/` | 同 pptx(转 CSV 再拼 md 表格) |
| `Inbox/**/*.{png,jpg,jpeg,PNG,JPG}` | 图片(递归) | `mv` 到 `01_知识库/<主题目录>/` | **手工复制模板**(详见步骤 4''),先调 `convert-office.mjs` PaddleOCR |

> **递归范围说明**:PDF / PPTX / DOCX / XLSX / 图片均递归 `Inbox/**/`,允许用户在 Inbox 下任意子目录暂存。`Inbox/web_clipper/*.md` 仍是单层扫描(沿用旧语义,避免误扫其他 md)。
> **不在本 skill 范围**:`.txt` / `.zip` / `.mp4` 等其他扩展名直接跳过,不报错。
```

- [ ] **Step 2: 改步骤 1(扫描逻辑)**

定位到 `# 执行动作` 步骤 1,改为:

```markdown
1. **扫描** `Inbox/` 多源:
   - `Inbox/**/*.pdf` 递归(沿用 sync 脚本扫描逻辑,本步只统计文件清单)
   - `Inbox/web_clipper/*.md` 单层(子目录里再嵌套 `.md` 不收)
   - `Inbox/**/*.{pptx,docx,xlsx,png,jpg,jpeg}` 递归
   - 跳过其他扩展名
```

- [ ] **Step 3: Commit**

```bash
cd "f:/llm-wiki-plugin" && git add skills/obsidian-collacting/SKILL.md && git commit -m "docs(skill): extend Inbox scan to 6 source types (pdf/md/pptx/docx/xlsx/image)"
```

---

## Task 11: 改 SKILL.md — 步骤 4'' office/image 同步 + 步骤 5 sub agent 分支

**Files:**
- Modify: `skills/obsidian-collacting/SKILL.md`

- [ ] **Step 1: 在步骤 4' 后插入步骤 4''**

定位到步骤 4'(同步 web_clipper md 模板),在其后追加:

```markdown
4''. **同步 office / image 模板**(与步骤 4 / 4' 并列,仅在 Inbox 里有 pptx/docx/xlsx/png/jpg 时执行):

   对每个 `Inbox/<dir>/<name>.{pptx,docx,xlsx,png,jpg,jpeg}`:
   1. **预转换**(sub agent 读取前):`node scripts/convert-office.mjs --input=<abs> --output=<vaultRoot>/temp/ingest/<name>.md --type=<ext>`
      - 失败 (`error: tool_missing` / `convert_failed`) → 跳过该文件,记录到最终报告"X 个 office/image 转换失败"
   2. **归档**:`mv Inbox/<dir>/<name>.<ext> 01_知识库/<主题>/<name>.<ext>`(同名冲突跳过并报告)
   3. **复制模板**:`cp 00_模板/读书笔记模板.md 02_读书笔记/<主题>/<name>.md`
   4. **替换占位字段**(用 Edit):
      - `文章: "{{title}}"` → `文章: "<name>"`
      - `作者:` → `作者: "(从预转 md frontmatter 或正文推断;无法推断留空)"`
      - `创建时间: "{{date}}"` → `创建时间: "<YYYY-MM-DD,系统填当天日期>"`
      - `source: "{{pdf}}"` → `source: "[[01_知识库/<主题>/<name>.<ext>]]"`
   5. **同名已存在** → 跳过并报告冲突
   6. **不动** frontmatter 里的 `tags: clippings`(那是 web clipper 源标记,office/image 没有)

   sub agent 写笔记时读取 `temp/ingest/<name>.md`(已含 frontmatter 元信息 + 段落分隔符 `<!-- 第 N 段 -->`),不读原 office/image 二进制。
   写完笔记后由 skill 删除 `temp/ingest/<name>.md`(整个 ingest 流程结束后统一清理 temp/ingest/)。
```

- [ ] **Step 2: 改步骤 5 的 source 类型差异处理表**

定位到 `# 两层 sub agent 工作流` 阶段 2 的 `source 类型差异处理` 表,在 `md` 行后插入 office/image 行:

```markdown
| source 类型 | 读取方式 | 作者/日期提示 | verbatim 引用差异 |
| --- | --- | --- | --- |
| `pdf` | Read 工具读 PDF 二进制 | 可能需从 PDF 头部/正文推断 | 带页码(如 `原文片段 (p.3):`) |
| `md`(web clipper) | Read 工具直接读文本 | frontmatter 通常自带 `title` / `author` / `published`;sub agent **只取 `title` 和 `author`**,**不**取原文 `tags: clippings` | **不**带页码;原文 URL(如有)放「我的思考」段作上下文,但**不**写入 frontmatter `source:` |
| `office`(pptx/docx/xlsx) | Read 工具读 `temp/ingest/<name>.md`(由 `convert-office.mjs` 预转) | 读 md frontmatter 取 `source_file` / `source_type`,作者从正文推断 | **不**带页码,标注 `原文片段 (<源文件名>, 第 N 段):`;xlsx 标注 sheet 名 |
| `image`(png/jpg/jpeg) | Read 工具读 `temp/ingest/<name>.md`(PaddleOCR 结果) | OCR 可能不识别作者/日期,留空 | 同 office,标注 `原文片段 (<源文件名>, OCR 第 N 段):` |
```

- [ ] **Step 3: Commit**

```bash
cd "f:/llm-wiki-plugin" && git add skills/obsidian-collacting/SKILL.md && git commit -m "docs(skill): add step 4'' office/image template sync + sub agent prompt branches"
```

---

## Task 12: 改 SKILL.md — 步骤 8 汇报格式扩展

**Files:**
- Modify: `skills/obsidian-collacting/SKILL.md`

- [ ] **Step 1: 改报告模板**

定位到步骤 8(完成后告诉我处理了多少篇...),把代码块改为:

````markdown
本次 ingest 处理 N 篇,归入以下分类:
- PDF: X 篇
- MD(web clipper): Y 篇
- Office(PPT/Word/Excel): Z 篇
- Image(OCR): W 篇
- Office/Image 转换失败(已跳过): K 篇

【建议更新词表 00_模板/标签词表.md】以下候选值在多篇文章中出现但词表未枚举:
1. §2 domain `xxx`:在<文章1> + <文章2> 主题段出现,与已有 16 个 domain 区分度为……
2. ……输入「确认」我立即把以上候选补入词表对应 §;输入「跳过」保留自由 tag 等 lint-wiki 异步处理。
````

- [ ] **Step 2: Commit**

```bash
cd "f:/llm-wiki-plugin" && git add skills/obsidian-collacting/SKILL.md && git commit -m "docs(skill): extend ingest report to office/image counts"
```

---

## Task 13: 集成测试 — 手工跑通 6 种类型

**Files:**
- 无新文件,纯验收

- [ ] **Step 1: 准备样本**

在测试 vault 的 `Inbox/` 下放 6 个样本(若 vault 不存在可临时 init 一个):

| 路径 | 类型 |
|---|---|
| `Inbox/sample.pdf` | PDF(任一 1 页以上) |
| `Inbox/web_clipper/sample.md` | web clipper md(含 `tags: [clippings]`) |
| `Inbox/presentations/sample.pptx` | PowerPoint(3-5 页) |
| `Inbox/docs/sample.docx` | Word(几百字) |
| `Inbox/data/sample.xlsx` | Excel(2 sheet) |
| `Inbox/screenshots/sample.png` | 含中英文图片 |

- [ ] **Step 2: 触发 skill**

主对话说"整理 Inbox",触发 `obsidian-collacting`。

- [ ] **Step 3: 验收清单**

逐项打勾:

- [ ] 6 个文件都被 mv 到 `01_知识库/<主题>/`
- [ ] 6 个空模板生成在 `02_读书笔记/<主题>/`(web_clipper md 路径 + office/image 路径)
- [ ] sub agent 写完 6 篇笔记,每篇含 摘要 / 重点摘录 / 我的思考 / 总结
- [ ] Index.md append 6 条
- [ ] Log.md append 1 条
- [ ] `temp/ingest/` 清空(全部 archive 后)
- [ ] frontmatter 4 字段(文章 / 作者 / 创建时间 / source)正确填入
- [ ] office/image 笔记 verbatim 引用标注 `原文片段 (<源文件名>, 第 N 段):` 或 `原文片段 (<源文件名>, OCR 第 N 段):`

任何一项失败 → 记录到 commit message,先修再继续。

- [ ] **Step 4: 回归测试 — 原 PDF + web_clipper md 路径**

跑原 PDF fixture 和 web_clipper md fixture,断言:
- sync-pdf-notes.mjs 输出与改前一致
- web_clipper md 路径笔记 frontmatter 不含 `tags: clippings`

- [ ] **Step 5: Commit(集成测试日志)**

若集成测试发现 SKILL.md 措辞需调整(实际跑下来才发现的模糊点),按发现的问题定点改 + commit;若无问题,跳过此步直接进入 Task 14。

```bash
cd "f:/llm-wiki-plugin" && git add -A && git commit -m "docs(skill): refine wording after integration test" --allow-empty
```

---

## Task 14: 最终 DoD 校验 + 总结 commit

- [ ] **Step 1: 校验 DoD 6 条**

逐项打勾:

- [ ] (DoD 1) `scripts/convert-office.mjs` + `scripts/convert-office.test.mjs` 落地,node:test 全过
- [ ] (DoD 2) `SKILL.md` 触发关键词扩展为 8 个(整理 / Inbox / web clipper / office / ppt / word / excel / 图片)
- [ ] (DoD 3) 集成测试 7 清单全过(Task 13)
- [ ] (DoD 4) 原 PDF + web_clipper md 回归测试通过(Task 13 Step 4)
- [ ] (DoD 5) design doc + plan doc 提交(plugin 仓 `docs/superpowers/`)
- [ ] (DoD 6) 一次 commit? — 实际是 11 个小 commit(TDD 风格),可选择性 squash:

```bash
cd "f:/llm-wiki-plugin" && git log --oneline ^origin/main | head -20
```

确认所有 commit 在 branch 上,无需强 squash(细粒度历史更有价值)。

- [ ] **Step 2: 输出完成报告**

主对话向用户报告:

```
obsidian-collacting 多源扩展完成。
- 新增 scripts/convert-office.mjs(office/image → md 预转换)
- 新增 scripts/convert-office.test.mjs(11 个单测)
- SKILL.md 扩展为 6 类 Inbox 源
- 集成测试 6 样本全过,回归测试通过

DoD 6 条全部满足。
```

---

## 自评(spec coverage)

| Spec 章节 | 对应 task |
|---|---|
| 架构总览(4 段流水线) | Task 9/10/11(对应 SKILL.md 改动) |
| convert-office.mjs 脚本契约 | Task 1-6 |
| 类型→命令映射表 | Task 3 (pptx/docx) / Task 4 (xlsx) / Task 5 (image) |
| CLI 接口 + JSON 返回 | Task 1 + Task 6 |
| 输出 md frontmatter + 段落分隔符 | Task 6(frontmatter) + Task 3/4/5(段落分隔符由各分支写入 body) |
| SKILL.md 改动范围表 | Task 9/10/11/12 |
| 错误处理矩阵 | Task 1(参数错误) / Task 3-5(tool_missing) / Task 2(超时) |
| 测试策略 6 用例 | Task 7 |
| 集成测试 7 清单 | Task 13 |
| 回归测试 | Task 13 Step 4 |
| DoD 6 条 | Task 14 |
| init-vault SCRIPT_FILES | Task 8(后置,保证 init 时新脚本也拷贝到 vault) |

无 spec 章节遗漏。
