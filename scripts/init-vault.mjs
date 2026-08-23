#!/usr/bin/env node
/**
 * init-vault.mjs — 一键初始化 Obsidian vault 为 llm-wiki-plugin 兼容结构(纯函数库)
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PLUGIN_ROOT = path.resolve(__dirname, '..');

/**
 * 创建目录(幂等)。返回 {created: bool, path}
 * 策略:先尝试 access,不存在再 mkdir recursive:true。
 * recursive:true 在目录已存在时不报错(Node 文档保证),但我们仍需要 access
 * 来告诉 caller "本次是否做了实际创建"——这是 spec 的契约。
 * 失败向上抛(权限拒绝 / 路径无效),由 caller 处理。
 */
export async function ensureDir(dirPath) {
  try {
    await fs.access(dirPath);
    return { created: false, path: dirPath };
  } catch {
    // 不存在,继续创建
  }
  await fs.mkdir(dirPath, { recursive: true });
  return { created: true, path: dirPath };
}

/**
 * copy-if-missing。返回 {action: 'copied'|'skipped'|'failed', src, dst, error?}
 * 失败时 error.kind 区分 mkdir 阶段失败('mkdir-failed')和 copyFile 阶段失败('copy-failed'),
 * error.code 透传 Node.js errno.code(EACCES/ENOENT/ENOSPC 等)。
 * 失败永不抛异常,返回结果由 caller 决定 retry / abort。
 */
export async function copyIfMissing(src, dst) {
  try {
    await fs.access(dst);
    return { action: 'skipped', src, dst };
  } catch {
    // dst 不存在 → 拷贝
  }
  try {
    await fs.mkdir(path.dirname(dst), { recursive: true });
  } catch (e) {
    return { action: 'failed', src, dst, error: { kind: 'mkdir-failed', code: e.code, message: e.message } };
  }
  try {
    await fs.copyFile(src, dst);
    return { action: 'copied', src, dst };
  } catch (e) {
    return { action: 'failed', src, dst, error: { kind: 'copy-failed', code: e.code, message: e.message } };
  }
}

/**
 * 创建空文件(幂等)。返回 {created: bool, path}
 * 与 ensureDir 同风格:access 检测存在性,不存在则 mkdir + writeFile。
 * 失败向上抛,语义与 ensureDir 对齐。
 */
export async function ensureFileIfMissing(filePath) {
  try {
    await fs.access(filePath);
    return { created: false, path: filePath };
  } catch {
    // 不存在
  }
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, '', 'utf8');
  return { created: true, path: filePath };
}

/* ===================== 共享常量 ===================== */

const CLAUDE_BEGIN = '<!-- llm-wiki-plugin-init:begin -->';
const CLAUDE_END = '<!-- llm-wiki-plugin-init:end -->';

export { CLAUDE_BEGIN as CLAUDE_BEGIN_MARKER, CLAUDE_END as CLAUDE_END_MARKER };

/**
 * 校验 vaultRoot 存在且是目录。
 * @returns {Promise<{ok: true} | {ok: false, error: {kind: string, path: string, message?: string}}>}
 */
export async function ensureVaultRoot(vaultRoot) {
  try {
    const stat = await fs.stat(vaultRoot);
    if (!stat.isDirectory()) {
      return { ok: false, error: { kind: 'vault-is-file', path: vaultRoot } };
    }
    return { ok: true };
  } catch (e) {
    if (e.code === 'ENOENT') {
      return { ok: false, error: { kind: 'vault-not-found', path: vaultRoot } };
    }
    return { ok: false, error: { kind: 'vault-stat-failed', path: vaultRoot, message: e.message } };
  }
}

/**
 * 把模板内容追加到 vault/CLAUDE.md。幂等:已含 CLAUDE_BEGIN + CLAUDE_END 双标记则跳过。
 * 首次创建(status='created')不带 begin/end 包裹,后续追加(status='appended')带 begin/end。
 * 永不抛异常:读取 claude.md 或模板失败时返回 {status: 'read-failed', path, error}。
 * @returns {Promise<
 *   {status: 'created'|'appended'|'already-injected', path: string}
 *   | {status: 'read-failed', path: string, error: {kind: string, code?: string, message?: string, templatePath?: string}}
 * >}
 */
export async function injectClaudeMd(vaultRoot, templatePath) {
  const claudePath = path.join(vaultRoot, 'CLAUDE.md');
  let existing = '';
  let exists = false;
  try {
    existing = await fs.readFile(claudePath, 'utf8');
    exists = true;
  } catch (e) {
    if (e.code !== 'ENOENT') {
      return { status: 'read-failed', path: claudePath, error: { kind: 'claude-read-failed', code: e.code, message: e.message } };
    }
  }

  // 双点检测:begin 和 end 必须同时存在才算已注入,避免用户删 end 留 begin 留下孤 begin
  if (exists && existing.includes(CLAUDE_BEGIN) && existing.includes(CLAUDE_END)) {
    return { status: 'already-injected', path: claudePath };
  }

  let template;
  try {
    template = await fs.readFile(templatePath, 'utf8');
  } catch (e) {
    return { status: 'read-failed', path: claudePath, error: { kind: 'claude-template-missing', code: e.code, message: e.message, templatePath } };
  }

  const trimmed = template.replace(/\r?\n+$/, '');  // 去模板末尾换行
  const block = `\n\n${CLAUDE_BEGIN}\n${trimmed}\n${CLAUDE_END}\n`;
  // 首次创建也要用 begin/end 包裹,避免下次跑判 'already-injected' 失败导致复制一份
  const wrapped = `${CLAUDE_BEGIN}\n${trimmed}\n${CLAUDE_END}\n`;

  if (!exists) {
    await fs.writeFile(claudePath, wrapped, 'utf8');
    return { status: 'created', path: claudePath };
  }

  await fs.appendFile(claudePath, block, 'utf8');
  return { status: 'appended', path: claudePath };
}

/* ===================== Wiki 结构常量(spec §1,排除 .obsidian/) ===================== */

export const DIRECTORIES = [
  '01_知识库',
  '02_读书笔记',
  '03_问答区',
  '11_entities',
  '12_concepts',
  'Inbox',
  'Inbox/web_clipper',
  '00_模板',
  '10_schema',
  '附件文件夹',
];

export const TOP_LEVEL_MD = ['Index.md', 'Log.md'];
export const PLACEHOLDER_FILES = [
  'Inbox/.gitkeep',
  'Inbox/web_clipper/.gitkeep',
  '03_问答区/_cross/.gitkeep',
];

/* ===================== runInit 集成函数 ===================== */

/**
 * 一站式初始化。vault 校验失败时仍返回 report(exitCode=2),不抛异常。
 *
 * @param {object} opts
 * @param {string} opts.vaultRoot
 * @param {string} [opts.pluginRoot]  默认 = 当前脚本的父目录(plugin 仓根)
 * @returns {Promise<{
 *   exitCode: number,
 *   counters: {dirsCreated: number, dirsSkipped: number, filesCopied: number, filesSkipped: number, placeholdersCreated: number, placeholdersSkipped: number},
 *   claudeMd: {status: string},
 *   errors: object[]
 * }>}
 */
export async function runInit({ vaultRoot, pluginRoot = DEFAULT_PLUGIN_ROOT }) {
  const errors = [];
  const counters = {
    dirsCreated: 0,
    dirsSkipped: 0,
    filesCopied: 0,
    filesSkipped: 0,
    placeholdersCreated: 0,
    placeholdersSkipped: 0,
  };

  // 1. 校验 vault
  const v = await ensureVaultRoot(vaultRoot);
  if (!v.ok) {
    return {
      exitCode: 2,
      counters,
      claudeMd: { status: 'skipped' },
      errors: [v.error],
    };
  }

  // 2. 创建 9 目录
  for (const d of DIRECTORIES) {
    try {
      const r = await ensureDir(path.join(vaultRoot, d));
      if (r.created) counters.dirsCreated++;
      else counters.dirsSkipped++;
    } catch (e) {
      errors.push({ kind: 'dir-create-failed', dir: d, code: e.code, message: e.message });
    }
  }

  // 3. 拷贝 4 个资产
  const assetMap = [
    ['00_模板/读书笔记模板.md', '00_模板/读书笔记模板.md'],
    ['00_模板/标签词表.md', '00_模板/标签词表.md'],
    ['10_schema/config.md', '10_schema/config.md'],
    ['Inbox/web_clipper/README.md', 'Inbox/web_clipper/README.md'],
  ];
  for (const [relSrc, relDst] of assetMap) {
    const src = path.join(pluginRoot, relSrc);
    const dst = path.join(vaultRoot, relDst);
    try {
      await fs.access(src);
    } catch {
      errors.push({ kind: 'asset-missing', src });
      continue;
    }
    const r = await copyIfMissing(src, dst);
    if (r.action === 'copied') counters.filesCopied++;
    else if (r.action === 'skipped') counters.filesSkipped++;
    else if (r.action === 'failed') errors.push(r.error);
  }

  // 4. 顶层 md + 占位文件
  for (const f of [...TOP_LEVEL_MD, ...PLACEHOLDER_FILES]) {
    try {
      const r = await ensureFileIfMissing(path.join(vaultRoot, f));
      if (r.created) counters.placeholdersCreated++;
      else counters.placeholdersSkipped++;
    } catch (e) {
      errors.push({ kind: 'placeholder-failed', file: f, code: e.code, message: e.message });
    }
  }

  // 5. CLAUDE.md 注入
  let claudeMd = { status: 'skipped' };
  try {
    claudeMd = await injectClaudeMd(vaultRoot, path.join(pluginRoot, '00_模板/CLAUDE_Template.md'));
  } catch (e) {
    // 理论上 injectClaudeMd 永不抛,但加 catch 防御
    errors.push({ kind: 'claude-md-failed', code: e.code, message: e.message });
    claudeMd = { status: 'skipped' };
  }
  if (claudeMd.error) {
    errors.push(claudeMd.error);
  }

  // 退出码优先级:vault(2) > asset/template missing(3) > IO 失败(4) > 成功(0)
  // 任一错误取最高优先级;vault 错误已在第 1 步早返,errors 不会含 vault 类
  const priority = {
    'asset-missing': 3,
    'claude-template-missing': 3,
    'claude-read-failed': 3,
    'dir-create-failed': 4,
    'placeholder-failed': 4,
    'copy-failed': 4,
    'mkdir-failed': 4,
  };
  let exitCode = 0;
  for (const e of errors) {
    const p = priority[e.kind];
    if (p !== undefined && p > exitCode) exitCode = p;
  }
  return { exitCode, counters, claudeMd, errors };
}

/* ===================== CLI 入口(仅直接执行时触发) ===================== */

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 1 || args[0].startsWith('--')) {
    console.error('用法: node scripts/init-vault.mjs <vaultRoot> [--plugin-root=<path>]');
    process.exit(64);  // EX_USAGE
  }
  const vaultRoot = path.resolve(args[0]);
  let pluginRoot = DEFAULT_PLUGIN_ROOT;
  for (const a of args.slice(1)) {
    if (a.startsWith('--plugin-root=')) {
      pluginRoot = path.resolve(a.slice('--plugin-root='.length));
    }
  }
  const report = await runInit({ vaultRoot, pluginRoot });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.exitCode);
}

// 仅在被 node 直接执行时跑 main,被 import 时不触发
const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((e) => {
    console.error('init-vault.mjs 崩溃:', e);
    process.exit(1);
  });
}