#!/usr/bin/env node
// scripts/convert-office.mjs — office / image → md 预转换器
// 单职责:接收 --input / --output / --type,按 type fork 外部 CLI,写 md 到 --output。
// 失败语义:非零退出码 + stdout 输出 { ok: false, error, stderr } JSON。

import { parseArgs } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';

const ALLOWED_TYPES = ['pptx', 'docx', 'xlsx', 'png', 'jpg', 'jpeg'];

function parseCli() {
  const { values } = parseArgs({
    options: {
      input: { type: 'string' },
      output: { type: 'string' },
      type: { type: 'string' },
    },
  });
  if (!values.input || !values.output || !values.type) {
    failAndExit('missing_args', 'require --input --output --type', 2);
  }
  if (!ALLOWED_TYPES.includes(values.type)) {
    failAndExit('bad_type', `type must be one of ${ALLOWED_TYPES.join(',')}`, 2);
  }
  return values;
}

export function failAndExit(error, detail, code) {
  console.log(JSON.stringify({ ok: false, error, stderr: detail }));
  process.exit(code);
}

/**
 * 同步 spawn + 捕获 stdout/stderr + 超时 kill。
 * @param {string} cmd
 * @param {string[]} args
 * @param {number} timeoutMs
 * @returns {Promise<{stdout: string, stderr: string, code: number}>}
 */
export function runCommand(cmd, args, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (b) => (stdout += b.toString()));
    child.stderr.on('data', (b) => (stderr += b.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code: killed ? 124 : code ?? 1 });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: stderr + String(err), code: 127 });
    });
  });
}

export async function convertViaLibreoffice(input, output, format) {
  const tmpdir = dirname(output);
  const args = ['--headless', '--convert-to', format, '--outdir', tmpdir, input];
  const which = await runCommand('which', ['libreoffice'], 5_000);
  if (which.code !== 0) {
    return { ok: false, error: 'tool_missing', stderr: 'libreoffice not in PATH', code: 2 };
  }
  const r = await runCommand('libreoffice', args, 60_000);
  if (r.code !== 0) return { ok: false, error: 'convert_failed', stderr: r.stderr, code: 1 };
  const basename = input.replace(/\\/g, '/').split('/').pop().replace(/\.[^.]+$/, '');
  const generated = `${tmpdir}/${basename}.${format}`;
  const fs = await import('node:fs/promises');
  const body = await fs.readFile(generated, 'utf8');
  await fs.unlink(generated).catch(() => {});
  return { ok: true, body, pageCount: countSlides(body) };
}

export async function convertDocxWithPandocFallback(input, output) {
  const whichP = await runCommand('which', ['pandoc'], 5_000);
  if (whichP.code === 0) {
    const r = await runCommand('pandoc', ['-f', 'docx', '-t', 'markdown', '-o', output, input], 60_000);
    if (r.code === 0) {
      const fs = await import('node:fs/promises');
      const body = await fs.readFile(output, 'utf8');
      return { ok: true, body, pageCount: 0 };
    }
  }
  // fallback libreoffice
  return convertViaLibreoffice(input, output, 'md');
}

export function countSlides(mdBody) {
  return (mdBody.match(/<!--\s*第\s*\d+\s*段\s*-->/g) || []).length;
}

export async function convertXlsxMultiSheet(input, output) {
  const which = await runCommand('which', ['libreoffice'], 5_000);
  if (which.code !== 0) {
    return { ok: false, error: 'tool_missing', stderr: 'libreoffice not in PATH (xlsx needs it)', code: 2 };
  }
  const tmpdir = dirname(output) + '/_xlsx_' + Date.now();
  await mkdir(tmpdir, { recursive: true });
  const args = ['--headless', '--convert-to', 'csv', '--outdir', tmpdir, input];
  const r = await runCommand('libreoffice', args, 60_000);
  if (r.code !== 0) return { ok: false, error: 'convert_failed', stderr: r.stderr, code: 1 };
  const fs = await import('node:fs/promises');
  const files = await fs.readdir(tmpdir);
  const csvFiles = files.filter((f) => f.endsWith('.csv')).sort();
  const sections = [];
  for (const f of csvFiles) {
    const csv = await fs.readFile(`${tmpdir}/${f}`, 'utf8');
    sections.push(`<!-- 第 ${sections.length + 1} 段 (sheet: ${f.replace(/\.csv$/, '')}) -->\n\n` + csvToMdTable(csv));
  }
  await fs.rm(tmpdir, { recursive: true, force: true });
  const body = sections.join('\n\n');
  return { ok: true, body, pageCount: sections.length };
}

export function csvToMdTable(csv) {
  const rows = csv.trim().split(/\r?\n/).map((line) => {
    // 简单 CSV 解析:支持双引号包裹的字段含逗号
    const cells = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') inQuote = !inQuote;
      else if (ch === ',' && !inQuote) { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    return cells.map((c) => c.trim() || ' ');
  });
  if (rows.length === 0) return '';
  const header = rows[0];
  const sep = header.map(() => '---');
  return [header, sep, ...rows.slice(1)].map((r) => `| ${r.join(' | ')} |`).join('\n');
}

export async function main() {
  const args = parseCli();
  await mkdir(dirname(args.output), { recursive: true });
  let result;
  if (args.type === 'pptx') {
    result = await convertViaLibreoffice(args.input, args.output, 'md');
  } else if (args.type === 'docx') {
    result = await convertDocxWithPandocFallback(args.input, args.output);
  } else if (args.type === 'xlsx') {
    result = await convertXlsxMultiSheet(args.input, args.output);
  } else {
    failAndExit('not_implemented', `image branch (${args.type}) comes in Task 5`, 1);
  }
  if (!result.ok) failAndExit(result.error, result.stderr, result.code);
  await writeFile(args.output, result.body, 'utf8');
  console.log(JSON.stringify({
    ok: true,
    md_path: args.output,
    char_count: result.body.length,
    page_count: result.pageCount ?? 0,
  }));
}

const isMain = import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`;
if (isMain) {
  main().catch((err) => failAndExit('uncaught', String(err), 1));
}
