/**
 * check-update.test.mjs
 *
 * Run with: node --test scripts/check-update.test.mjs
 *
 * 策略:
 *   1. 通过 DI 注入 mock execFn,不 mutate 任何内置模块 namespace
 *      (Node 22 冻结 ESM namespace,直接 cp.execFile = X 会抛)
 *   2. 通过 CLAUDE_PLUGIN_ROOT env 注入 fake plugin 根,不 process.chdir
 *      (Windows 上 rm 当前 cwd 抛 EBUSY;env 注入不踩 cwd)
 */
import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runUpdate } from './check-update.mjs';

describe('check-update', () => {
  let tmpCwd;
  let stdoutChunks;
  let execCallLog;
  const ORIGINAL_PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT;

  beforeEach(async () => {
    tmpCwd = await mkdtemp(join(tmpdir(), 'check-update-test-'));
    process.env.CLAUDE_PLUGIN_ROOT = tmpCwd;

    stdoutChunks = [];
    execCallLog = [];
    mock.method(process.stdout, 'write', (chunk) => {
      stdoutChunks.push(chunk.toString());
      return true;
    });
  });

  afterEach(async () => {
    mock.restoreAll();
    // 还原 env,避免串味到其他 test 文件
    if (ORIGINAL_PLUGIN_ROOT === undefined) {
      delete process.env.CLAUDE_PLUGIN_ROOT;
    } else {
      process.env.CLAUDE_PLUGIN_ROOT = ORIGINAL_PLUGIN_ROOT;
    }
    // cwd 始终未变(plugin 仓根),rm 不会 EBUSY
    await rm(tmpCwd, { recursive: true, force: true });
  });

  function getStdout() {
    return stdoutChunks.join('');
  }

  /**
   * 构造 mock execFn: 用 handler map 决定不同 git 调用返回什么
   * @param {Record<string, (cmd: string, args: string[]) => {stdout: string, stderr: string} | never>} handlers
   */
  function makeExecFn(handlers) {
    return async (cmd, args) => {
      const key = args.join(' ');
      execCallLog.push({ cmd, args: [...args] });
      const handler = handlers[key];
      if (!handler) throw new Error(`unexpected git call: ${key}`);
      const result = handler(cmd, args);
      if (result instanceof Error) throw result;
      return result;
    };
  }

  test('1. cwd 不是 git 仓 → warning + exit 0', async () => {
    const execFn = makeExecFn({
      'rev-parse --git-dir': () => {
        const e = new Error('not a git repository');
        e.stderr = 'fatal: not a git repository\n';
        throw e;
      },
    });
    await runUpdate({ execFn });
    const out = getStdout();
    assert.ok(out.includes('⚠'), `expected ⚠, got: ${out}`);
    assert.ok(out.includes('not a git repository'), `expected warning message, got: ${out}`);
  });

  test('2. fetch 失败(无网络)→ warning + exit 0', async () => {
    const execFn = makeExecFn({
      'rev-parse --git-dir': () => ({ stdout: '.git\n', stderr: '' }),
      'fetch origin main': () => {
        const e = new Error('Could not resolve');
        e.stderr = 'fatal: unable to access: Could not resolve host\n';
        throw e;
      },
    });
    await runUpdate({ execFn });
    const out = getStdout();
    assert.ok(out.includes('⚠') && out.includes('update check failed'), `expected warning, got: ${out}`);
    assert.ok(!out.includes('✓'), '不应有更新成功标记');
  });

  test('3. 本地 = origin → 静默成功(空 stdout)', async () => {
    const execFn = makeExecFn({
      'rev-parse --git-dir': () => ({ stdout: '.git\n', stderr: '' }),
      'fetch origin main': () => ({ stdout: '', stderr: '' }),
      'rev-parse HEAD': () => ({ stdout: 'abcdef1234567890abcdef1234567890abcdef12\n', stderr: '' }),
      'rev-parse origin/main': () => ({ stdout: 'abcdef1234567890abcdef1234567890abcdef12\n', stderr: '' }),
    });
    await runUpdate({ execFn });
    assert.equal(getStdout().trim(), '', `expected silent, got: "${getStdout()}"`);
  });

  test('4. 本地 < origin + 无本地改动 → ✓ updated: old..new', async () => {
    const execFn = makeExecFn({
      'rev-parse --git-dir': () => ({ stdout: '.git\n', stderr: '' }),
      'fetch origin main': () => ({ stdout: '', stderr: '' }),
      'rev-parse HEAD': () => ({ stdout: 'aaaaaa1234567890\n', stderr: '' }),
      'rev-parse origin/main': () => ({ stdout: 'bbbbbb1234567890\n', stderr: '' }),
      'pull --ff-only origin main': () => ({ stdout: 'Updating aaaaaa..bbbbbb\nFast-forward\n', stderr: '' }),
      'rev-parse --short HEAD': () => ({ stdout: 'bbbbbb1\n', stderr: '' }),
    });
    await runUpdate({ execFn });
    const out = getStdout();
    assert.ok(out.includes('✓'), `expected ✓, got: ${out}`);
    assert.ok(out.includes('updated'), `expected updated, got: ${out}`);
    assert.ok(out.includes('aaaaaa') && out.includes('bbbbbb'), `expected sha pair, got: ${out}`);
    assert.ok(!out.includes('⚠'), '不应有 warning');
  });

  test('5. 本地 < origin + 有本地未 commit 改动 + ff 成功 → ✓ updated(ff-only 不影响未 commit)', async () => {
    const execFn = makeExecFn({
      'rev-parse --git-dir': () => ({ stdout: '.git\n', stderr: '' }),
      'fetch origin main': () => ({ stdout: '', stderr: '' }),
      'rev-parse HEAD': () => ({ stdout: 'aaaaaa\n', stderr: '' }),
      'rev-parse origin/main': () => ({ stdout: 'bbbbbb\n', stderr: '' }),
      'pull --ff-only origin main': () => ({ stdout: 'Fast-forward\n', stderr: '' }),
      'rev-parse --short HEAD': () => ({ stdout: 'bbbbbb1\n', stderr: '' }),
    });
    await runUpdate({ execFn });
    assert.ok(getStdout().includes('✓'));
  });

  test('6. 本地 < origin + ff 失败(非快进)→ warning + exit 0', async () => {
    const execFn = makeExecFn({
      'rev-parse --git-dir': () => ({ stdout: '.git\n', stderr: '' }),
      'fetch origin main': () => ({ stdout: '', stderr: '' }),
      'rev-parse HEAD': () => ({ stdout: 'aaaaaa\n', stderr: '' }),
      'rev-parse origin/main': () => ({ stdout: 'bbbbbb\n', stderr: '' }),
      'pull --ff-only origin main': () => {
        const e = new Error('Not possible to fast-forward');
        e.stderr = 'fatal: Not possible to fast-forward, aborting.\n';
        throw e;
      },
    });
    await runUpdate({ execFn });
    const out = getStdout();
    assert.ok(out.includes('⚠') && out.includes('update skipped'), `expected skipped warning, got: ${out}`);
  });

  test('7. rev-parse HEAD 失败 → warning + exit 0(防御)', async () => {
    const execFn = makeExecFn({
      'rev-parse --git-dir': () => ({ stdout: '.git\n', stderr: '' }),
      'fetch origin main': () => ({ stdout: '', stderr: '' }),
      'rev-parse HEAD': () => {
        const e = new Error('HEAD error');
        e.stderr = 'fatal: ambiguous HEAD\n';
        throw e;
      },
    });
    await runUpdate({ execFn });
    assert.ok(getStdout().includes('⚠'));
  });

  test('8. stdout 格式: ✓/⚠ 前缀 + 单行', async () => {
    const execFn = makeExecFn({
      'rev-parse --git-dir': () => {
        const e = new Error('x');
        e.stderr = 'not a git\n';
        throw e;
      },
    });
    await runUpdate({ execFn });
    const lines = getStdout().trim().split('\n');
    assert.equal(lines.length, 1, `expected single line, got ${lines.length}: ${getStdout()}`);
    assert.match(lines[0], /^[✓⚠] llm-wiki-plugin /, `expected ✓/⚠ prefix, got: ${lines[0]}`);
  });
});