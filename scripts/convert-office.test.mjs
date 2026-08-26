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