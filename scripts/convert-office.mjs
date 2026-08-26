#!/usr/bin/env node
// scripts/convert-office.mjs — office / image → md 预转换器
// 单职责:接收 --input / --output / --type,按 type fork 外部 CLI,写 md 到 --output。
// 失败语义:非零退出码 + stdout 输出 { ok: false, error, stderr } JSON。

import { parseArgs } from 'node:util';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

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

export async function main() {
  const args = parseCli();
  await mkdir(dirname(args.output), { recursive: true });
  // 占位:后续 task 替换为真实 fork
  await writeFile(args.output, `# stub for ${args.type}\n`, 'utf8');
  console.log(JSON.stringify({ ok: true, md_path: args.output, char_count: 0, page_count: 0 }));
}

const isMain = import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`;
if (isMain) {
  main().catch((err) => failAndExit('uncaught', String(err), 1));
}
