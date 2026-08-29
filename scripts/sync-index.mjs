#!/usr/bin/env node
/**
 * sync-index.mjs — Index.md 同步器 (Index v2)
 *
 * 单一职责:把 vault 内 02_读书笔记 / 03_问答区 / 11_entities / 12_concepts
 * 的全部 markdown 文件渲染成统一的目录表,写入 vault 根 Index.md。
 *
 * 标记块包裹法:
 *   <!-- sync-index:begin v2 -->
 *   (脚本全权负责)
 *   <!-- sync-index:end -->
 * 标记块外的内容 (标题 / 引用 / 用户手工段) 保留不动。
 *
 * Spec: docs/superpowers/specs/spec-index-v2.md
 * Plan: docs/superpowers/plans/2026-08-29-index-v2.md Task 3
 */

import { parseArgs as nodeParseArgs } from 'node:util';
import { readFile, writeFile, readdir, mkdir, rename, stat } from 'node:fs/promises';
import { dirname, join, relative, sep, posix, isAbsolute, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const SYNC_BEGIN = '<!-- sync-index:begin v2 -->';
export const SYNC_END = '<!-- sync-index:end -->';

const SCAN_DIRS = [
  { prefix: '02_读书笔记', type: 'note' },
  { prefix: '03_问答区', type: 'qa' },
  { prefix: '11_entities', type: 'entity' },
  { prefix: '12_concepts', type: 'concept' },
];

const LANG = 'zh-Hans-CN';

// ---------------------------------------------------------------------------
// Pure utilities
// ---------------------------------------------------------------------------

/** Windows 反斜杠 → 正斜杠;已是斜杠不变 */
export function toPosix(p) {
  return String(p).split(sep).join('/');
}

/** 拒绝绝对路径、盘符、.. 越界 */
export function isPathSafe(vaultRoot, target) {
  if (!target) return false;
  if (isAbsolute(target)) return false;
  if (/^[a-z]:\//i.test(target)) return false;
  const parts = String(target).split('/');
  if (parts.some((p) => p === '..')) return false;
  return true;
}

/**
 * 最小 frontmatter 解析器。
 * 仅支持:
 *   --- 围栏
 *   key: value / key: [a, b] / key: [a|b, c] 等简单格式
 * 不支持嵌套 / 多行 scalar / 锚点引用 (v1 spec 字段够用)。
 *
 * @param {string} content
 * @returns {Record<string, any>}
 */
export function parseFrontmatter(content) {
  if (typeof content !== 'string') return {};
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) return {};
  const endIdx = content.indexOf('\n---', 3);
  if (endIdx < 0) return {};
  const block = content.slice(4, endIdx);
  const out = {};
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([\w一-龥\-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const raw = (m[2] ?? '').trim();
    if (raw === '') {
      out[key] = '';
      continue;
    }
    if (raw.startsWith('[') && raw.endsWith(']')) {
      const inner = raw.slice(1, -1).trim();
      out[key] = inner === '' ? [] : inner.split(',').map((s) => s.trim()).filter(Boolean);
      continue;
    }
    out[key] = raw;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Render — pure, no IO
// ---------------------------------------------------------------------------

/**
 * 渲染"关键概念"列。
 * 优先级:frontmatter.concepts / '关键概念' (显式) > frontmatter.tags (回退)
 * 截断到 8,转义 |,去重。
 * spec §4.3
 */
export function renderConcepts(frontmatter) {
  const explicit = Array.isArray(frontmatter?.concepts)
    ? frontmatter.concepts
    : Array.isArray(frontmatter?.['关键概念'])
      ? frontmatter['关键概念']
      : null;
  const source = explicit ?? (Array.isArray(frontmatter?.tags) ? frontmatter.tags : []);
  const merged = [];
  const seen = new Set();
  for (const s of source) {
    if (typeof s !== 'string') continue;
    const t = s.trim();
    if (!t) continue;
    if (seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    merged.push(t);
  }
  const truncated = merged.slice(0, 8);
  if (truncated.length === 0) return '—';
  return truncated
    .map((s) => (s.includes('|') ? s.replace(/\|/g, '\\|') : s))
    .join(' / ');
}

/** 单行渲染,4 列,末尾 wiki-link 保留 .md 后缀 (spec §3) */
export function renderRow(row) {
  const { title, category, concepts, path } = row;
  const safeTitle = title.includes('|') ? title.replace(/\|/g, '\\|') : title;
  return `| ${safeTitle} | ${category} | ${concepts} | [[${path}]] |`;
}

/**
 * 按段分组 + 排序 + 渲染整段标记块内容
 * @param {Array<{section: string, type: string, rows: Array<{path:string,title:string,category:string,concepts:string}>}>} sections
 */
export function renderSyncBlock(sections) {
  if (sections.length === 0) {
    return `${SYNC_BEGIN}\n${SYNC_END}`;
  }
  const lines = [SYNC_BEGIN];
  // 主题段(非 entity/concept)按 section 字母序;Entities/Concepts 固定末尾
  const themes = sections
    .filter((s) => s.type !== 'entity' && s.type !== 'concept')
    .sort((a, b) => a.section.localeCompare(b.section, LANG));
  const tails = sections
    .filter((s) => s.type === 'entity' || s.type === 'concept')
    .sort((a, b) => {
      // Entities 在 Concepts 前
      if (a.type !== b.type) return a.type === 'entity' ? -1 : 1;
      return a.section.localeCompare(b.section, LANG);
    });
  for (const sec of [...themes, ...tails]) {
    const sortedRows = [...sec.rows].sort((a, b) =>
      a.title.localeCompare(b.title, LANG),
    );
    lines.push('', `## ${sec.section}`);
    lines.push('| 标题 | 分类 | 关键概念 | 路径 |');
    lines.push('| --- | --- | --- | --- |');
    for (const r of sortedRows) {
      lines.push(renderRow(r));
    }
  }
  lines.push('', SYNC_END);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Scan — IO
// ---------------------------------------------------------------------------

/** 递归列出指定 prefix 下的全部 .md(相对 vaultRoot 的 posix 路径) */
export async function scanDir(vaultRoot, prefix) {
  const out = [];
  async function walk(absDir, relDir) {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
    for (const ent of entries) {
      const absChild = join(absDir, ent.name);
      const relChild = relDir ? `${relDir}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        await walk(absChild, relChild);
        continue;
      }
      if (ent.isFile() && relChild.toLowerCase().endsWith('.md')) {
        out.push(toPosix(relChild));
      }
    }
  }
  await walk(join(vaultRoot, prefix), prefix);
  return out;
}

/** 全扫 4 个目录,返回 Map<posixRelPath, fileMeta> */
export async function scanAll(vaultRoot) {
  const files = new Map();
  for (const { prefix, type } of SCAN_DIRS) {
    const rels = await scanDir(vaultRoot, prefix);
    for (const rel of rels) {
      const abs = join(vaultRoot, rel.split('/').join(sep));
      let content = '';
      let stat_ = null;
      try {
        content = await readFile(abs, 'utf8');
        stat_ = await stat(abs);
      } catch (err) {
        console.error(`warn: failed to read ${rel}: ${err.message}`);
        continue;
      }
      const fm = parseFrontmatter(content);
      // category: 02/03 取主题目录;11/12 固定 entity/concept
      let category = type;
      if (type === 'note' || type === 'qa') {
        const parts = rel.split('/');
        // ['02_读书笔记', '<主题>', ...]
        category = parts[1] ?? '(未分类)';
      }
      // title: 文章: (02/03) > title: (11/12) > filename
      const filenameNoExt = rel.split('/').pop().replace(/\.md$/i, '');
      const title = (fm['文章'] ?? fm.title ?? filenameNoExt).toString().trim();
      const concepts = renderConcepts(fm);
      files.set(rel, {
        path: rel,
        title,
        category,
        concepts,
        type,
        mtimeMs: stat_?.mtimeMs ?? 0,
      });
    }
  }
  return files;
}

// ---------------------------------------------------------------------------
// Index.md IO
// ---------------------------------------------------------------------------

/**
 * 把 Index.md 拆成 { header, syncBlock, footer }
 * - header: 从开头到 SYNC_BEGIN 之前(含 SYNC_BEGIN 之前的换行)
 * - syncBlock: SYNC_BEGIN 行 + 中间内容 + SYNC_END 行
 * - footer: SYNC_END 之后的所有内容
 * 若无标记块,整文件视为 footer,syncBlock = 空
 */
export function splitIndexMd(content) {
  const beginIdx = content.indexOf(SYNC_BEGIN);
  const endIdx = content.indexOf(SYNC_END);
  if (beginIdx < 0 || endIdx < 0 || endIdx < beginIdx) {
    return { header: '', syncBlock: '', footer: content };
  }
  return {
    header: content.slice(0, beginIdx),
    syncBlock: content.slice(beginIdx, endIdx + SYNC_END.length),
    footer: content.slice(endIdx + SYNC_END.length),
  };
}

/** 把新的 syncBlock 塞回原文件 */
export function assembleIndexMd(header, newSyncBlock, footer) {
  return header + newSyncBlock + footer;
}

/** 原子写:写 .tmp + rename */
export async function atomicWrite(path, content) {
  const tmp = path + '.tmp';
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, path);
}

// ---------------------------------------------------------------------------
// Section grouping
// ---------------------------------------------------------------------------

/** 把 scanAll 结果按段分组 */
export function groupBySection(files) {
  const map = new Map();
  for (const meta of files.values()) {
    let section;
    if (meta.type === 'entity') section = 'Entities';
    else if (meta.type === 'concept') section = 'Concepts';
    else section = meta.category;
    if (!map.has(section)) map.set(section, { section, type: meta.type, rows: [] });
    map.get(section).rows.push({
      path: meta.path,
      title: meta.title,
      category: meta.category,
      concepts: meta.concepts,
    });
  }
  return [...map.values()];
}

// ---------------------------------------------------------------------------
// Diff (for --check)
// ---------------------------------------------------------------------------

/** 简单行级 LCS diff,返回 unified diff 文本 */
export function unifiedDiff(actual, expected, label = 'Index.md') {
  const a = actual.split('\n');
  const b = expected.split('\n');
  // 简化:逐行对比,记录 +/- 行
  const out = [];
  const max = Math.max(a.length, b.length);
  let aLine = 0;
  let bLine = 0;
  for (let i = 0; i < max; i++) {
    const av = a[i];
    const bv = b[i];
    if (av === bv) {
      aLine++;
      bLine++;
      continue;
    }
    if (av !== undefined) out.push(`-${av}`);
    if (bv !== undefined) out.push(`+${bv}`);
    aLine++;
    bLine++;
  }
  if (out.length === 0) return '';
  return `--- ${label} (actual)\n+++ ${label} (expected)\n${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// CLI / parseArgs
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
  const out = nodeParseArgs({
    args: argv,
    options: {
      all: { type: 'boolean' },
      add: { type: 'string', multiple: true },
      remove: { type: 'string', multiple: true },
      check: { type: 'boolean' },
      write: { type: 'boolean' },
      'vault-root': { type: 'string' },
      'plugin-root': { type: 'string' },
      json: { type: 'boolean' },
      'no-color': { type: 'boolean' },
    },
    strict: false,
    allowPositionals: false,
  });

  let mode = 'check';
  if (out.values.all) mode = 'all';
  if (out.values.add && out.values.add.length > 0) mode = 'add';
  if (out.values.remove && out.values.remove.length > 0) mode = 'remove';
  // check 是 fallback
  if (out.values.check) mode = 'check';

  return {
    mode,
    paths: [
      ...(out.values.add ?? []),
      ...(out.values.remove ?? []),
    ],
    write: Boolean(out.values.write),
    vaultRoot: out.values['vault-root'] ?? process.cwd(),
    pluginRoot: out.values['plugin-root'] ?? process.cwd(),
    json: Boolean(out.values.json),
    noColor: Boolean(out.values['no-color']),
  };
}

// ---------------------------------------------------------------------------
// Main orchestration
// ---------------------------------------------------------------------------

/**
 * 主入口。
 * @param {string[]} argv
 * @param {object} [opts]
 * @param {string} [opts.cwd] — 进程 cwd(vaultRoot 默认)
 * @returns {Promise<number>} exit code
 */
export async function main(argv, opts = {}) {
  const args = parseArgs(argv);
  const cwd = opts.cwd ?? process.cwd();
  const vaultRoot = args.vaultRoot === process.cwd() ? cwd : args.vaultRoot;

  // sanity: vaultRoot 是目录
  try {
    const st = await stat(vaultRoot);
    if (!st.isDirectory()) {
      console.error(`vaultRoot is not a directory: ${vaultRoot}`);
      return 2;
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`vaultRoot not found: ${vaultRoot}`);
      return 2;
    }
    return 4;
  }

  // 1. 扫描
  const currentFiles = new Map();

  if (args.mode === 'add') {
    // path safety check
    for (const p of args.paths) {
      if (!isPathSafe(vaultRoot, p)) {
        console.error(`refuse unsafe path: ${p}`);
        return 2;
      }
    }
    for (const p of args.paths) {
      const abs = join(vaultRoot, p.split('/').join(sep));
      try {
        const content = await readFile(abs, 'utf8');
        const st = await stat(abs);
        const fm = parseFrontmatter(content);
        const prefix = p.split('/')[0];
        const cfg = SCAN_DIRS.find((d) => d.prefix === prefix);
        const type = cfg?.type ?? 'note';
        let category = type;
        if (type === 'note' || type === 'qa') {
          category = p.split('/')[1] ?? '(未分类)';
        }
        const filenameNoExt = p.split('/').pop().replace(/\.md$/i, '');
        currentFiles.set(p, {
          path: p,
          title: (fm['文章'] ?? fm.title ?? filenameNoExt).toString().trim(),
          category,
          concepts: renderConcepts(fm),
          type,
          mtimeMs: st.mtimeMs ?? 0,
        });
      } catch (err) {
        console.error(`warn: failed to read ${p}: ${err.message}`);
      }
    }
  } else if (args.mode === 'remove') {
    // 删:留空 map
  } else if (args.mode === 'all' || args.mode === 'check') {
    const scanned = await scanAll(vaultRoot);
    for (const [k, v] of scanned) currentFiles.set(k, v);
  }

  // 2. 读现有 Index.md
  const idxPath = join(vaultRoot, 'Index.md');
  let existingContent = '';
  try {
    existingContent = await readFile(idxPath, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`warn: failed to read Index.md: ${err.message}`);
    }
  }
  const { header, footer } = splitIndexMd(existingContent);

  // 3. 计算 merged rows
  // 简化版:--all/--check 直接用扫描结果;--add 追加;--remove 不动
  let rows = new Map();
  if (args.mode === 'add') {
    // 从现有 syncBlock 解析已有行;append 新增
    rows = parseRowsFromSyncBlock(existingContent);
    for (const meta of currentFiles.values()) {
      rows.set(meta.path, {
        path: meta.path,
        title: meta.title,
        category: meta.category,
        concepts: meta.concepts,
        type: meta.type,
      });
    }
  } else if (args.mode === 'remove') {
    rows = parseRowsFromSyncBlock(existingContent);
    for (const p of args.paths) rows.delete(p);
  } else {
    // all / check:全部来自 currentFiles
    for (const meta of currentFiles.values()) {
      rows.set(meta.path, {
        path: meta.path,
        title: meta.title,
        category: meta.category,
        concepts: meta.concepts,
        type: meta.type,
      });
    }
  }

  // 4. 渲染新 syncBlock
  const sections = groupBySectionFromRows(rows);
  const newSyncBlock = renderSyncBlock(sections);
  const newContent = assembleIndexMd(header, newSyncBlock, footer);

  // 5. 输出 / 写盘
  if (args.mode === 'check') {
    if (newContent === existingContent) {
      return 0;
    }
    if (args.json) {
      console.log(JSON.stringify({ consistent: false, diff: unifiedDiff(existingContent, newContent) }));
    } else {
      console.log(unifiedDiff(existingContent, newContent));
    }
    return 1;
  }

  if (!args.write) {
    // dry-run:打 diff
    if (args.json) {
      console.log(JSON.stringify({ write: false, diff: unifiedDiff(existingContent, newContent) }));
    } else {
      console.log(unifiedDiff(existingContent, newContent));
    }
    return 0;
  }

  await atomicWrite(idxPath, newContent);
  return 0;
}

// ---------------------------------------------------------------------------
// Helper: parse existing rows from syncBlock
// ---------------------------------------------------------------------------

/**
 * 从 Index.md 的 syncBlock 解析现有 rows(Map<path, row>)
 * 解析失败的行跳过(warn 到 stderr)
 */
export function parseRowsFromSyncBlock(content) {
  const rows = new Map();
  if (!content) return rows;
  const { syncBlock } = splitIndexMd(content);
  if (!syncBlock) return rows;
  const lines = syncBlock.split('\n');
  let currentSection = null;
  let currentType = 'note';
  for (const line of lines) {
    const sectionMatch = line.match(/^##\s+(.+)$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      if (currentSection === 'Entities') currentType = 'entity';
      else if (currentSection === 'Concepts') currentType = 'concept';
      else currentType = 'note';
      continue;
    }
    // 表格行: | title | category | concepts | [[path]] |
    const rowMatch = line.match(/^\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)\s*\|\s*\[\[(.+?)\]\]\s*\|\s*$/);
    if (!rowMatch) continue;
    const [, title, category, concepts, path] = rowMatch;
    rows.set(path, { path, title, category, concepts, type: currentType });
  }
  return rows;
}

function groupBySectionFromRows(rowsMap) {
  const map = new Map();
  for (const row of rowsMap.values()) {
    let section;
    if (row.type === 'entity') section = 'Entities';
    else if (row.type === 'concept') section = 'Concepts';
    else section = row.category;
    if (!map.has(section)) map.set(section, { section, type: row.type, rows: [] });
    map.get(section).rows.push(row);
  }
  return [...map.values()];
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(`sync-index.mjs crashed: ${err?.message ?? err}`);
      process.exit(1);
    },
  );
}