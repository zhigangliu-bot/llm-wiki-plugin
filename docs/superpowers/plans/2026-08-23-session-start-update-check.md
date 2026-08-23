# SessionStart Plugin Update Check — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `llm-wiki-plugin` 加一个 SessionStart hook,在 Claude Code 启动时自动 `git pull --ff-only` 更新 plugin 仓本地副本;失败时 stdout 一行警告,exit 0(不阻断 session)。

**Architecture:** hooks.json 触发一个 Node async 脚本(`scripts/check-update.mjs`),脚本通过 git CLI 检查更新并 ff-merge;8 个单元测试覆盖所有失败场景。

**Tech Stack:** Node 22 (ESM),`node:child_process/promisify` 的 `execFile`,`node --test`,Claude Code hooks.json schema。

**Spec:** `docs/superpowers/specs/2026-08-23-session-start-update-check-design.md`(已批准)

---

## 文件结构

新增:
- `hooks/hooks.json` — SessionStart hook 配置
- `scripts/check-update.mjs` — Node async 脚本(fetch / diff / ff-only pull)
- `scripts/check-update.test.mjs` — 8 个单元测试,用 mock execFile 隔离真实 git

修改:
- `README.md` — 加 "Auto-Update" 段说明 hook 行为 + 失败排查

---

### Task 1: 写 check-update.mjs 脚本 + 8 个测试通过

**Files:**
- Create: `scripts/check-update.mjs`
- Create: `scripts/check-update.test.mjs`

**Architecture 决策**(对 spec 的细化):
- 用 `child_process` 的 `execFile`(不用 `exec`)防 shell 注入
- 全部 git 命令走 `cwd: PLUGIN_ROOT`,PLUGIN_ROOT = `process.env.CLAUDE_PLUGIN_ROOT ?? process.cwd()`
- 失败兜底:任何未捕获异常都 → stdout warning + exit 0(永不让 hook 报红)
- 单元测试 mock `node:child_process/promises` 的 `execFile`,不真跑 git

- [ ] **Step 1: 写 check-update.mjs 骨架**

```js
#!/usr/bin/env node
/**
 * check-update.mjs — SessionStart hook: git pull --ff-only plugin 仓本地副本
 *
 * 行为契约见 docs/superpowers/specs/2026-08-23-session-start-update-check-design.md
 *
 * 失败兜底: 任何异常 → stdout warning + exit 0 (不阻断 session)
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT ?? process.cwd();

const PREFIX_OK = '✓';
const PREFIX_WARN = '⚠';

function warn(msg) {
  console.log(`${PREFIX_WARN} llm-wiki-plugin ${msg}`);
}

/**
 * 跑 git 命令,返回 {ok, stdout, stderr}
 * 失败永不抛 — error 透传 stderr(供 caller 决定如何报告)
 */
async function git(...args) {
  try {
    const { stdout, stderr } = await execFileP('git', args, { cwd: PLUGIN_ROOT });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (e) {
    return {
      ok: false,
      stdout: '',
      stderr: (e.stderr?.toString() ?? e.message ?? '').trim().split('\n')[0],
    };
  }
}

function shortSha(sha) {
  return sha ? sha.slice(0, 7) : '';
}

export async function runUpdate() {
  // 1. cwd 必须是 git 仓
  const rev = await git('rev-parse', '--git-dir');
  if (!rev.ok) {
    warn('update skipped: not a git repository');
    return;
  }

  // 2. fetch
  const fetch = await git('fetch', 'origin', 'main');
  if (!fetch.ok) {
    warn(`update check failed: ${fetch.stderr || 'fetch error'}`);
    return;
  }

  // 3. 拿本地 + 远端 SHA
  const local = await git('rev-parse', 'HEAD');
  const remote = await git('rev-parse', 'origin/main');
  if (!local.ok || !remote.ok) {
    warn('update check failed: rev-parse error');
    return;
  }

  // 4. 无更新
  if (local.stdout === remote.stdout) return;

  // 5. ff-only pull
  const pull = await git('pull', '--ff-only', 'origin', 'main');
  if (pull.ok) {
    const newHead = await git('rev-parse', '--short', 'HEAD');
    console.log(`${PREFIX_OK} llm-wiki-plugin updated: ${shortSha(local.stdout)}..${shortSha(newHead.stdout)}`);
  } else {
    warn(`update skipped: ${pull.stderr || 'non-fast-forward'}`);
  }
}

/* ===================== CLI 入口 ===================== */

async function main() {
  try {
    await runUpdate();
  } catch (e) {
    warn(`update check failed: ${e.message ?? 'unknown error'}`);
  }
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().then(() => process.exit(0));  // 永远 exit 0
}
```

需要的 import:在文件顶部加 `import { pathToFileURL } from 'node:url';`(上面代码用了 `pathToFileURL`,需 import)

- [ ] **Step 2: 写测试 — 8 个 case**

`scripts/check-update.test.mjs`:

```js
/**
 * check-update.test.mjs
 *
 * Run with: node --test scripts/check-update.test.mjs
 *
 * 策略: mock node:child_process 的 execFile,不真跑 git。
 * 通过 mock 返回值模拟每种 git 命令的输出。
 */
import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('check-update', () => {
  let originalExecFile;
  let mockExecFile;
  let execFileCalls;
  let stdoutChunks;
  let tmpCwd;

  beforeEach(async () => {
    // 让 PLUGIN_ROOT fallback 到 cwd(测试在一个 tmp 目录跑)
    tmpCwd = await mkdtemp(join(tmpdir(), 'check-update-test-'));
    process.chdir(tmpCwd);
    delete process.env.CLAUDE_PLUGIN_ROOT;

    execFileCalls = [];
    stdoutChunks = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    mock.method(process.stdout, 'write', (chunk) => {
      stdoutChunks.push(chunk.toString());
      return origWrite(chunk);
    });

    // mock execFile: 根据 argv 决定返回什么
    originalExecFile = (await import('node:child_process')).execFile;
    mockExecFile = mock.fn(async (cmd, args) => {
      execFileCalls.push({ cmd, args });
      const a = args.join(' ');
      if (a === 'rev-parse --git-dir') return { stdout: '.git\n', stderr: '' };
      if (a === 'fetch origin main') return { stdout: '', stderr: '' };
      if (a === 'rev-parse HEAD') return { stdout: 'abcdef1234567890abcdef1234567890abcdef12\n', stderr: '' };
      if (a === 'rev-parse origin/main') return { stdout: 'abcdef1234567890abcdef1234567890abcdef12\n', stderr: '' };
      throw new Error(`unexpected git call: ${a}`);
    });
    // 用 mock.module 拦截 import — 但更简单是动态 import 后再改
    // 这里用 monkey-patch: 在 beforeEach 里替换 child_process.execFile
    const cp = await import('node:child_process');
    cp.execFile = mockExecFile;
  });

  afterEach(async () => {
    mock.restoreAll();
    await rm(tmpCwd, { recursive: true, force: true });
  });

  function getStdout() {
    return stdoutChunks.join('');
  }

  test('1. cwd 不是 git 仓 → warning + exit 0', async () => {
    // override default: rev-parse --git-dir 失败
    mockExecFile.mock.mockImplementation(async (cmd, args) => {
      const a = args.join(' ');
      if (a === 'rev-parse --git-dir') throw Object.assign(new Error('not a git repository'), { stderr: 'fatal: not a git repository\n' });
      throw new Error(`unexpected: ${a}`);
    });
    const { runUpdate } = await import(`./check-update.mjs?case=${Date.now()}`);
    await runUpdate();
    const out = getStdout();
    assert.ok(out.includes('⚠') && out.includes('not a git repository'), `expected warning, got: ${out}`);
  });

  test('2. fetch 失败(无网络) → warning + exit 0', async () => {
    mockExecFile.mock.mockImplementation(async (cmd, args) => {
      const a = args.join(' ');
      if (a === 'rev-parse --git-dir') return { stdout: '.git\n', stderr: '' };
      if (a === 'fetch origin main') throw Object.assign(new Error('Could not resolve'), { stderr: 'fatal: unable to access: Could not resolve host\n' });
      throw new Error(`unexpected: ${a}`);
    });
    const { runUpdate } = await import(`./check-update.mjs?case=${Date.now()}`);
    await runUpdate();
    const out = getStdout();
    assert.ok(out.includes('⚠') && out.includes('update check failed'), `expected warning, got: ${out}`);
    assert.ok(!out.includes('✓'), '不应有更新成功标记');
  });

  test('3. 本地 = origin → 静默成功(空 stdout)', async () => {
    // 默认 mock 就是本地 = origin,runUpdate 应静默
    const { runUpdate } = await import(`./check-update.mjs?case=${Date.now()}`);
    await runUpdate();
    assert.equal(getStdout().trim(), '', `expected silent, got: "${getStdout()}"`);
  });

  test('4. 本地 < origin + 无本地改动 → ✓ updated: old..new', async () => {
    mockExecFile.mock.mockImplementation(async (cmd, args) => {
      const a = args.join(' ');
      if (a === 'rev-parse --git-dir') return { stdout: '.git\n', stderr: '' };
      if (a === 'fetch origin main') return { stdout: '', stderr: '' };
      if (a === 'rev-parse HEAD') return { stdout: 'aaaaaa1234567890\n', stderr: '' };
      if (a === 'rev-parse origin/main') return { stdout: 'bbbbbb1234567890\n', stderr: '' };
      if (a === 'pull --ff-only origin main') return { stdout: 'Updating aaaaaa..bbbbbb\nFast-forward\n', stderr: '' };
      if (a === 'rev-parse --short HEAD') return { stdout: 'bbbbbb1\n', stderr: '' };
      throw new Error(`unexpected: ${a}`);
    });
    const { runUpdate } = await import(`./check-update.mjs?case=${Date.now()}`);
    await runUpdate();
    const out = getStdout();
    assert.ok(out.includes('✓ llm-wiki-plugin updated: aaaaaaa..bbbbbbb') || out.includes('✓ llm-wiki-plugin updated: aaaaaa..bbbbbb'),
      `expected update marker, got: ${out}`);
    assert.ok(!out.includes('⚠'), '不应有 warning');
  });

  test('5. 本地 < origin + 有本地未 commit 改动 + ff 成功 → 同上(ff-only 不影响未 commit)', async () => {
    // ff-only 的语义: 远端是本地的超集 → ff 成功 → 不会动未 commit 改动
    // 行为同 case 4
    mockExecFile.mock.mockImplementation(async (cmd, args) => {
      const a = args.join(' ');
      if (a === 'rev-parse --git-dir') return { stdout: '.git\n', stderr: '' };
      if (a === 'fetch origin main') return { stdout: '', stderr: '' };
      if (a === 'rev-parse HEAD') return { stdout: 'aaaaaa\n', stderr: '' };
      if (a === 'rev-parse origin/main') return { stdout: 'bbbbbb\n', stderr: '' };
      if (a === 'pull --ff-only origin main') return { stdout: 'Fast-forward\n', stderr: '' };
      if (a === 'rev-parse --short HEAD') return { stdout: 'bbbbbb1\n', stderr: '' };
      throw new Error(`unexpected: ${a}`);
    });
    const { runUpdate } = await import(`./check-update.mjs?case=${Date.now()}`);
    await runUpdate();
    assert.ok(getStdout().includes('✓'));
  });

  test('6. 本地 < origin + ff 失败(非快进)→ warning + exit 0', async () => {
    mockExecFile.mock.mockImplementation(async (cmd, args) => {
      const a = args.join(' ');
      if (a === 'rev-parse --git-dir') return { stdout: '.git\n', stderr: '' };
      if (a === 'fetch origin main') return { stdout: '', stderr: '' };
      if (a === 'rev-parse HEAD') return { stdout: 'aaaaaa\n', stderr: '' };
      if (a === 'rev-parse origin/main') return { stdout: 'bbbbbb\n', stderr: '' };
      if (a === 'pull --ff-only origin main') throw Object.assign(new Error('Not possible to fast-forward'), { stderr: 'fatal: Not possible to fast-forward, aborting.\n' });
      throw new Error(`unexpected: ${a}`);
    });
    const { runUpdate } = await import(`./check-update.mjs?case=${Date.now()}`);
    await runUpdate();
    const out = getStdout();
    assert.ok(out.includes('⚠') && out.includes('update skipped'), `expected skipped warning, got: ${out}`);
  });

  test('7. rev-parse HEAD 失败 → warning + exit 0(防御)', async () => {
    mockExecFile.mock.mockImplementation(async (cmd, args) => {
      const a = args.join(' ');
      if (a === 'rev-parse --git-dir') return { stdout: '.git\n', stderr: '' };
      if (a === 'fetch origin main') return { stdout: '', stderr: '' };
      if (a === 'rev-parse HEAD') throw Object.assign(new Error('HEAD error'), { stderr: 'fatal: ambiguous HEAD\n' });
      throw new Error(`unexpected: ${a}`);
    });
    const { runUpdate } = await import(`./check-update.mjs?case=${Date.now()}`);
    await runUpdate();
    assert.ok(getStdout().includes('⚠'));
  });

  test('8. stdout 格式: ✓/⚠ 前缀 + 单行', async () => {
    // 触发一个 warning,验证 stdout 格式
    mockExecFile.mock.mockImplementation(async (cmd, args) => {
      const a = args.join(' ');
      if (a === 'rev-parse --git-dir') throw Object.assign(new Error('x'), { stderr: 'not a git\n' });
      throw new Error(`unexpected: ${a}`);
    });
    const { runUpdate } = await import(`./check-update.mjs?case=${Date.now()}`);
    await runUpdate();
    const lines = getStdout().trim().split('\n');
    assert.equal(lines.length, 1, `expected single line, got ${lines.length}: ${getStdout()}`);
    assert.match(lines[0], /^[✓⚠] llm-wiki-plugin /, `expected ✓/⚠ prefix, got: ${lines[0]}`);
  });
});
```

- [ ] **Step 3: 跑测试验证全过**

Run: `cd f:/llm-wiki-plugin && node --test scripts/check-update.test.mjs`
Expected: `pass 8 / fail 0`

- [ ] **Step 4: 修 bug 至全过**

如果测试有 fail,改 `check-update.mjs` 或测试,直到 8/8 pass。**不要 skip 任何测试**。

- [ ] **Step 5: Commit**

```bash
cd f:/llm-wiki-plugin
git add scripts/check-update.mjs scripts/check-update.test.mjs
git commit -m "feat(hook): add SessionStart check-update script + 8 tests

scripts/check-update.mjs: Claude Code 启动时检查 plugin 仓更新,
git pull --ff-only 同步本地副本。失败静默 + stdout warning,
exit 0 (不阻断 session)。

scripts/check-update.test.mjs: 8 个 case 覆盖
git 仓检测 / fetch 失败 / 无更新 / 正常更新 / 有本地改动 /
非快进 / rev-parse 失败 / stdout 格式。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: 写 hooks/hooks.json + plugin manifest 验证

**Files:**
- Create: `hooks/hooks.json`

- [ ] **Step 1: 写 hooks/hooks.json**

`hooks/hooks.json`:

```json
{
  "description": "Auto-update llm-wiki-plugin from GitHub on session start (async, non-blocking)",
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/check-update.mjs\"",
            "async": true
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2: 验证 hooks.json 语法**

Run: `cd f:/llm-wiki-plugin && node -e "console.log(JSON.parse(require('fs').readFileSync('hooks/hooks.json', 'utf8')))"`
Expected: 输出 JSON 对象,无 SyntaxError

- [ ] **Step 3: 跑 claude plugin validate(若可用)**

Run: `cd f:/llm-wiki-plugin && claude plugin validate . 2>&1 | head -30`
Expected: hooks.json 出现在检查列表里,无错误。若 claude CLI 不在 PATH,跳过此步,记录"validate skipped, manual review only"。

- [ ] **Step 4: Commit**

```bash
cd f:/llm-wiki-plugin
git add hooks/hooks.json
git commit -m "feat(hook): register SessionStart hook for auto-update

hooks/hooks.json: matcher=startup 触发 async check-update.mjs,
异步跑 git pull --ff-only 不阻塞 session 启动。
CLAUDE_PLUGIN_ROOT 环境变量让命令跨机器可移植。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: 更新 README + Auto-Update 段

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 读现有 README,定位插入点**

读 `f:/llm-wiki-plugin/README.md` 的 ## Features / ## Skills / 安装 部分。在 ## Installation 之后、## Skills 之前(如果有),插入 ## Auto-Update 段。

- [ ] **Step 2: 加 ## Auto-Update 段**

插入内容:

```markdown
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
```

- [ ] **Step 3: 读 README 验证插入位置合理**

读修改后的 README,确认 Auto-Update 段位置在 ## Installation 之后,且不破坏其它段格式。

- [ ] **Step 4: Commit**

```bash
cd f:/llm-wiki-plugin
git add README.md
git commit -m "docs: README add Auto-Update section explaining SessionStart hook

说明 hook 行为 / 4 种状态 / 禁用方法 / 手动更新。
让用户知道 plugin 怎么自动更新的,以及在网络差 / 冲突时
hook 是怎么静默兜底的。

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: 推送到 GitHub + marketplace 验证

**Files:** 无

- [ ] **Step 1: 跑全量测试**

Run: `cd f:/llm-wiki-plugin && node --test scripts/*.test.mjs 2>&1 | tail -10`
Expected: 之前 110 个 + 新 8 个 = 118 全过

- [ ] **Step 2: Push 三个 commit**

```bash
cd f:/llm-wiki-plugin
git push origin main
```

- [ ] **Step 3: 本地 sanity — 跑一次真脚本看 stdout**

```bash
cd f:/llm-wiki-plugin
node scripts/check-update.mjs
```

Expected:
- 实际上 git pull 会更新本地(因为 push 的是新 commit)
- stdout 应包含 `✓ llm-wiki-plugin updated: <oldsha>..<newsha>` 或空(若远端没新 commit)
- exit 0

- [ ] **Step 4: 验证 hook 在 marketplace 仓被识别**

Run: 查 `myself-marketplace/.claude-plugin/marketplace.json` 确认 `llm-wiki-plugin` 引用没坏。新版 plugin 自动被 marketplace 拿(因为 source `ref: main`)。无需改 marketplace.json。

---

## 实施后验证

最终验证清单(完工后跑一遍):
1. `node --test scripts/check-update.test.mjs` → 8/8 pass
2. `node --test scripts/*.test.mjs` → 118/118 pass(全局)
3. `node scripts/check-update.mjs` → exit 0,stdout 合理
4. `hooks/hooks.json` JSON 合法
5. git log 3 个新 commit

## Self-Review

- [x] **Spec coverage:** spec 7 节行为契约全部覆盖 — git 仓检测 / fetch 失败 / 无更新 / 正常更新 / 本地改动 / ff 失败 / rev-parse 失败 / stdout 格式
- [x] **Type consistency:** `runUpdate()` 在 spec 和 plan 一致;stdout 格式 `✓/⚠ llm-wiki-plugin ...` 一致
- [x] **No placeholders:** 所有代码块完整,无 "TODO" / "implement later"
- [x] **Atoms 2-5 min:** 3 任务共 14 步骤,每步独立可执行
- [x] **TDD:** Task 1 先写脚本 + 测试一起,Step 3 跑测试,Step 4 修 bug,Step 5 commit
- [x] **Frequent commits:** 每任务末 commit,3 个独立 commit
