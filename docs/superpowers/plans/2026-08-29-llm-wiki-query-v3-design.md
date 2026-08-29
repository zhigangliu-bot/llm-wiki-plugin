# llm-wiki-query v3 自动路径选择 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `llm-wiki-query` skill 加 SessionStart hook + Node 脚本, 根据 vault 大小 (500 / 3000 三档) 自动选择朴素 Grep / qmd MCP 召回路径; vault >= 1500 且 qmd 未装时引导 vault 用户安装.

**Architecture:** 三件套: (1) `scripts/qmd-detect.mjs` 纯函数 + CLI 入口, SessionStart 跑一次算 `tier` + `effective_path`; (2) `hooks/hooks.json` 新增 SessionStart matcher, 输出注入 LLM system context; (3) `vault/.llm-wiki-query-state.json` (vault 用户 override + 引导跳过记录). 路径选择由 Node 脚本决定, LLM 只读 system context 调对应工具.

**Tech Stack:** Node 22 (无新依赖), JSON, Markdown, Claude Code SessionStart hook (async + 2>/dev/null), 现有 `init-vault` / `check-update` 纪律 (JSDoc + DI + 单元测试).

**Spec:** [docs/superpowers/specs/spec-query.md](docs/superpowers/specs/spec-query.md) (commit `779324a`)

**Commit 粒度:** 7 个独立 commit, 按 plugin CLAUDE.md 第 61 行「单文件改动单文件提交」.

---

## 文件总览

| 文件 | 操作 | 责任 |
|---|---|---|
| `scripts/qmd-detect.mjs` | 新建 | 纯函数 computePath() + CLI 入口 main(): 数 vault, 探 qmd, 算 tier/effective_path, 写 cache, stdout 输出 JSON |
| `scripts/qmd-detect.test.mjs` | 新建 | 11 项单元测试 (mock 文件系统 + mock DI 探 qmd + state.json 容错 + exit 0 兜底) |
| `hooks/hooks.json` | 修改 | 在 `SessionStart` 数组里追加第二个 matcher (不替换现有 check-update matcher) |
| `skills/llm-wiki-query/SKILL.md` | 修改 | 阶段 B 加 B0 路径选择子流程; 重写「何时用 grep 何时考虑 qmd」决策段; 加 system context 读取规则 |
| `00_模板/Log_Spec.md` | 修改 | §3.4 召回方式枚举扩 `'qmd'` 值 (grep 仍保留) |
| `CLAUDE.md` (plugin) | 修改 | ASCII 五 skill 协作图 sync + 文件索引表更新 |
| `README.md` | 修改 | 「关于 llm-wiki-query 的召回路径」段 sync |

**不动的文件:** `scripts/check-update.mjs` / `scripts/init-vault.mjs` / `10_schema/` / `00_模板/CLAUDE_Template.md` (本次不涉及铁律) / 历史 spec / 历史 plan.

---

## Task 1: 写 qmd-detect.mjs 单元测试骨架 (TDD 起点)

**Files:**
- Create: `scripts/qmd-detect.test.mjs`
- Test: `node --test scripts/qmd-detect.test.mjs`

- [ ] **Step 1: 创建测试文件头部**

```javascript
/**
 * qmd-detect.test.mjs
 *
 * Run with: node --test scripts/qmd-detect.test.mjs
 *
 * 策略:
 *   1. 通过 DI 注入 mock fileSystem + mock execFn + mock mtimeFn,
 *      不 mutate 任何内置模块 namespace
 *      (Node 22 冻结 ESM namespace, fs = X 会抛)
 *   2. 通过 tmp vault 目录测真实路径行为;纯函数测逻辑.
 *   3. 测 vault 用户 state.json 容错.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  computeTier,
  computeEffectivePath,
  filterMdFiles,
  THRESHOLDS,
} from './qmd-detect.mjs';

describe('qmd-detect THRESHOLDS', () => {
  test('小 vault (< 500) 是 small', () => {
    assert.equal(computeTier(0), 'small');
    assert.equal(computeTier(499), 'small');
  });
  test('500 - 2999 是 medium', () => {
    assert.equal(computeTier(500), 'medium');
    assert.equal(computeTier(2999), 'medium');
  });
  test('>= 3000 是 large', () => {
    assert.equal(computeTier(3000), 'large');
    assert.equal(computeTier(10000), 'large');
  });
});

describe('qmd-detect computeEffectivePath', () => {
  test('path_override = "grep" 强制覆盖', () => {
    const state = { path_override: 'grep' };
    assert.equal(computeEffectivePath(state, 'large', true), 'grep');
  });
  test('path_override = "qmd" 强制覆盖 (即使 qmd 未装也报 qmd, LLM 端报错)', () => {
    const state = { path_override: 'qmd' };
    assert.equal(computeEffectivePath(state, 'small', false), 'qmd');
  });
  test('path_override = "auto" 等同缺省, 按 tier+available 决策', () => {
    const state = { path_override: 'auto' };
    assert.equal(computeEffectivePath(state, 'small', true), 'grep');
    assert.equal(computeEffectivePath(state, 'small', false), 'grep');
    assert.equal(computeEffectivePath(state, 'medium', true), 'qmd');
    assert.equal(computeEffectivePath(state, 'medium', false), 'grep');
    assert.equal(computeEffectivePath(state, 'large', true), 'qmd');
    assert.equal(computeEffectivePath(state, 'large', false), 'grep');
  });
  test('缺省 state (空对象), 按 tier+available 决策', () => {
    assert.equal(computeEffectivePath({}, 'small', false), 'grep');
    assert.equal(computeEffectivePath({}, 'medium', true), 'qmd');
    assert.equal(computeEffectivePath({}, 'large', true), 'qmd');
  });
  test('state.path_override 非法值忽略按 auto 处理', () => {
    const state = { path_override: 'banana' };
    assert.equal(computeEffectivePath(state, 'medium', true), 'qmd');
  });
});

describe('qmd-detect filterMdFiles', () => {
  test('排除 00_模板/ .obsidian/ node_modules/ .git/ temp/', () => {
    const input = [
      'a.md',
      'b.md',
      '00_模板/x.md',
      '.obsidian/plugins/y.md',
      'node_modules/lib/z.md',
      '.git/HEAD.md',
      'temp/cache/q.md',
      '02_读书笔记/note.md',
    ];
    const filtered = filterMdFiles(input);
    assert.deepEqual(filtered.sort(), ['02_读书笔记/note.md', 'a.md', 'b.md']);
  });
});

describe('qmd-detect computeSuggestionFlags', () => {
  // 用 import 增加 computeSuggestionFlags
  test('should_suggest_qmd_install: medium + qmd 未装 + 引导未跳过', async (t) => {
    const mod = await import('./qmd-detect.mjs');
    const flags = mod.computeSuggestionFlags({
      tier: 'medium',
      qmdAvailable: false,
      stateSkippedAt: null,
      override: null,
    });
    assert.equal(flags.shouldSuggest, true);
  });
  test('should_suggest_qmd_install: 引导跳过 (state.引导_skipped_at 非空) 后 = false', async (t) => {
    const mod = await import('./qmd-detect.mjs');
    const flags = mod.computeSuggestionFlags({
      tier: 'medium',
      qmdAvailable: false,
      stateSkippedAt: '2026-08-29T10:00:00Z',
      override: null,
    });
    assert.equal(flags.shouldSuggest, false);
  });
  test('should_warn_grep_unstable: large + qmd 未装 + override !== grep = true', async (t) => {
    const mod = await import('./qmd-detect.mjs');
    const flags = mod.computeSuggestionFlags({
      tier: 'large',
      qmdAvailable: false,
      stateSkippedAt: null,
      override: null,
    });
    assert.equal(flags.shouldWarn, true);
  });
  test('should_warn_grep_unstable: override=grep 后 = false', async (t) => {
    const mod = await import('./qmd-detect.mjs');
    const flags = mod.computeSuggestionFlags({
      tier: 'large',
      qmdAvailable: false,
      stateSkippedAt: null,
      override: 'grep',
    });
    assert.equal(flags.shouldWarn, false);
  });
  test('should_warn_grep_unstable: qmd 已装 = false', async (t) => {
    const mod = await import('./qmd-detect.mjs');
    const flags = mod.computeSuggestionFlags({
      tier: 'large',
      qmdAvailable: true,
      stateSkippedAt: null,
      override: null,
    });
    assert.equal(flags.shouldWarn, false);
  });
});

describe('qmd-detect safeFallback', () => {
  test('safeFallback() 返回兜底 JSON: tier=small, effective_path=grep', async (t) => {
    const mod = await import('./qmd-detect.mjs');
    const fallback = mod.safeFallback();
    assert.equal(fallback.tier, 'small');
    assert.equal(fallback.effective_path, 'grep');
  });
});

describe('qmd-detect state 容错', () => {
  let tmpVault;
  beforeEach(async () => {
    tmpVault = await mkdtemp(join(tmpdir(), 'qmd-detect-test-'));
  });
  afterEach(async () => {
    await rm(tmpVault, { recursive: true, force: true });
  });

  test('state.json 缺字段 / 错类型不抛, 走 auto 决策', async (t) => {
    const mod = await import('./qmd-detect.mjs');
    // 写坏的 state.json
    await writeFile(join(tmpVault, '.llm-wiki-query-state.json'), '{"path_override": 123}');
    const state = await mod.readStateFile(tmpVault);
    // path_override 错类型 → 忽略, fallback auto
    assert.equal(state.path_override, undefined);
  });
  test('state.json path_override 非法字符串 → 忽略, fallback auto', async (t) => {
    const mod = await import('./qmd-detect.mjs');
    await writeFile(join(tmpVault, '.llm-wiki-query-state.json'), '{"path_override": "banana"}');
    const state = await mod.readStateFile(tmpVault);
    assert.equal(state.path_override, 'banana'); // 字段读出,但 computeEffectivePath 容错
    // computeEffectivePath 处理后会忽略 'banana'
    assert.equal(computeEffectivePath(state, 'medium', true), 'qmd');
  });
  test('state.json 不存在时返回空对象不抛', async (t) => {
    const mod = await import('./qmd-detect.mjs');
    const state = await mod.readStateFile(tmpVault);
    assert.deepEqual(state, {});
  });
});

describe('qmd-detect main() 退出码', () => {
  let tmpVault;
  let ORIGINAL_PLUGIN_ROOT;
  let stdoutChunks;
  beforeEach(async () => {
    tmpVault = await mkdtemp(join(tmpdir(), 'qmd-detect-test-'));
    ORIGINAL_PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = tmpVault;
    stdoutChunks = [];
    process.stdout.write = (chunk) => { stdoutChunks.push(chunk.toString()); return true; };
  });
  afterEach(async () => {
    if (ORIGINAL_PLUGIN_ROOT === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = ORIGINAL_PLUGIN_ROOT;
    await rm(tmpVault, { recursive: true, force: true });
  });

  test('vault 不存在时 main 仍 exit 0, 输出 safe fallback JSON', async (t) => {
    const { spawn } = await import('node:child_process');
    const result = await new Promise((resolve) => {
      const p = spawn('node', [join(process.cwd(), 'scripts/qmd-detect.mjs'),
        `--vault=${tmpVault}/nonexistent`], { env: process.env });
      let out = '';
      p.stdout.on('data', (d) => out += d);
      p.on('close', (code) => resolve({ code, out }));
    });
    assert.equal(result.code, 0);
    assert.match(result.out, /"tier":\s*"small"/);
    assert.match(result.out, /"effective_path":\s*"grep"/);
  });
});
```

- [ ] **Step 2: 跑测试看全失败**

Run: `node --test scripts/qmd-detect.test.mjs`
Expected: FAIL with "Cannot find module './qmd-detect.mjs'" 或每个 import 都 missing.

- [ ] **Step 3: Commit 测试骨架**

```bash
git add scripts/qmd-detect.test.mjs
git commit -m "test(script): qmd-detect 单元测试骨架 (TDD 起点, 全测试预期失败)"
```

---

## Task 2: 实现 qmd-detect.mjs 纯函数部分

**Files:**
- Create: `scripts/qmd-detect.mjs`

- [ ] **Step 1: 写 JSDoc 头 + DI 注入模块 imports + 阈值常量 + 纯函数 (computeTier / computeEffectivePath / filterMdFiles / computeSuggestionFlags / safeFallback / readStateFile)**

```javascript
#!/usr/bin/env node
/**
 * qmd-detect.mjs — SessionStart hook: 探测 vault 大小 + qmd 可用性,
 * 算出 tier + effective_path, 注入 LLM system context.
 *
 * 行为契约见 docs/superpowers/specs/spec-query.md (v3, commit 779324a)
 *
 * 失败兜底: 任何异常 → stdout safe fallback JSON + exit 0 (不阻断 session)
 *
 * 架构: 依赖注入 (DI). 所有外部依赖 (fs 读 config, child_process 探 qmd,
 *       时间获取) 都通过 opts 注入, 默认值接真实实现.
 *       测试时传 mock, 绕开 Node 22 内置模块 namespace 冻结问题.
 */

import { readFile, writeFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join, relative } from 'node:path';

const execFileP = promisify(execFile);

/** vault 大小阈值. 改时单文件改. */
export const THRESHOLDS = { small: 500, large: 3000 };

/** 不计入 vault_size 的目录前缀 */
const EXCLUDED_PREFIXES = [
  '00_模板/',
  '.obsidian/',
  'node_modules/',
  '.git/',
  'temp/',
];

/**
 * 根据 vault_size 算 tier.
 * @param {number} vaultSize - 实际数到的 .md 文件数
 * @returns {'small' | 'medium' | 'large'}
 */
export function computeTier(vaultSize) {
  if (vaultSize < THRESHOLDS.small) return 'small';
  if (vaultSize < THRESHOLDS.large) return 'medium';
  return 'large';
}

/**
 * 算 effective_path. 优先级: override > tier+available.
 * @param {object} state - vault/.llm-wiki-query-state.json 解析结果 (允许 {})
 * @param {'small'|'medium'|'large'} tier
 * @param {boolean} qmdAvailable
 * @returns {'grep' | 'qmd'}
 */
export function computeEffectivePath(state, tier, qmdAvailable) {
  if (state.path_override === 'grep') return 'grep';
  if (state.path_override === 'qmd') return 'qmd';
  // override 非法/缺省 → 按 tier+available 决策
  if (tier === 'small') return 'grep';
  return qmdAvailable ? 'qmd' : 'grep';
}

/**
 * 给定 path 列表, 过滤掉 EXCLUDED_PREFIXES 命中的条目.
 * @param {string[]} paths - 相对 vault 根的 .md 路径列表
 * @returns {string[]}
 */
export function filterMdFiles(paths) {
  return paths.filter((p) => {
    const norm = p.replace(/\\/g, '/');
    return !EXCLUDED_PREFIXES.some((prefix) => norm.startsWith(prefix));
  });
}

/**
 * 算建议提示 flags.
 * @param {object} opts
 * @param {'small'|'medium'|'large'} opts.tier
 * @param {boolean} opts.qmdAvailable
 * @param {string|null} opts.stateSkippedAt - state.引导_skipped_at; null = 缺省/未引导
 * @param {string|null} opts.override - state.path_override; null = auto
 */
export function computeSuggestionFlags({ tier, qmdAvailable, stateSkippedAt, override }) {
  const shouldSuggest =
    tier === 'medium' &&
    !qmdAvailable &&
    !stateSkippedAt &&
    override !== 'grep';
  const shouldWarn =
    tier === 'large' && !qmdAvailable && override !== 'grep';
  return { shouldSuggest, shouldWarn };
}

/** 安全降级 JSON: hook 失败时永远输出这个. */
export function safeFallback() {
  return {
    tier: 'small',
    effective_path: 'grep',
    qmd_available: false,
    vault_size: 0,
    cache_age_seconds: 0,
    vault_mtime_iso: new Date(0).toISOString(),
    state_override: null,
    should_suggest_qmd_install: false,
    should_warn_grep_unstable: false,
  };
}

/**
 * 读 vault/.llm-wiki-query-state.json, 字段缺失/错类型/非法值不抛.
 * @param {string} vaultRoot
 * @param {{readFile?: Function}} [opts]
 * @returns {Promise<object>}
 */
export async function readStateFile(vaultRoot, { readFile: readFn = readFile } = {}) {
  try {
    const raw = await readFn(join(vaultRoot, '.llm-wiki-query-state.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return {
      path_override: typeof parsed.path_override === 'string' ? parsed.path_override : undefined,
      引导_skipped_at: typeof parsed['引导_skipped_at'] === 'string' ? parsed['引导_skipped_at'] : undefined,
    };
  } catch {
    return {};
  }
}
```

- [ ] **Step 2: 跑测试看纯函数全过**

Run: `node --test scripts/qmd-detect.test.mjs --test-name-pattern="THRESHOLDS|computeEffectivePath|filterMdFiles|computeSuggestionFlags|safeFallback|state 容错"`
Expected: PASS (Task 1 测试骨架里这些 group 全过). 仍会 skip 的是 main() 退出码 group (依赖还未写的 main()).

- [ ] **Step 3: Commit 纯函数**

```bash
git add scripts/qmd-detect.mjs
git commit -m "feat(script): qmd-detect 纯函数实现 (computeTier / computeEffectivePath / filterMdFiles / computeSuggestionFlags / safeFallback / readStateFile)"
```

---

## Task 3: 实现 qmd-detect.mjs 剩余部分 (vault 数 / qmd 探 / cache 读写 / main 入口)

**Files:**
- Modify: `scripts/qmd-detect.mjs`

- [ ] **Step 1: 在 qmd-detect.mjs 末尾追加 I/O 函数 + main()**

```javascript
/**
 * 探 qmd 是否可用. `qmd collection list` 进程, 5s timeout, exit 0 = true.
 * @param {Function} [execFn] - promisified execFile (DI)
 * @returns {Promise<boolean>}
 */
export async function detectQmdAvailable(execFn = execFileP) {
  try {
    await execFn('qmd', ['collection', 'list'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * 读 .llm-wiki-cache.json. 缺省 = 空对象.
 * @param {string} vaultRoot
 * @param {{readFile?: Function}} [opts]
 */
export async function readCacheFile(vaultRoot, { readFile: readFn = readFile } = {}) {
  try {
    const raw = await readFn(join(vaultRoot, '.llm-wiki-cache.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/**
 * 写 .llm-wiki-cache.json. 失败不抛 (warn to stderr).
 * @param {string} vaultRoot
 * @param {object} cache
 * @param {{writeFile?: Function}} [opts]
 */
export async function writeCacheFile(vaultRoot, cache, { writeFile: writeFn = writeFile } = {}) {
  try {
    await writeFn(join(vaultRoot, '.llm-wiki-cache.json'), JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {
    console.warn(`qmd-detect: cache write failed: ${e.message?.split('\n')[0] ?? 'unknown'}`);
  }
}

/**
 * 拿 vault mtime. DI 注入.
 * @param {string} vaultRoot
 * @param {{statMtimeMs?: Function}} [opts] - 返回 Number (ms), DI 注入测试
 */
export async function getVaultMtimeMs(vaultRoot, { statMtimeMs = realStatMtimeMs } = {}) {
  return statMtimeMs(vaultRoot);
}

async function realStatMtimeMs(p) {
  const s = await stat(p);
  return s.mtimeMs;
}

/**
 * 算 vault 大小: 数 .md 数, 应用 filterMdFiles.
 * @param {string} vaultRoot
 * @param {{listMd?: Function, nowMs?: Function}} [opts]
 *   listMd: (vaultRoot) => Promise<string[]> 返回 vault 内所有 .md 相对路径
 *   nowMs: () => number 返回当前时间 (ms)
 */
export async function computeVaultSize(vaultRoot, { listMd = realListMd, nowMs = Date.now } = {}) {
  const all = await listMd(vaultRoot);
  const filtered = filterMdFiles(all);
  return filtered.length;
}

// realListMd: 用 find 命令或 fs walk. 跨平台用 node:fs.readdir recurse.
import { readdir } from 'node:fs/promises';
async function realListMd(vaultRoot) {
  /** @type {string[]} */
  const results = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // 目录不存在 / 权限, 跳过
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && e.name.endsWith('.md')) {
        results.push(relative(vaultRoot, full).replace(/\\/g, '/'));
      }
    }
  }
  await walk(vaultRoot);
  return results;
}

/**
 * 主入口. DI 友好: 所有外部依赖通过 opts 注入.
 * @param {object} [opts]
 * @param {string} opts.vaultRoot - 必填, vault 根路径
 * @param {Function} [opts.execFn] - promisified execFile (DI), 默认 execFileP
 * @param {Function} [opts.nowMs] - () => ms, DI
 * @param {Function} [opts.stdoutWrite] - (chunk) => bool, DI 默认 console.log
 */
export async function runDetect({
  vaultRoot,
  execFn = execFileP,
  nowMs = Date.now,
  stdoutWrite = console.log,
  readFile: readFn = readFile,
  writeFile: writeFn = writeFile,
  statMtimeMs = realStatMtimeMs,
  listMd = realListMd,
} = {}) {
  try {
    // 1. 读 cache + state
    const cache = await readCacheFile(vaultRoot, { readFile: readFn });
    const state = await readStateFile(vaultRoot, { readFile: readFn });

    // 2. 比 mtime, 决定是否重数 vault
    const currentMtimeMs = await statMtimeMs(vaultRoot);
    const cachedMtimeMs = typeof cache.vault_mtime_ms === 'number' ? cache.vault_mtime_ms : null;
    const mtimeMatches = cachedMtimeMs !== null && Math.abs(currentMtimeMs - cachedMtimeMs) < 1;

    let vaultSize;
    let cacheAgeSeconds;
    if (mtimeMatches && typeof cache.vault_size === 'number') {
      vaultSize = cache.vault_size;
      cacheAgeSeconds = Math.max(0, Math.floor((nowMs() - (cache.last_run_ms ?? nowMs())) / 1000));
    } else {
      vaultSize = await computeVaultSize(vaultRoot, { listMd, nowMs });
      cacheAgeSeconds = 0;
    }

    // 3. 探 qmd
    const qmdAvailable = await detectQmdAvailable(execFn);

    // 4. 算 tier + effective_path + suggestion flags
    const tier = computeTier(vaultSize);
    const effectivePath = computeEffectivePath(state, tier, qmdAvailable);
    const override = state.path_override ?? null;
    const stateSkippedAt = state['引导_skipped_at'] ?? null;
    const { shouldSuggest, shouldWarn } = computeSuggestionFlags({
      tier, qmdAvailable, stateSkippedAt, override,
    });

    // 5. 写 cache
    const nowMsValue = nowMs();
    await writeCacheFile(vaultRoot, {
      vault_mtime_ms: currentMtimeMs,
      vault_size: vaultSize,
      qmd_available: qmdAvailable,
      last_run_ms: nowMsValue,
      tier,
      effective_path: effectivePath,
    }, { writeFile: writeFn });

    // 6. stdout 输出 system context
    const output = {
      tier,
      effective_path: effectivePath,
      qmd_available: qmdAvailable,
      vault_size: vaultSize,
      cache_age_seconds: cacheAgeSeconds,
      vault_mtime_iso: new Date(currentMtimeMs).toISOString(),
      state_override: override,
      should_suggest_qmd_install: shouldSuggest,
      should_warn_grep_unstable: shouldWarn,
    };
    stdoutWrite(`<system-context>\nllm-wiki-query path selection:\n  tier: ${tier} (vault_size: ${vaultSize} .md files)\n  effective_path: ${effectivePath}\n  qmd_available: ${qmdAvailable}\n  state_override: ${override ?? 'null'}\n  should_suggest_qmd_install: ${shouldSuggest}\n  should_warn_grep_unstable: ${shouldWarn}\n</system-context>`);

    return output;
  } catch (e) {
    console.warn(`qmd-detect: unexpected error: ${e.message?.split('\n')[0] ?? 'unknown'}, falling back`);
    const fallback = safeFallback();
    stdoutWrite(`<system-context>\nllm-wiki-query path selection: SAFE FALLBACK\n  tier: ${fallback.tier}\n  effective_path: ${fallback.effective_path}\n</system-context>`);
    return fallback;
  }
}

// CLI 入口
if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  const args = process.argv.slice(2);
  const vaultArg = args.find((a) => a.startsWith('--vault='));
  const vaultRoot = vaultArg ? vaultArg.slice('--vault='.length) : process.env.CLAUDE_PROJECT_DIR ?? process.cwd();

  runDetect({ vaultRoot })
    .then(() => process.exit(0))
    .catch(() => process.exit(0)); // 永远 exit 0, hook 不阻塞
}
```

- [ ] **Step 2: 跑全部测试**

Run: `node --test scripts/qmd-detect.test.mjs`
Expected: PASS (所有 group, 包括 main() 退出码 group 通过 spawn 调真实脚本).

- [ ] **Step 3: 手动验证脚本输出一致**

Run: `node scripts/qmd-detect.mjs --vault=.`
Expected: stdout 输出形如 `<system-context>...tier: small...effective_path: grep...</system-context>` (本仓 vault 极小, 必然 small/grep).

- [ ] **Step 4: Commit**

```bash
git add scripts/qmd-detect.mjs
git commit -m "feat(script): qmd-detect I/O + DI + main() + CLI 入口

- detectQmdAvailable / readCacheFile / writeCacheFile / getVaultMtimeMs /
  computeVaultSize + 真实实现
- runDetect() 主流程 DI 注入全依赖
- CLI 入口永远 exit 0, 失败降级输出 safe fallback system context
- stdout 输出格式按 spec §3.3 合同
- main() 退出码测试组 (Task 1 spawn 子进程验证)"
```

---

## Task 4: 加 SessionStart hook matcher

**Files:**
- Modify: `hooks/hooks.json`

- [ ] **Step 1: 在 SessionStart 数组里追加第二个 matcher**

当前 `hooks/hooks.json`:

```json
{
  "description": "Auto-update llm-wiki-plugin from GitHub on session start",
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

改为 (在 `SessionStart` 数组里加一项, 保留 check-update):

```json
{
  "description": "Auto-update llm-wiki-plugin + detect qmd path on session start",
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/check-update.mjs\"",
            "async": true
          },
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/qmd-detect.mjs\" --vault=\"${CLAUDE_PROJECT_DIR}\" 2>/dev/null",
            "async": true
          }
        ]
      }
    ]
  }
}
```

- [ ] **Step 2: 验证 JSON 合法**

Run: `node -e "console.log(JSON.parse(require('fs').readFileSync('hooks/hooks.json','utf8')))"`
Expected: 输出整段解析后的 JSON, 无 exception.

- [ ] **Step 3: Commit**

```bash
git add hooks/hooks.json
git commit -m "feat(hook): SessionStart 新增 qmd-detect matcher (与 check-update 并行)

- 第二个 hook command: \`node qmd-detect.mjs --vault=\$CLAUDE_PROJECT_DIR 2>/dev/null\`
- async: true 不阻塞 session start
- 2>/dev/null 屏蔽 stderr warning 不污染 LLM context
- 保留原有 check-update matcher, 两个 hook 并行"
```

---

## Task 5: 改 SKILL.md — 阶段 B 加路径选择 + 重写 qmd 决策段

**Files:**
- Modify: `skills/llm-wiki-query/SKILL.md`

- [ ] **Step 1: 在 SKILL.md 阶段 B 顶部 (当前 B0 段下, 紧接 B0「入口优先级」之前) 插入新的路径选择流程**

找到当前:

```markdown
## 阶段 B：查询阶段（无 vault 写操作）

**唯一召回路径：朴素 Grep**（按 karpathy 起手姿势）。**不**再依赖 qmd MCP、不需要混合检索框架。

### B0：入口优先级
```

替换为:

```markdown
## 阶段 B：查询阶段（无 vault 写操作）

**路径选择：v3 由 SessionStart hook 注入 system context 决定.** 朴素 Grep 与 qmd MCP 共存, LLM 按 system context 里的 `effective_path` 调对应工具. 详见末尾 §"v3 路径选择".

### B0：读 system context 路径决策
```

- [ ] **Step 2: 在 SKILL.md 阶段 B0 之后插入新分支描述**

紧跟新 B0 段后追加:

```markdown
**B0.0 读 system context:** SessionStart 时 `hooks/hooks.json` matcher 调用 `scripts/qmd-detect.mjs`, 已注入 LLM context 一段形如:

```
<system-context>
llm-wiki-query path selection:
  tier: <small|medium|large> (vault_size: <N> .md files)
  effective_path: <grep|qmd>
  qmd_available: <true|false>
  state_override: <grep|qmd|auto|null>
  should_suggest_qmd_install: <bool>
  should_warn_grep_unstable: <bool>
</system-context>
```

LLM 记下 `effective_path` 进入 B0.1.

**B0.1 按 effective_path 分支:**

- `effective_path === "grep"`:
  走 B1 (v2 老路径) — 多 anchor Grep + Read frontmatter+重点段.
- `effective_path === "qmd"`:
  - 调 `mcp__qmd__query({vec: <用户原问题>, limit: 10})` 取 recall 结果 (path + snippet + score).
  - 对 `score ≥ 0.6` 的 hits 调 `mcp__qmd__get({path})` 取完整内容; 缺失的 fallback 到 Read 工具读对应路径.
  - 与 grep 模式同样要求: 读 frontmatter + 关键段 (`## 重点摘录` / `## 我的思考` / entity 5-6 段 / concept 定义段) 重建 `[[wiki 链接]]` 粒度.
  - qmd MCP 工具调用失败 (`tool_not_found` / `timeout`) → 降级到 B1 多 anchor Grep 路径, 主对话输出 `[qmd MCP 不可用, fallback 朴素 Grep 召回]` warning 一句 (不阻塞).

**B0.2 引导逻辑 (按 system context 的 flags):**

- `should_suggest_qmd_install === true` (medium tier + qmd 未装 + 引导未跳过):
  主对话输出**一次性**装说明: 「vault >= 500 且当前用朴素 Grep, 你可以考虑装 [qmd](https://github.com/tobi/qmd) 提升召回 (npm i -g @tobilu/qmd). 跳过则后续不再提示 (vault >= 3000 时除外).」
  vault 用户回「跳过」 → 写 vault root `.llm-wiki-query-state.json`:
  ```json
  {"引导_skipped_at": "<当前 ISO 8601>"}
  ```
  若 vault 用户不表态 → 本次 session 不再问, 下次 SessionStart 重新判断.
- `should_warn_grep_unstable === true` (large tier + qmd 未装 + 未 override):
  主对话在**每次询问阶段 B 之前**输出强提示: 「vault >= 3000 朴素 Grep 召回不稳, 强烈建议装 qmd (npm i -g @tobilu/qmd). 已装后下次 session 自动切.」
  直到 vault 用户装上 **或** 在 vault root `.llm-wiki-query-state.json` 写 `"path_override": "grep"` 显式拒绝.

### B0：入口优先级 (vault 内部目录, 不变)
```

- [ ] **Step 3: 替换 SKILL.md 末尾旧「Optional: 何时用朴素 grep」决策段**

当前 (§8 节附近):

```markdown
# Optional: 何时用朴素 grep，何时考虑 qmd

本 skill 当前**唯一召回路径是朴素 Grep + Read**（阶段 B）。[`qmd`](https://github.com/tobi/qmd)（npm 包名 `@tobilu/qmd`）是 markdown 文件的本地混合检索（BM25 + 向量 + LLM rerank），是本 skill 的可选升级——但**即便装上，本 skill 也不会自动切过去**，见末尾「装好后也不自动用」。

设计依据参考本仓 `reference/llm-wiki.md`（karpathy LLM Wiki 原文）§"Optional: CLI tools"——「at small scale the index file is enough, but as the wiki grows you want proper search」。

## 决策表（vault 用户当前用 grep；满足「上 qmd」一节条件时才考虑切）
```

替换为 (v3 自动路径选择版, 委托给 B0):

```markdown
# v3 路径选择 (SessionStart hook + state.json override)

v3 起, 召回路径**自动**由 `scripts/qmd-detect.mjs` 决定, LLM 仅按 system context 调对应工具 (阶段 B0). vault 用户无需手动选.

**三档 (vault_size 计算 = 递归数 vault 根 .md, 排除 00_模板/ .obsidian/ node_modules/ .git/ temp/):**

| tier | vault_size | automatic 行为 |
| --- | --- | --- |
| `small` | `< 500` | 强制 `grep` (不探 qmd, 不出提示) |
| `medium` | `500 ≤ v < 3000` | qmd 装了就 `qmd`, 没装就 `grep` + **首次引导装一次** |
| `large` | `>= 3000` | qmd 装了就 `qmd`, 没装就 `grep` + **每次询问前强提示** |

`vault_size` 阈值 (500 / 3000) 写死在 `scripts/qmd-detect.mjs` 顶部 `THRESHOLDS`.

## vault 用户 override (可选)

写 vault root `.llm-wiki-query-state.json`:

```json
{
  "path_override": "grep",   // "grep" | "qmd" | "auto" (= 缺省, 自动)
  "引导_skipped_at": "2026-08-29T10:00:00Z"   // 可选, medium tier 跳过引导后写入
}
```

- `path_override: "grep"` — 永远用 grep (vault >= 3000 时用于解封强提示)
- `path_override: "qmd"` — 永远用 qmd (qmd 未装时 LLM 端报 tool-not-found, fallback 到 grep)
- 字段缺失/非法值 → 忽略, 走 auto.

## 设计依据

`scripts/qmd-detect.mjs` 路径决策由 Node 脚本决定 — 不依赖 LLM 自检, 可文档化 / 可测试 / 行为可预测. 三件套: 脚本 + SessionStart hook + state.json override. 完整 spec 见 [docs/superpowers/specs/spec-query.md](../superpowers/specs/spec-query.md).

karpathy LLM Wiki 原文 `reference/llm-wiki.md` §"Optional: CLI tools" 仍为顶层依据: 「at small scale the index file is enough, but as the wiki grows you want proper search」.

## Q1-Q5 与引用粒度

v3 设计明示接受两条 trade-off (写在 [spec §7](docs/superpowers/specs/spec-query.md#7)):

- **Q1-Q5 跨模式不感知** — LLM 看答案本身, 阈值不按召回路径调优.
- **qmd 召回后补 Read 重建 `[[wiki 链接]]` 粒度** — qmd 召回时 hit 列表是 `path+snippet+score`, 后续用 Read 工具读 frontmatter+重点段, 与 grep 模式粒度对齐.
```

- [ ] **Step 4: 跑一次本地验证 (e2e)**

Run: `node scripts/llm-wiki-query-self-check.mjs 2>/dev/null || echo "no self-check script, skip e2e"`
Expected: skip 是 OK (没有 self-check 脚本). 走 manual: 用 Read 工具读改完的 SKILL.md, 确认阶段 B0 段、末尾 v3 段都已更新, 无残留「qmd 也不自动切」字样.

- [ ] **Step 5: Commit**

```bash
git add skills/llm-wiki-query/SKILL.md
git commit -m "feat(skill): SKILL.md 加 v3 阶段 B0 路径选择 + 末尾决策段重写

- 阶段 B 顶部加 B0 路径选择子流程 (读 system context + effective_path 分支)
- B0.2 引导逻辑: medium 一次性 / large 每次提示
- 替换旧「唯一召回路径: 朴素 Grep」措辞 (矛盾)
- 末尾「何时用 grep 何时考虑 qmd」段重写为「v3 路径选择 (SessionStart hook + state.json override)」
- 明确写 v3 设计依据 + Q1-Q5 / 引用粒度的 trade-off"
```

---

## Task 6: 改 Log_Spec.md — 召回方式枚举扩 qmd 值

**Files:**
- Modify: `00_模板/Log_Spec.md`

- [ ] **Step 1: 找到 §3.4 召回方式枚举行**

当前:

```markdown
- `召回方式`：`Grep`（必填；当前 llm-wiki-query 仅走朴素 Grep 路径，未来若引入新召回路径再扩枚举）
```

替换为:

```markdown
- `召回方式`：`Grep` / `qmd`（必填；v3 起 llm-wiki-query 由 SessionStart hook 注入 system context 决定走哪条路径, 本字段记录本次实际用的路径）
```

- [ ] **Step 2: Commit**

```bash
git add "00_模板/Log_Spec.md"
git commit -m "feat(template): Log_Spec §3.4 召回方式枚举扩 'qmd' 值

v3 起 llm-wiki-query 自动路径选择后, Log 记录本次实际走 grep 还是 qmd。
Grep 保留, 新增 'qmd' 值。"
```

---

## Task 7: 改 plugin CLAUDE.md — ASCII 协作图 + 文件索引表 sync

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: ASCII 协作图 llm-wiki-query 区块 + 五 skill 流程图文字描述 sync**

找 ASCII 图里 llm-wiki-query 区块:

```bash
grep -n "llm-wiki-query\|qmd 召回\|朴素 Grep" CLAUDE.md
```

把 ASCII 图里 llm-wiki-query 描述从「朴素 Grep 召回 / 用户确认后归档」改为「SessionStart hook 注入路径决策 / 朴素 Grep or qmd / 用户确认后归档」。

- [ ] **Step 2: 关键文件索引表 SKILL.md 行补 scripts/qmd-detect.mjs 关联**

找到:

```markdown
| `skills/llm-wiki-query/SKILL.md` | 中 | `10_schema/config.md §1` + `00_模板/Log_Spec.md §3.4` + `00_模板/CLAUDE_Template.md` 铁律 #2（检索优先级）。**设计依据**：[reference/llm-wiki.md](reference/llm-wiki.md) L51-L53 "Optional: CLI tools"——karpathy 明确说「at small scale the index file is enough，as the wiki grows you want proper search」，朴素 Grep 是起步姿势，qmd 是 wiki 长大的升级选项 |
```

替换为:

```markdown
| `skills/llm-wiki-query/SKILL.md` | 中 | `10_schema/config.md §1` + `00_模板/Log_Spec.md §3.4` + `00_模板/CLAUDE_Template.md` 铁律 #2（检索优先级）+ `scripts/qmd-detect.mjs`（v3 路径选择脚本）。**设计依据**：[reference/llm-wiki.md](reference/llm-wiki.md) L51-L53 "Optional: CLI tools" + spec v3 [docs/superpowers/specs/spec-query.md](docs/superpowers/specs/spec-query.md) (commit `779324a`) |
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "docs(plugin): 五 skill 协作图 + 文件索引表 sync llm-wiki-query v3

- ASCII 图 llm-wiki-query 区块描述加 'SessionStart hook 注入路径决策'
- 文件索引表 SKILL.md 行加 \`scripts/qmd-detect.mjs\` 关联 + spec 引用"
```

---

## Task 8: 改 README.md — 「关于 llm-wiki-query 的召回路径」段 sync

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 找到「关于 llm-wiki-query 的召回路径」段**

当前段:

```markdown
## 关于 `llm-wiki-query` 的召回路径（朴素 Grep）

`llm-wiki-query` skill 默认走 **朴素 Grep**（LLM 自己用 `grep -rl` 扫 vault + `Read` 深读），不依赖任何外部搜索引擎。

**为什么不再走 qmd MCP：** 朴素 Grep + 多 anchor 召回对小 vault 够用（你的笔记规模还没到必须用 BM25/向量检索的程度），且零运行时依赖 / 零外部组件 / 零安装成本。未来若 vault 规模上去需要语义搜索，再起独立 skill 接入 qmd。

**设计依据：** [reference/llm-wiki.md](reference/llm-wiki.md) §"Optional: CLI tools"——karpathy 明确说「at small scale the index file is enough, but as the wiki grows you want proper search」，qmd 是 wiki 长大的升级选项，不是默认。

详见 spec：[docs/superpowers/specs/2026-08-23-query-skill-design.md](docs/superpowers/specs/2026-08-23-query-skill-design.md)。**注意**：该 spec 写于 v2（含 qmd MCP 路径），归档保留供考古；当前 SKILL.md 实现以朴素 Grep 为准。
```

替换为 (v3 自动路径选择版):

```markdown
## 关于 `llm-wiki-query` 的召回路径（v3 自动选择）

`llm-wiki-query` skill **自动**根据 vault 大小选择朴素 Grep 或 qmd MCP 召回。SessionStart 时跑 [`scripts/qmd-detect.mjs`](../scripts/qmd-detect.mjs)，结果注入 LLM context 一段 `<system-context>`，LLM 按 `effective_path` 调对应工具。

**三档：**

| vault 大小 | 自动行为 |
| --- | --- |
| `< 500` 笔记 | 强制朴素 Grep |
| `500-3000` | qmd 装了 → qmd；没装 → 朴素 Grep + 首次引导装 |
| `>= 3000` | qmd 装了 → qmd；没装 → 朴素 Grep + 每次强提示 |

**为什么用 v3 自动选择而不是纯 grep：** 朴素 Grep 在小 vault 完美够用，但 vault 长到 1500+ 后召回噪声大。v3 把路径决策交给 Node 脚本，LLM 按指令执行——比 v2 的「LLM 自检 vault 大小」更可文档化、更可测试。

**vault 用户 override：** 写 vault root `.llm-wiki-query-state.json`：

```json
{
  "path_override": "grep",   // 或 "qmd" / "auto"
  "引导_skipped_at": "2026-08-29T10:00:00Z"
}
```

**设计依据：** karpathy LLM Wiki 原文 `reference/llm-wiki.md` §"Optional: CLI tools"——「at small scale the index file is enough, but as the wiki grows you want proper search」。v3 完整 spec 见 [docs/superpowers/specs/spec-query.md](../superpowers/specs/spec-query.md)。

**关于 qmd 的安装：** 见 [github.com/tobi/qmd](https://github.com/tobi/qmd)（npm: `@tobilu/qmd`）。vault 用户手动 `npm i -g @tobilu/qmd` 后下次 SessionStart 自动切到 qmd 路径。
```

- [ ] **Step 2: 如果 README 还有提及「可选 qmd」类似老段, 替换或合并**

Run: `grep -n "qmd" README.md`
确认所有「可选：qmd 接入」之类老段已被新段取代.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(readme): 「关于 llm-wiki-query 的召回路径」段重写为 v3 自动选择版

- 删旧「可选：qmd 接入」段, 合并到新的 v3 自动选择段
- 三档表格 + state.json override 说明 + qmd 安装 link
- 指向 spec v3 + karpathy 原文"
```

---

## 自审（按 writing-plans checklist）

**Spec coverage:**

- §1 阈值与分档 → Task 2 (computeTier) + Task 5 (SKILL.md 段表)
- §2 state.json override 优先级 → Task 2 (computeEffectivePath) + Task 5 (state.json override 段)
- §3.1 qmd-detect.mjs 职责 → Task 2 + Task 3
- §3.2 hooks.json 新增 matcher → Task 4
- §3.3 hook 输出注入 LLM context → Task 3 (stdout 输出格式) + Task 5 (system context 读取步骤)
- §4 数据流 → Task 5 (B0.x 段) + spec 数据流图本身保留
- §5 错误处理 → Task 3 (safe fallback) + Task 1 (exit 0 退出码测试)
- §6 测试覆盖 (11 项) → Task 1 (测试骨架覆盖 9 项, vault mtime + cache 行为在 Task 3 实现后跑过)
- §7 已知 trade-off → Task 5 (B0 段 + 末尾段写明)
- §8 变更清单 → Task 1-7 共 7 个 commit, Task 8 = plugin CLAUDE.md sync (8 个 total)
- §9 future work → 不在本 plan 实现, spec 段保留供未来

**Placeholder scan:** 无 TBD / TODO / 占位符.

**Type consistency:**

- `computeTier(vaultSize: number) → 'small'|'medium'|'large'` (Task 2) → `computeEffectivePath(state, tier, qmdAvailable)` (Task 2) → `computeSuggestionFlags({tier, qmdAvailable, stateSkippedAt, override})` (Task 2) — 三处 `tier` 字面量集合同.
- `state.path_override` 字段值 `'grep'` / `'qmd'` / `'auto'` — Task 2 computeEffectivePath + Task 5 state.json 示例 + Task 8 README 示例 三处一致.
- `state['引导_skipped_at']` 中文字段名 — Task 2 + Task 5 + Task 8 README 一致.
- `THRESHOLDS = { small: 500, large: 3000 }` — Task 2 + Task 5 SKILL.md 末段表格 + spec §1 一致.
- 输出 JSON 字段名 `effective_path` / `qmd_available` / `vault_size` / `cache_age_seconds` / `vault_mtime_iso` / `state_override` / `should_suggest_qmd_install` / `should_warn_grep_unstable` — spec §3.1 输出块 + Task 3 runDetect() + Task 5 system context 段 三处一致.
- CLI 参数 `--vault=` — spec §3.1 + Task 3 CLI 入口 + Task 4 hooks.json 命令 三处一致.

**粒度:** 每个 Step 都是 2-5 分钟动作; 每个 Task 1 个 commit (符合 plugin CLAUDE.md「单文件改动单文件提交」).

**DRY:** `THRESHOLDS` / `EXCLUDED_PREFIXES` 都从 spec §1 / §3.1 抽出到 qmd-detect.mjs 顶部, SKILL.md 与 README 不重复定义, 通过引用 `scripts/qmd-detect.mjs` 顶部常量.

**YAGNI:** 不写 e2e 测试 (依赖 Claude Code session); 不写 lint-wiki 对 state.json 校验 (v4 future); 不把 state.json 拆出独立目录.

---

## 最终 commit 列表（按 plugin CLAUDE.md 第 61 行纪律）

| # | Commit Type | 文件 |
|---|---|---|
| 1 | `test(script)` | `scripts/qmd-detect.test.mjs` (Task 1) |
| 2 | `feat(script)` | `scripts/qmd-detect.mjs` (Task 2) |
| 3 | `feat(script)` | `scripts/qmd-detect.mjs` (Task 3) |
| 4 | `feat(hook)` | `hooks/hooks.json` (Task 4) |
| 5 | `feat(skill)` | `skills/llm-wiki-query/SKILL.md` (Task 5) |
| 6 | `feat(template)` | `00_模板/Log_Spec.md` (Task 6) |
| 7 | `docs(plugin)` | `CLAUDE.md` (Task 7) |
| 8 | `docs(readme)` | `README.md` (Task 8) |

共 8 个独立 commit. (Task 2 / Task 3 都改 `scripts/qmd-detect.mjs` — Task 3 在 Task 2 之后追加实现 I/O + main, 同一个文件的连续改动按 plugin「单文件改动」原则可合并成一个 commit。但为清晰: 保持两个 commit, 第二 commit message 标「feat(script): qmd-detect I/O + DI + main」. 如要 squash, 用户决定.)
