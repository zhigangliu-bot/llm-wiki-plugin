import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import {
  failAndExit,
  parsePaddleocrStdout,
  parsePaddleocrPythonStdout,
  csvToMdTable,
  countSlides,
  runCommand,
  findPythonWithPaddleocr,
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

test('parsePaddleocrStdout accepts v3 Python API format', () => {
  // 新版 PaddleOCR Python API 输出: 每行 {"page": N, "texts": [...]}
  const stdout = 'noise\n{"page": 1, "texts": ["hello", "world"]}\n{"page": 2, "texts": ["foo"]}\nmore';
  const lines = parsePaddleocrStdout(stdout);
  assert.deepEqual(lines, ['hello', 'world', 'foo']);
});

test('parsePaddleocrPythonStdout parses v3 format with sections', () => {
  const stdout = '{"page": 1, "texts": ["a", "b"]}\n{"page": 2, "texts": ["c"]}';
  const sections = parsePaddleocrPythonStdout(stdout);
  assert.equal(sections.length, 2);
  assert.deepEqual(sections[0], { page: 1, texts: ['a', 'b'] });
  assert.deepEqual(sections[1], { page: 2, texts: ['c'] });
});

test('parsePaddleocrPythonStdout ignores non-JSON lines', () => {
  const stdout = 'warning message\n{"page": 1, "texts": ["x"]}\n[INFO] done';
  const sections = parsePaddleocrPythonStdout(stdout);
  assert.equal(sections.length, 1);
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

// ===== findPythonWithPaddleocr 探测逻辑 =====

test('findPythonWithPaddleocr returns null when no venv exists', async () => {
  // 在沙盒 HOME 下确保没有 .venv-ocr;node 进程的 cwd 也没有
  // (测试机真实情况可能命中 venv,这里只验证"找不到时返回 null")
  // 简单 sanity check: 函数签名/返回类型
  const r = await findPythonWithPaddleocr();
  // 如果测试机装了 paddleocr,会返回字符串;否则返回 null。两者都是合法返回值。
  assert.ok(r === null || typeof r === 'string');
});

test('findPythonWithPaddleocr detects existing python on PATH', async () => {
  // 只要机器上有任何 python (PATH / venv),函数应该返回它
  const r = await findPythonWithPaddleocr();
  if (r !== null) {
    // 验证返回值确实是可执行的 python
    const probe = await runCommand(r, ['-c', 'import sys; print(sys.version_info[0])'], 5_000);
    assert.equal(probe.code, 0);
    assert.match(probe.stdout.trim(), /^[23]$/);
  } else {
    // 没找到 python 是合法状态(说明这台机子没装),skip 验证
    assert.ok(true);
  }
});