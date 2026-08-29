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