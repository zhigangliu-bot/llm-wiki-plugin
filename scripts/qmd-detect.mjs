#!/usr/bin/env node
/**
 * qmd-detect.mjs — SessionStart hook: 探测 vault 大小 + qmd 可用性,
 * 算出 tier + effective_path, 注入 LLM system context.
 *
 * 行为契约见 docs/superpowers/specs/spec-query.md (v3, commit 779324a)
 *
 * 失败兜底: 任何异常 → stdout safe fallback JSON + exit 0 (不阻断 session)
 *
 * 架构: 依赖注入 (DI). Task 2 仅 `readStateFile` 暴露 readFile seam;
 *       Task 3 扩展到全部外部依赖 (exec / mtime / listMd / nowMs).
 *       测试时传 mock, 绕开 Node 22 内置模块 namespace 冻结问题.
 */

import { readFile, writeFile, stat, readdir } from 'node:fs/promises';
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
  // state 应当是对象; 非对象防御性 fallback 到 'small' 行为
  const s = (state && typeof state === 'object') ? state : {};
  if (s.path_override === 'grep') return 'grep';
  if (s.path_override === 'qmd') return 'qmd';
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
 * @returns {{ shouldSuggest: boolean, shouldWarn: boolean }}
 */
export function computeSuggestionFlags({ tier, qmdAvailable, stateSkippedAt, override }) {
  const shouldSuggest =
    tier === 'medium' &&
    !qmdAvailable &&
    !stateSkippedAt &&
    override !== 'grep';
  const shouldWarn =
    tier === 'large' && !qmdAvailable && override !== 'grep' && override !== 'qmd';
  return { shouldSuggest, shouldWarn };
}

/**
 * 安全降级 JSON: hook 失败时永远输出这个.
 * @returns {{
 *   tier: 'small',
 *   effective_path: 'grep',
 *   qmd_available: false,
 *   vault_size: number,
 *   cache_age_seconds: number,
 *   vault_mtime_iso: string,
 *   state_override: null,
 *   should_suggest_qmd_install: false,
 *   should_warn_grep_unstable: false
 * }}
 */
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

// realListMd: 用 fs walk. 跨平台用 node:fs.readdir recurse.
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
    .then((output) => {
      // 输出 JSON 供下游 (测试 / 其他 hook) 解析
      console.log(JSON.stringify(output));
      process.exit(0);
    })
    .catch(() => process.exit(0)); // 永远 exit 0, hook 不阻塞
}
