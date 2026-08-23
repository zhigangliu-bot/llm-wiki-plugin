#!/usr/bin/env node
/**
 * sync-pdf-notes.mjs
 *
 * Triggered (one-shot) PDF → 读书笔记 synchronizer.
 * Scans the configured watch directory for PDF files and materializes a
 * matching Markdown note under the configured notes directory. Exits when
 * done — no background polling.
 *
 * Exits with code 0 on success, 1 if any PDF failed, 2 on configuration
 * errors (missing watch dir / missing template).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function parseArgs(argv) {
  const args = {
    vault: process.cwd(),
    watch: '01_知识库',
    notes: '02_读书笔记',
    template: '00_模板/读书笔记模板.md',
    sourceField: 'source',
    overwrite: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const [flag, inlineValue] = token.split('=', 2);
    const key = flag.slice(2);
    let value = inlineValue;
    if (value === undefined) {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        value = next;
        i += 1;
      } else {
        value = 'true';
      }
    }

    if (key === 'vault') args.vault = value;
    else if (key === 'watch') args.watch = value;
    else if (key === 'notes') args.notes = value;
    else if (key === 'template') args.template = value;
    else if (key === 'source-field') args.sourceField = value;
    else if (key === 'overwrite') args.overwrite = value !== 'false';
    // --poll-ms and --backfill are accepted-but-ignored: the watch loop
    // is gone, so these flags have no effect any more. Silently ignore
    // them so old launchers / muscle-memory invocations don't crash.
  }
  return args;
}

export function toPosix(p) {
  return p.split(path.sep).join('/');
}

export function escapeYamlString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function replaceAllPlaceholders(text, replacements) {
  let result = text;
  for (const [needle, replacement] of Object.entries(replacements)) {
    result = result.split(needle).join(replacement);
  }
  return result;
}

export function extractFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return null;
  return {
    frontmatter: match[1],
    body: text.slice(match[0].length),
    fullMatch: match[0],
  };
}

export function buildNoteContent(templateText, { title, pdfLink, created, sourceField }) {
  const replacements = {
    '{{title}}': title,
    '{{pdf}}': pdfLink,
    '{{source}}': pdfLink,
    '{{date}}': created,
    '{{created}}': created,
  };

  const defaultBody = `> 原文：[[${pdfLink}]]\n\n## 摘要\n\n## 重点摘录\n\n## 我的思考\n`;

  if (!templateText) {
    return `---\n文章: "${escapeYamlString(title)}"\n作者:\n创建时间: "${created}"\ntags:\n状态: false\n${sourceField}: "[[${pdfLink}]]"\n---\n\n${defaultBody}`;
  }

  const fm = extractFrontmatter(templateText);
  if (!fm) {
    return replaceAllPlaceholders(templateText, replacements).trimEnd() + '\n';
  }

  const lines = fm.frontmatter.split(/\r?\n/);
  let sawArticle = false;
  let sawCreated = false;
  let sawSource = false;
  const updatedLines = lines.map((line) => {
    if (/^文章\s*:/.test(line)) {
      sawArticle = true;
      return `文章: "${escapeYamlString(title)}"`;
    }
    if (/^创建时间\s*:/.test(line)) {
      sawCreated = true;
      return `创建时间: "${created}"`;
    }
    if (new RegExp(`^${sourceField.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`).test(line)) {
      sawSource = true;
      return `${sourceField}: "[[${pdfLink}]]"`;
    }
    return line;
  });

  if (!sawArticle) updatedLines.push(`文章: "${escapeYamlString(title)}"`);
  if (!sawCreated) updatedLines.push(`创建时间: "${created}"`);
  if (!sawSource) updatedLines.push(`${sourceField}: "[[${pdfLink}]]"`);

  let body = fm.body.trim();
  body = body ? replaceAllPlaceholders(body, replacements) : defaultBody;

  return `---\n${updatedLines.join('\n')}\n---\n\n${body.trimEnd()}\n`;
}

export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readText(filePath) {
  try {
    return await fs.readFile(filePath, 'utf8');
  } catch {
    return '';
  }
}

export async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

export async function walkForPdfs(dirPath, results = []) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === '.obsidian' || entry.name === 'node_modules') continue;
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await walkForPdfs(fullPath, results);
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) {
      results.push(fullPath);
    }
  }
  return results;
}

export function notePathForPdf(watchRoot, notesDir, pdfPath) {
  const relativePdfDir = path.relative(watchRoot, path.dirname(pdfPath));
  const baseName = path.basename(pdfPath, path.extname(pdfPath));
  return path.join(notesDir, relativePdfDir, `${baseName}.md`);
}

/**
 * Generate (or overwrite, or skip) a single note for a PDF.
 * Returns 'created' (wrote a new or replaced an existing note) or 'skipped'
 * (note already existed and overwrite=false). Throws on filesystem errors.
 */
export async function generateNote(
  { vaultRoot, watchRoot, notesDir, templatePath, sourceField, overwrite },
  pdfPath
) {
  const notePath = notePathForPdf(watchRoot, notesDir, pdfPath);
  const existed = await fileExists(notePath);
  if (existed && !overwrite) {
    console.log(`Skip existing: ${toPosix(path.relative(vaultRoot, notePath))}`);
    return 'skipped';
  }

  const templateText = await readText(templatePath);
  const title = path.basename(pdfPath, path.extname(pdfPath));
  const created = new Date().toISOString().slice(0, 10);
  const pdfLink = toPosix(path.relative(vaultRoot, pdfPath));
  const content = buildNoteContent(templateText, {
    title,
    pdfLink,
    created,
    sourceField,
  });

  await ensureDir(path.dirname(notePath));
  await fs.writeFile(notePath, content, 'utf8');
  console.log(`Wrote: ${toPosix(path.relative(vaultRoot, notePath))} <- ${pdfLink}`);
  return 'created';
}

/**
 * Run the full one-shot sync.
 * Throws ConfigError on misconfiguration (missing watch dir / template).
 * Returns { counters, errors, paths, elapsedMs } on success.
 */
export async function runSync({
  vaultRoot,
  watchRoot,
  notesDir,
  templatePath,
  sourceField,
  overwrite,
}) {
  if (!(await fileExists(watchRoot))) {
    throw new ConfigError(`Watch directory not found: ${watchRoot}`);
  }
  if (!(await fileExists(templatePath))) {
    throw new ConfigError(`Template not found: ${templatePath}`);
  }
  await ensureDir(notesDir);

  const t0 = Date.now();
  const pdfs = await walkForPdfs(watchRoot);
  const counters = { scanned: pdfs.length, created: 0, skipped: 0, failed: 0 };
  const errors = [];

  for (const pdfPath of pdfs) {
    try {
      const result = await generateNote(
        { vaultRoot, watchRoot, notesDir, templatePath, sourceField, overwrite },
        pdfPath
      );
      if (result === 'created') counters.created += 1;
      else if (result === 'skipped') counters.skipped += 1;
    } catch (err) {
      counters.failed += 1;
      errors.push({ pdf: pdfPath, error: err });
      console.error(`Failed: ${toPosix(path.relative(vaultRoot, pdfPath))} — ${err.message}`);
    }
  }

  return {
    counters,
    errors,
    paths: { vaultRoot, watchRoot, notesDir, templatePath },
    elapsedMs: Date.now() - t0,
  };
}

export function exitCodeFor(result) {
  return result.counters.failed > 0 ? 1 : 0;
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));
  const vaultRoot = path.resolve(args.vault);
  const watchRoot = path.resolve(vaultRoot, args.watch);
  const notesDir = path.resolve(vaultRoot, args.notes);
  const templatePath = path.resolve(vaultRoot, args.template);

  console.log(`Vault: ${vaultRoot}`);
  console.log(`Watch: ${watchRoot}`);
  console.log(`Notes: ${notesDir}`);
  console.log(`Template: ${templatePath}`);
  console.log(`Source field: ${args.sourceField}`);
  console.log(`Overwrite existing notes: ${args.overwrite ? 'yes' : 'no'}`);

  let result;
  try {
    result = await runSync({
      vaultRoot,
      watchRoot,
      notesDir,
      templatePath,
      sourceField: args.sourceField,
      overwrite: args.overwrite,
    });
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(2);
    }
    throw err;
  }

  console.log(
    `\nDone. Scanned=${result.counters.scanned} Created=${result.counters.created} Skipped=${result.counters.skipped} Failed=${result.counters.failed} (elapsed ${result.elapsedMs}ms)`
  );
  process.exit(exitCodeFor(result));
}

// CLI entrypoint guard — only run main() when this file is executed directly,
// not when it's imported by tests.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}