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
 * 探测系统中带 paddleocr 的 python 可执行路径。
 *
 * Node `spawn('python', ...)` 在 Windows 上会按 Windows PATH 解析,可能拿到
 * 系统 Python (如 C:\Python314) 而不是用户 venv 的 python,导致
 * `import paddleocr` 失败,即便用户在 bash 下 `python` 能找到 venv。
 * 这里按优先级探测:
 *   1) 直接 spawn 'python' (兼容 POSIX 习惯 + 大多数 Windows venv 激活后)
 *   2) 显式探测 PATH 中每个 python.exe
 *   3) 用户家目录下常见 venv 路径
 * 返回 null 表示没找到。
 */
export async function findPythonWithPaddleocr() {
  const path = await import('node:path');
  const os = await import('node:os');
  const fs = await import('node:fs/promises');

  // 先 spawn 一次 'python' —— 不一定能 import paddleocr,但能确认 python 可用
  const probeSimple = await runCommand('python', ['-c', 'print("ok")'], 5_000);
  if (probeSimple.code === 0) {
    const probeImp = await runCommand('python', ['-c', 'import paddleocr'], 5_000);
    if (probeImp.code === 0) return 'python';
  }

  // 列出 PATH 中的 python / python3,挨个试
  const which = await runCommand('where', ['python'], 5_000);
  const candidates = [];
  if (which.code === 0) {
    for (const line of which.stdout.split(/\r?\n/)) {
      const p = line.trim();
      if (p && p.endsWith('python.exe')) candidates.push(p);
    }
  }
  const which3 = await runCommand('where', ['python3'], 5_000);
  if (which3.code === 0) {
    for (const line of which3.stdout.split(/\r?\n/)) {
      const p = line.trim();
      if (p && !candidates.includes(p)) candidates.push(p);
    }
  }

  // 常见 venv 路径(用户可能建了 .venv-ocr 或 venv 在家目录 + cwd 祖先目录)
  const home = os.homedir();
  const homeVenvs = [
    path.join(home, '.venv-ocr', 'Scripts', 'python.exe'),
    path.join(home, '.venv-ocr', 'bin', 'python'),
    path.join(home, 'venv', 'Scripts', 'python.exe'),
    path.join(home, 'venv', 'bin', 'python'),
  ];
  for (const v of homeVenvs) {
    try {
      await fs.access(v);
      candidates.push(v);
    } catch { /* 不存在 */ }
  }

  // 从 cwd 向上找 5 层,看是否有 .venv-ocr / .venv / venv
  let dir = process.cwd();
  for (let i = 0; i < 5; i++) {
    const candidates2 = [
      path.join(dir, '.venv-ocr', 'Scripts', 'python.exe'),
      path.join(dir, '.venv-ocr', 'bin', 'python'),
      path.join(dir, '.venv', 'Scripts', 'python.exe'),
      path.join(dir, '.venv', 'bin', 'python'),
      path.join(dir, 'venv', 'Scripts', 'python.exe'),
      path.join(dir, 'venv', 'bin', 'python'),
    ];
    for (const v of candidates2) {
      try {
        await fs.access(v);
        if (!candidates.includes(v)) candidates.push(v);
      } catch { /* 不存在 */ }
    }
    // 同时看 cwd 的 parent 下所有 sibling 目录(用户可能把 venv 放在平级目录,
    // 如 F:\myself-marketplace\.venv-ocr 与 F:\llm-wiki-plugin 平级)
    const parent = path.dirname(dir);
    try {
      const sibs = await fs.readdir(parent);
      for (const sib of sibs) {
        const sibDir = path.join(parent, sib);
        if (sibDir === dir) continue;
        const tries = [
          path.join(sibDir, '.venv-ocr', 'Scripts', 'python.exe'),
          path.join(sibDir, '.venv-ocr', 'bin', 'python'),
          path.join(sibDir, '.venv', 'Scripts', 'python.exe'),
          path.join(sibDir, '.venv', 'bin', 'python'),
          path.join(sibDir, 'venv', 'Scripts', 'python.exe'),
          path.join(sibDir, 'venv', 'bin', 'python'),
        ];
        for (const v of tries) {
          try {
            await fs.access(v);
            if (!candidates.includes(v)) candidates.push(v);
          } catch { /* 不存在 */ }
        }
      }
    } catch { /* parent 不存在或权限 */ }
    const nextParent = path.dirname(dir);
    if (nextParent === dir) break;
    dir = nextParent;
  }

  for (const cand of candidates) {
    const r = await runCommand(cand, ['-c', 'import paddleocr'], 5_000);
    if (r.code === 0) return cand;
  }
  return null;
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

// docx 走 libreoffice(pandoc 路径已移除——用户机器只装 libreoffice 就够,
// pptx/docx/xlsx 三类同一条路径,运维更简单)
export async function convertDocx(input, output) {
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

// 内嵌 Python 脚本: 调 PaddleOCR Python API,对单张图片 OCR,逐行输出 JSON 到 stdout
// 每行:  {"page": N, "texts": ["line1", "line2", ...]}
// 必须 -u(无缓冲)和 flush=True,否则 pipe 模式下 stdout 会 block-buffer,PaddleOCR
// predict() 返回前 stdout 没东西,PaddleOCR 内部报错时我们也看不见 Python traceback。
const PADDLEOCR_PYTHON_SCRIPT = `
import sys, json
print('python-script-start', flush=True)
from paddleocr import PaddleOCR
img_path = sys.argv[1]
ocr = PaddleOCR(use_doc_orientation_classify=False, use_doc_unwarping=False, use_textline_orientation=False, lang='ch')
results = ocr.predict(img_path)
for i, r in enumerate(results):
    texts = r.get('rec_texts', []) if isinstance(r, dict) else []
    print(json.dumps({'page': i + 1, 'texts': texts}, ensure_ascii=False), flush=True)
print('python-script-done', flush=True)
`;

export async function convertImageViaPaddleocr(input, output) {
  // 依赖检测: 找能 import paddleocr 的 python (Windows node spawn 不会自动激活 venv)
  const pythonCmd = await findPythonWithPaddleocr();
  if (!pythonCmd) {
    return {
      ok: false,
      error: 'tool_missing',
      stderr: 'paddleocr Python 包未安装或 python 不在 PATH;pip install paddleocr paddlepaddle',
      code: 2,
    };
  }
  // 把脚本写到 temp 文件再调,避免 -c 模式 + 长 script 触发 Windows argv 解析问题
  // (调试发现 `python -c "<大段脚本>"` 经 node spawn 时,PaddleOCR 报"找不到文件"并 exit 1;
  // 同样的脚本通过 -u 直跑或写到文件都行)。脚本路径在 cwd/temp/ocr-script-<pid>.py。
  const { writeFile: wf, unlink } = await import('node:fs/promises');
  const path = await import('node:path');
  const scriptPath = path.join(process.cwd(), 'temp', `ocr-script-${process.pid}.py`);
  await wf(scriptPath, PADDLEOCR_PYTHON_SCRIPT, 'utf8');
  try {
    // 调 python 跑 OCR;PaddleOCR 3.x 首次加载模型(v6 PP-OCRv6 det+rec)实测
    // 在 Windows + node spawn 下需要 ~3-5 分钟(PaddleX 缓存目录 `C:\Users\<u>\.paddlex\`
    // 命中后下降到几秒)。给 5 分钟给冷启动留余量。
    const r = await runCommand(pythonCmd, ['-u', scriptPath, input], 300_000);
    if (r.code !== 0) return { ok: false, error: 'convert_failed', stderr: r.stderr || r.stdout, code: 1 };
    const sections = parsePaddleocrPythonStdout(r.stdout);
    const body = sections.length
      ? sections.map((s) => `<!-- 第 ${s.page} 段 (OCR result) -->\n\n${s.texts.join('\n')}`).join('\n\n')
      : `<!-- 第 1 段 (OCR result) -->\n\n${r.stdout.trim()}`;
    return { ok: true, body, pageCount: sections.length };
  } finally {
    await unlink(scriptPath).catch(() => {});
  }
}

export function parsePaddleocrPythonStdout(stdout) {
  // 每行一个 JSON: {"page": N, "texts": [...]}
  const sections = [];
  for (const raw of stdout.split('\n')) {
    const s = raw.trim();
    if (!s.startsWith('{')) continue;
    try {
      const obj = JSON.parse(s);
      if (Array.isArray(obj?.texts)) {
        sections.push({ page: obj.page ?? sections.length + 1, texts: obj.texts });
      }
    } catch { /* 忽略非 JSON 行 */ }
  }
  return sections;
}

// 保留旧函数,兼容 v2 CLI 输出格式 [{rec_texts: [...]}] 和 v3 Python API 输出 {page, texts}
export function parsePaddleocrStdout(stdout) {
  const lines = [];
  for (const raw of stdout.split('\n')) {
    const s = raw.trim();
    if (!s) continue;
    try {
      // v2 CLI: [{rec_texts: [...]}, ...]
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (Array.isArray(item?.rec_texts)) lines.push(item.rec_texts.join(' '));
        }
        continue;
      }
      // v3 Python API: {page, texts: [...]}
      if (Array.isArray(arr?.texts)) {
        for (const t of arr.texts) lines.push(t);
      }
    } catch { /* 忽略非 JSON 行 */ }
  }
  return lines.length ? lines : [stdout.trim()].filter(Boolean);
}

export async function main() {
  const args = parseCli();
  await mkdir(dirname(args.output), { recursive: true });
  let result;
  if (args.type === 'pptx') {
    result = await convertViaLibreoffice(args.input, args.output, 'md');
  } else if (args.type === 'docx') {
    result = await convertDocx(args.input, args.output);
  } else if (args.type === 'xlsx') {
    result = await convertXlsxMultiSheet(args.input, args.output);
  } else {
    // png / jpg / jpeg
    result = await convertImageViaPaddleocr(args.input, args.output);
  }
  if (!result.ok) failAndExit(result.error, result.stderr, result.code);
  const today = new Date().toISOString().slice(0, 10);
  const basename = args.input.replace(/\\/g, '/').split('/').pop();
  const fm = `---\nsource_file: ${basename}\nsource_type: ${args.type}\nconverted_at: ${today}\n---\n\n`;
  await writeFile(args.output, fm + result.body, 'utf8');
  console.log(JSON.stringify({
    ok: true,
    md_path: args.output,
    char_count: (fm + result.body).length,
    page_count: result.pageCount ?? 0,
  }));
}

const isMain = import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`;
if (isMain) {
  main().catch((err) => failAndExit('uncaught', String(err), 1));
}
