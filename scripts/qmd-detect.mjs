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

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

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
