#!/usr/bin/env node
/**
 * check-update.mjs — SessionStart hook: git pull --ff-only plugin 仓本地副本
 *
 * 行为契约见 docs/superpowers/specs/2026-08-23-session-start-update-check-design.md
 *
 * 失败兜底: 任何异常 → stdout warning + exit 0 (不阻断 session)
 *
 * 架构: 依赖注入 (DI)。runUpdate() 接收可选的 execFn 参数,默认 = 真实 execFile。
 *       测试时传入 mock 函数,绕开 Node 22 内置模块 namespace 冻结问题。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

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
 *
 * @param {Function} execFn - promisified execFile (DI 注入,默认 = 真实 execFile)
 * @param  {...string} args - git 子命令 + 参数
 */
async function git(execFn, ...args) {
  try {
    const { stdout, stderr } = await execFn('git', args, { cwd: PLUGIN_ROOT });
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

/**
 * 主流程。export 出供单元测试。
 * @param {object} [opts]
 * @param {Function} [opts.execFn] - promisified execFile,默认 execFileP
 */
export async function runUpdate({ execFn = execFileP } = {}) {
  // 1. cwd 必须是 git 仓
  const rev = await git(execFn, 'rev-parse', '--git-dir');
  if (!rev.ok) {
    warn('update skipped: not a git repository');
    return;
  }

  // 2. fetch
  const fetch = await git(execFn, 'fetch', 'origin', 'main');
  if (!fetch.ok) {
    warn(`update check failed: ${fetch.stderr || 'fetch error'}`);
    return;
  }

  // 3. 拿本地 + 远端 SHA
  const local = await git(execFn, 'rev-parse', 'HEAD');
  const remote = await git(execFn, 'rev-parse', 'origin/main');
  if (!local.ok || !remote.ok) {
    warn('update check failed: rev-parse error');
    return;
  }

  // 4. 无更新
  if (local.stdout === remote.stdout) return;

  // 5. ff-only pull
  const pull = await git(execFn, 'pull', '--ff-only', 'origin', 'main');
  if (pull.ok) {
    const newHead = await git(execFn, 'rev-parse', '--short', 'HEAD');
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