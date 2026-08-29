/**
 * qmd-detect.test.mjs
 *
 * Run with: node --test scripts/qmd-detect.test.mjs
 *
 * 策略:
 *   1. 预留 DI 注入 seam (Task 3 补 mock fileSystem / execFn / mtimeFn),
 *      不 mutate 任何内置模块 namespace
 *      (Node 22 冻结 ESM namespace, fs = X 会抛)
 *   2. 通过 tmp vault 目录测真实路径行为;纯函数测逻辑.
 *   3. 测 vault 用户 state.json 容错.
 */
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  computeTier,
  computeEffectivePath,
  filterMdFiles,
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
  // computeSuggestionFlags / safeFallback / readStateFile 在 Task 2 才导出,
  // 暂用动态 import;Task 3 后可改为静态 import
  test('should_suggest_qmd_install: medium + qmd 未装 + 引导未跳过', async () => {
    const mod = await import('./qmd-detect.mjs');
    const flags = mod.computeSuggestionFlags({
      tier: 'medium',
      qmdAvailable: false,
      stateSkippedAt: null,
      override: null,
    });
    assert.equal(flags.shouldSuggest, true);
  });
  test('should_suggest_qmd_install: 引导跳过 (state.引导_skipped_at 非空) 后 = false', async () => {
    const mod = await import('./qmd-detect.mjs');
    const flags = mod.computeSuggestionFlags({
      tier: 'medium',
      qmdAvailable: false,
      stateSkippedAt: '2026-08-29T10:00:00Z',
      override: null,
    });
    assert.equal(flags.shouldSuggest, false);
  });
  test('should_warn_grep_unstable: large + qmd 未装 + override !== grep = true', async () => {
    const mod = await import('./qmd-detect.mjs');
    const flags = mod.computeSuggestionFlags({
      tier: 'large',
      qmdAvailable: false,
      stateSkippedAt: null,
      override: null,
    });
    assert.equal(flags.shouldWarn, true);
  });
  test('should_warn_grep_unstable: override=grep 后 = false', async () => {
    const mod = await import('./qmd-detect.mjs');
    const flags = mod.computeSuggestionFlags({
      tier: 'large',
      qmdAvailable: false,
      stateSkippedAt: null,
      override: 'grep',
    });
    assert.equal(flags.shouldWarn, false);
  });
  test('should_warn_grep_unstable: qmd 已装 = false', async () => {
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
  test('safeFallback() 返回兜底 JSON: tier=small, effective_path=grep', async () => {
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

  test('state.json 缺字段 / 错类型不抛, 走 auto 决策', async () => {
    const mod = await import('./qmd-detect.mjs');
    // 写坏的 state.json
    await writeFile(join(tmpVault, '.llm-wiki-query-state.json'), '{"path_override": 123}');
    const state = await mod.readStateFile(tmpVault);
    // path_override 错类型 → 忽略, fallback auto
    assert.equal(state.path_override, undefined);
  });
  test('state.json path_override 非法字符串 → 忽略, fallback auto', async () => {
    const mod = await import('./qmd-detect.mjs');
    await writeFile(join(tmpVault, '.llm-wiki-query-state.json'), '{"path_override": "banana"}');
    const state = await mod.readStateFile(tmpVault);
    assert.equal(state.path_override, 'banana'); // 字段读出,但 computeEffectivePath 容错
    // computeEffectivePath 处理后会忽略 'banana'
    assert.equal(computeEffectivePath(state, 'medium', true), 'qmd', `path_override=${state.path_override}`);
  });
  test('state.json 不存在时返回空对象不抛', async () => {
    const mod = await import('./qmd-detect.mjs');
    const state = await mod.readStateFile(tmpVault);
    assert.deepEqual(state, {});
  });
});

describe('qmd-detect main() 退出码', () => {
  let tmpVault;
  let ORIGINAL_PLUGIN_ROOT;
  beforeEach(async () => {
    tmpVault = await mkdtemp(join(tmpdir(), 'qmd-detect-test-'));
    ORIGINAL_PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT;
    process.env.CLAUDE_PLUGIN_ROOT = tmpVault;
  });
  afterEach(async () => {
    if (ORIGINAL_PLUGIN_ROOT === undefined) delete process.env.CLAUDE_PLUGIN_ROOT;
    else process.env.CLAUDE_PLUGIN_ROOT = ORIGINAL_PLUGIN_ROOT;
    await rm(tmpVault, { recursive: true, force: true });
  });

  test('vault 不存在时 main 仍 exit 0, 输出 safe fallback system-context 块', async () => {
    const { spawnSync } = await import('node:child_process');
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const SCRIPT_PATH = join(__dirname, 'qmd-detect.mjs');
    const VAULT_ARG = `--vault=${join(tmpVault, 'nonexistent')}`;
    const result = spawnSync(process.execPath, [SCRIPT_PATH, VAULT_ARG], {
      timeout: 5000,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    // spec §3.3 唯一契约: stdout 只有 <system-context>...</system-context> 块
    assert.match(result.stdout, /<system-context>[\s\S]*?<\/system-context>/);
    assert.match(result.stdout, /SAFE FALLBACK/);
    assert.match(result.stdout, /tier: small/);
    assert.match(result.stdout, /effective_path: grep/);
    // 不应再额外 JSON.stringify 输出 (fix B: spec §3.3 唯一契约是 system-context 块)
    assert.doesNotMatch(result.stdout, /"tier":\s*"small"/);
  });
});