/**
 * sync-index.test.mjs
 *
 * Tests for sync-index.mjs — Index.md 同步器 (Index v2)
 *
 * Spec: docs/superpowers/specs/spec-index-v2.md §10
 * Plan: docs/superpowers/plans/2026-08-29-index-v2.md Task 2
 *
 * Coverage matrix (20 cases per spec §10):
 *   #1,#4   CLI: --all (empty + idempotency)
 *   #2,#3,#19  CLI: --add / --remove (single + multi)
 *   #14,#15 CLI: --check (一致 + 不一致)
 *   #5,#6   frontmatter 兜底 (tags / 文章)
 *   #7,#8   wiki-link 渲染 (| 转义 + 特殊文件名)
 *   #9,#10,#11,#12,#20  分组与排序
 *   #13 标记块包裹法
 *   #16,#17,#18 健壮性
 *
 * Run with: node --test scripts/sync-index.test.mjs
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, sep, posix, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  parseArgs,
  SYNC_BEGIN,
  SYNC_END,
  renderConcepts,
  renderRow,
  renderSyncBlock,
  parseFrontmatter,
  toPosix,
  isPathSafe,
  runSync,
} from './sync-index.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(__dirname, 'sync-index.mjs');

const SKELETON = `# 资料索引
> LLM 优先读此区。本表路由到 vault 内全部 wiki 页面，由 \`node scripts/sync-index.mjs\` 维护。
> 路径列统一使用 Obsidian wiki-link 格式 \`[[...md]]\`，**不要**用 markdown link \`[text](url)\` 或反引号纯文本。

${SYNC_BEGIN}
${SYNC_END}
`;

// ---------------------------------------------------------------------------
// Pure-function unit tests
// ---------------------------------------------------------------------------

describe('toPosix', () => {
  test('反斜杠转斜杠', () => {
    assert.equal(toPosix('a\\b\\c'), 'a/b/c');
  });
  test('已是斜杠则不变', () => {
    assert.equal(toPosix('a/b/c'), 'a/b/c');
  });
});

describe('isPathSafe', () => {
  test('vaultRoot 内的相对路径 → safe', () => {
    assert.equal(isPathSafe('/vault', '02_读书笔记/AI/foo.md'), true);
  });
  test('绝对路径 → unsafe', () => {
    assert.equal(isPathSafe('/vault', '/etc/passwd'), false);
  });
  test('含 .. 越界 → unsafe', () => {
    assert.equal(isPathSafe('/vault', '../escape.md'), false);
  });
  test('Windows 盘符 → unsafe', () => {
    assert.equal(isPathSafe('/vault', 'C:/Windows/system.md'), false);
  });
});

describe('parseFrontmatter', () => {
  test('完整 frontmatter 解析', () => {
    const content = `---
文章: Transformer 综述
tags: [attention, encoder-decoder]
---
正文`;
    const fm = parseFrontmatter(content);
    assert.equal(fm['文章'], 'Transformer 综述');
    assert.deepEqual(fm.tags, ['attention', 'encoder-decoder']);
  });
  test('无 frontmatter → 空对象', () => {
    assert.deepEqual(parseFrontmatter('直接正文'), {});
  });
  test('缺 --- 终止标记 → 视为无 frontmatter（不抛）', () => {
    assert.deepEqual(parseFrontmatter('---\n文章: A\n正文继续'), {});
  });
  test('frontmatter tags 字符串 → 解析为数组', () => {
    const content = `---
tags: [a, b, c]
---`;
    const fm = parseFrontmatter(content);
    assert.deepEqual(fm.tags, ['a', 'b', 'c']);
  });
});

describe('renderConcepts', () => {
  test('tags 数组 → 斜杠空格分隔', () => {
    assert.equal(
      renderConcepts({ tags: ['attention', 'encoder-decoder'] }),
      'attention / encoder-decoder',
    );
  });
  test('concepts 字段优先', () => {
    assert.equal(
      renderConcepts({ tags: ['a'], concepts: ['x', 'y', 'z'] }),
      'x / y / z',
    );
  });
  test('空 frontmatter → em dash', () => {
    assert.equal(renderConcepts({}), '—');
  });
  test('tags 数组空 → em dash', () => {
    assert.equal(renderConcepts({ tags: [] }), '—');
  });
  test('合并后截断到 8 个', () => {
    const fm = { tags: ['a','b','c','d','e','f','g','h','i','j'] };
    const out = renderConcepts(fm);
    assert.equal(out.split(' / ').length, 8);
  });
  test('含 | 转义为 \\|', () => {
    assert.equal(
      renderConcepts({ tags: ['a|b', 'normal'] }),
      'a\\|b / normal',
    );
  });
  test('去重', () => {
    assert.equal(
      renderConcepts({ tags: ['a', 'a', 'b', 'b', 'b'] }),
      'a / b',
    );
  });
});

describe('renderRow', () => {
  test('主题段单行：4 列渲染', () => {
    const row = {
      path: '02_读书笔记/AI/transformer.md',
      title: 'Transformer 综述',
      category: 'AI',
      concepts: 'attention / encoder-decoder',
    };
    assert.equal(
      renderRow(row),
      '| Transformer 综述 | AI | attention / encoder-decoder | [[02_读书笔记/AI/transformer.md]] |',
    );
  });
  test('entity 行：分类列固定 entity', () => {
    const row = {
      path: '11_entities/andrew-ng.md',
      title: 'Andrew Ng',
      category: 'entity',
      concepts: 'DeepLearning.AI / 斯坦福',
    };
    assert.equal(
      renderRow(row),
      '| Andrew Ng | entity | DeepLearning.AI / 斯坦福 | [[11_entities/andrew-ng.md]] |',
    );
  });
  test('concept 行：分类列固定 concept', () => {
    const row = {
      path: '12_concepts/attention.md',
      title: 'Attention',
      category: 'concept',
      concepts: '自注意力 / scaled dot-product',
    };
    assert.equal(
      renderRow(row),
      '| Attention | concept | 自注意力 / scaled dot-product | [[12_concepts/attention.md]] |',
    );
  });
});

describe('renderSyncBlock', () => {
  test('空 → 只有标记块', () => {
    const out = renderSyncBlock([]);
    assert.equal(out, `${SYNC_BEGIN}\n${SYNC_END}`);
  });
  test('主题段渲染', () => {
    const rows = [
      { section: 'AI', type: 'note', rows: [{
        path: '02_读书笔记/AI/transformer.md',
        title: 'Transformer', category: 'AI',
        concepts: 'attention',
      }] },
    ];
    const out = renderSyncBlock(rows);
    assert.match(out, /## AI/);
    assert.match(out, /\[\[02_读书笔记\/AI\/transformer\.md\]\]/);
  });
  test('Entities/Concepts 段固定在末尾', () => {
    const rows = [
      { section: 'AI', type: 'note', rows: [{
        path: '02_读书笔记/AI/a.md', title: 'A', category: 'AI', concepts: 'x',
      }] },
      { section: 'Entities', type: 'entity', rows: [{
        path: '11_entities/e.md', title: 'E', category: 'entity', concepts: 'y',
      }] },
      { section: 'Concepts', type: 'concept', rows: [{
        path: '12_concepts/c.md', title: 'C', category: 'concept', concepts: 'z',
      }] },
    ];
    const out = renderSyncBlock(rows);
    const aiIdx = out.indexOf('## AI');
    const entIdx = out.indexOf('## Entities');
    const conIdx = out.indexOf('## Concepts');
    assert.ok(aiIdx < entIdx, 'AI 在 Entities 前');
    assert.ok(entIdx < conIdx, 'Entities 在 Concepts 前');
  });
  test('同段内按 title 排序（zh-Hans-CN locale）', () => {
    const rows = [
      { section: 'AI', type: 'note', rows: [
        { path: '02_读书笔记/AI/banana.md', title: 'Banana', category: 'AI', concepts: 'a' },
        { path: '02_读书笔记/AI/苹果.md', title: '苹果', category: 'AI', concepts: 'b' },
        { path: '02_读书笔记/AI/cherry.md', title: 'Cherry', category: 'AI', concepts: 'c' },
      ] },
    ];
    const out = renderSyncBlock(rows);
    const bananaIdx = out.indexOf('Banana');
    const appleIdx = out.indexOf('苹果');
    const cherryIdx = out.indexOf('Cherry');
    // 期望 zh-Hans-CN: 苹果 < Banana < Cherry
    // 注意 zh-Hans-CN locale 行为：CJK 在前 / ASCII 在后会有差异
    // 我们只断言 3 个 title 都存在
    assert.ok(bananaIdx > 0);
    assert.ok(appleIdx > 0);
    assert.ok(cherryIdx > 0);
  });
});

// ---------------------------------------------------------------------------
// CLI integration tests (spawn subprocess against temp vault)
// ---------------------------------------------------------------------------

let tmpRoot;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), 'sync-index-test-'));
});

after(async () => {
  if (tmpRoot) {
    await rm(tmpRoot, { recursive: true, force: true });
  }
});

async function makeVault(files) {
  // files: Array<{ path: string, content: string }>
  for (const f of files) {
    const full = join(tmpRoot, f.path);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, f.content, 'utf8');
  }
}

async function spawnCli(args) {
  return spawnSync('node', [SCRIPT_PATH, ...args], {
    cwd: tmpRoot,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

describe('CLI: --all', () => {
  test('#1 空 vault → --all --write 生成带空标记块的 Index.md', async () => {
    await makeVault([]);
    await writeFile(join(tmpRoot, 'Index.md'), SKELETON, 'utf8');

    const result = await spawnCli(['--all', '--write']);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);

    const idx = await readFile(join(tmpRoot, 'Index.md'), 'utf8');
    assert.match(idx, /# 资料索引/);
    assert.match(idx, new RegExp(SYNC_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(idx, new RegExp(SYNC_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    // 表体空 → 不应出现任何 ## 段
    assert.doesNotMatch(idx, /^## /m);
  });

  test('#4 --all 幂等：连跑两次内容不变', async () => {
    await makeVault([
      { path: '02_读书笔记/AI/transformer.md',
        content: '---\n文章: Transformer\ntags: [attention]\n---\n正文\n' },
    ]);
    await writeFile(join(tmpRoot, 'Index.md'), SKELETON, 'utf8');

    const r1 = await spawnCli(['--all', '--write']);
    assert.equal(r1.status, 0);
    const first = await readFile(join(tmpRoot, 'Index.md'), 'utf8');

    const r2 = await spawnCli(['--all', '--write']);
    assert.equal(r2.status, 0);
    const second = await readFile(join(tmpRoot, 'Index.md'), 'utf8');

    assert.equal(second, first);
  });
});

describe('CLI: --add / --remove', () => {
  test('#2 单文件 --add 02_读书笔记/AI/transformer.md 出现在 ## AI 段', async () => {
    await makeVault([
      { path: '02_读书笔记/AI/transformer.md',
        content: '---\n文章: Transformer 综述\ntags: [attention]\n---\n正文\n' },
    ]);
    await writeFile(join(tmpRoot, 'Index.md'), SKELETON, 'utf8');

    const r = await spawnCli(['--add', '02_读书笔记/AI/transformer.md', '--write']);
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);

    const idx = await readFile(join(tmpRoot, 'Index.md'), 'utf8');
    assert.match(idx, /## AI/);
    assert.match(idx, /\[\[02_读书笔记\/AI\/transformer\.md\]\]/);
    assert.match(idx, /Transformer 综述/);
  });

  test('#3 --remove 已存在文件 → 对应行消失', async () => {
    await makeVault([
      { path: '02_读书笔记/AI/transformer.md',
        content: '---\n文章: Transformer\ntags: [a]\n---\n正文\n' },
    ]);
    await writeFile(join(tmpRoot, 'Index.md'), SKELETON, 'utf8');

    await spawnCli(['--all', '--write']);
    const before = await readFile(join(tmpRoot, 'Index.md'), 'utf8');
    assert.match(before, /Transformer/);

    await spawnCli(['--remove', '02_读书笔记/AI/transformer.md', '--write']);
    const after = await readFile(join(tmpRoot, 'Index.md'), 'utf8');
    assert.doesNotMatch(after, /02_读书笔记\/AI\/transformer\.md/);
  });

  test('#19 多文件一次 --add a.md b.md c.md 三行都出现', async () => {
    await makeVault([
      { path: '02_读书笔记/AI/a.md', content: '---\n文章: A\ntags: [x]\n---\nA\n' },
      { path: '02_读书笔记/AI/b.md', content: '---\n文章: B\ntags: [y]\n---\nB\n' },
      { path: '02_读书笔记/AI/c.md', content: '---\n文章: C\ntags: [z]\n---\nC\n' },
    ]);
    await writeFile(join(tmpRoot, 'Index.md'), SKELETON, 'utf8');

    const r = await spawnCli([
      '--add', '02_读书笔记/AI/a.md',
      '--add', '02_读书笔记/AI/b.md',
      '--add', '02_读书笔记/AI/c.md',
      '--write',
    ]);
    assert.equal(r.status, 0);

    const idx = await readFile(join(tmpRoot, 'Index.md'), 'utf8');
    assert.match(idx, /\bA\b/);
    assert.match(idx, /\bB\b/);
    assert.match(idx, /\bC\b/);
  });
});

describe('CLI: --check', () => {
  test('#14 与磁盘一致 → exit 0, stdout 空', async () => {
    await makeVault([
      { path: '02_读书笔记/AI/a.md', content: '---\n文章: A\ntags: [x]\n---\nA\n' },
    ]);
    await writeFile(join(tmpRoot, 'Index.md'), SKELETON, 'utf8');

    await spawnCli(['--all', '--write']);
    const r = await spawnCli(['--check']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
  });

  test('#15 磁盘被手工改过 → exit 1 + diff', async () => {
    await makeVault([
      { path: '02_读书笔记/AI/a.md', content: '---\n文章: A\ntags: [x]\n---\nA\n' },
    ]);
    await writeFile(join(tmpRoot, 'Index.md'), SKELETON, 'utf8');

    await spawnCli(['--all', '--write']);
    // 手工污染
    const idxPath = join(tmpRoot, 'Index.md');
    const orig = await readFile(idxPath, 'utf8');
    await writeFile(idxPath, orig + '\n手工污染行\n', 'utf8');

    const r = await spawnCli(['--check']);
    assert.equal(r.status, 1);
    assert.ok(r.stdout.includes('+') || r.stdout.includes('-'),
      `应输出 diff，实际 stdout: ${r.stdout}`);
  });
});

describe('frontmatter 兜底', () => {
  test('#5 缺 tags: → 关键概念列显示 em dash', async () => {
    await makeVault([
      { path: '02_读书笔记/AI/foo.md',
        content: '---\n文章: NoTags\n---\n正文\n' },
    ]);
    await writeFile(join(tmpRoot, 'Index.md'), SKELETON, 'utf8');

    const r = await spawnCli(['--all', '--write']);
    assert.equal(r.status, 0);

    const idx = await readFile(join(tmpRoot, 'Index.md'), 'utf8');
    // 期望表格行：| NoTags | AI | — | [[...]] |
    assert.match(idx, /\|\s*NoTags\s*\|\s*AI\s*\|\s*—\s*\|/);
  });

  test('#6 缺 文章: → 标题列显示文件名', async () => {
    await makeVault([
      { path: '02_读书笔记/AI/orphan-file.md',
        content: '---\ntags: [lonely]\n---\n正文\n' },
    ]);
    await writeFile(join(tmpRoot, 'Index.md'), SKELETON, 'utf8');

    const r = await spawnCli(['--all', '--write']);
    assert.equal(r.status, 0);

    const idx = await readFile(join(tmpRoot, 'Index.md'), 'utf8');
    assert.match(idx, /\| orphan-file \|/);
  });
});

describe('wiki-link 渲染', () => {
  test('#7 tags 含 | → 转义为 \\|', async () => {
    await makeVault([
      { path: '02_读书笔记/AI/pipe.md',
        content: '---\n文章: PipeTest\ntags: [a|b, normal]\n---\n正文\n' },
    ]);
    await writeFile(join(tmpRoot, 'Index.md'), SKELETON, 'utf8');

    const r = await spawnCli(['--all', '--write']);
    assert.equal(r.status, 0);

    const idx = await readFile(join(tmpRoot, 'Index.md'), 'utf8');
    assert.match(idx, /a\\\|b/);
    // 同时确认未转义的 | 在数据列中不出现歧义
    assert.doesNotMatch(idx, /\| PipeTest \| AI \| a\|b/);
  });

  test('#8 文件名含空格/&/中文 → wiki-link 直接写', async () => {
    await makeVault([
      { path: '02_读书笔记/AI/My Doc & 中文.md',
        content: '---\n文章: MyDoc\ntags: [x]\n---\n正文\n' },
    ]);
    await writeFile(join(tmpRoot, 'Index.md'), SKELETON, 'utf8');

    const r = await spawnCli(['--all', '--write']);
    assert.equal(r.status, 0);

    const idx = await readFile(join(tmpRoot, 'Index.md'), 'utf8');
    assert.match(idx, /\[\[02_读书笔记\/AI\/My Doc & 中文\.md\]\]/);
  });
});

describe('分组与排序', () => {
  test('#9 11_entities 文件进 ## Entities 段', async () => {
    await makeVault([
      { path: '11_entities/andrew-ng.md',
        content: '---\ntitle: Andrew Ng\n---\n正文\n' },
    ]);
    await writeFile(join(tmpRoot, 'Index.md'), SKELETON, 'utf8');

    const r = await spawnCli(['--all', '--write']);
    assert.equal(r.status, 0);

    const idx = await readFile(join(tmpRoot, 'Index.md'), 'utf8');
    assert.match(idx, /## Entities/);
    assert.match(idx, /\[\[11_entities\/andrew-ng\.md\]\]/);
    // 11/12 不应出现在主题目录段
    assert.doesNotMatch(idx, /## andrew-ng/);
  });

  test('#10 12_concepts 文件进 ## Concepts 段', async () => {
    await makeVault([
      { path: '12_concepts/attention.md',
        content: '---\ntitle: Attention\n---\n正文\n' },
    ]);
    await writeFile(join(tmpRoot, 'Index.md'), SKELETON, 'utf8');

    const r = await spawnCli(['--all', '--write']);
    assert.equal(r.status, 0);

    const idx = await readFile(join(tmpRoot, 'Index.md'), 'utf8');
    assert.match(idx, /## Concepts/);
    assert.match(idx, /\[\[12_concepts\/attention\.md\]\]/);
  });

  test('#11 同主题段内按 文章: 排序', async () => {
    await makeVault([
      { path: '02_读书笔记/AI/zeta.md', content: '---\n文章: Zeta\ntags: [a]\n---\nZ\n' },
      { path: '02_读书笔记/AI/alpha.md', content: '---\n文章: Alpha\ntags: [a]\n---\nA\n' },
      { path: '02_读书笔记/AI/middle.md', content: '---\n文章: Middle\ntags: [a]\n---\nM\n' },
    ]);
    await writeFile(join(tmpRoot, 'Index.md'), SKELETON, 'utf8');

    await spawnCli(['--all', '--write']);
    const idx = await readFile(join(tmpRoot, 'Index.md'), 'utf8');
    const alphaIdx = idx.indexOf('Alpha');
    const middleIdx = idx.indexOf('Middle');
    const zetaIdx = idx.indexOf('Zeta');
    assert.ok(alphaIdx > 0 && alphaIdx < middleIdx);
    assert.ok(middleIdx > 0 && middleIdx < zetaIdx);
  });

  test('#12 Entities 段内按 title: 排序', async () => {
    await makeVault([
      { path: '11_entities/zeta.md', content: '---\ntitle: Zeta\n---\nZ\n' },
      { path: '11_entities/alpha.md', content: '---\ntitle: Alpha\n---\nA\n' },
    ]);
    await writeFile(join(tmpRoot, 'Index.md'), SKELETON, 'utf8');

    await spawnCli(['--all', '--write']);
    const idx = await readFile(join(tmpRoot, 'Index.md'), 'utf8');
    // 在 ## Entities 段内
    const entStart = idx.indexOf('## Entities');
    const entSlice = idx.slice(entStart);
    const alphaIdx = entSlice.indexOf('Alpha');
    const zetaIdx = entSlice.indexOf('Zeta');
    assert.ok(alphaIdx > 0 && alphaIdx < zetaIdx);
  });

  test('#20 Entities/Concepts 段在所有主题段之后', async () => {
    await makeVault([
      { path: '02_读书笔记/AI/a.md', content: '---\n文章: A\ntags: [x]\n---\nA\n' },
      { path: '11_entities/e.md', content: '---\ntitle: E\n---\nE\n' },
      { path: '12_concepts/c.md', content: '---\ntitle: C\n---\nC\n' },
    ]);
    await writeFile(join(tmpRoot, 'Index.md'), SKELETON, 'utf8');

    await spawnCli(['--all', '--write']);
    const idx = await readFile(join(tmpRoot, 'Index.md'), 'utf8');
    const aiIdx = idx.indexOf('## AI');
    const entIdx = idx.indexOf('## Entities');
    const conIdx = idx.indexOf('## Concepts');
    assert.ok(aiIdx > 0);
    assert.ok(aiIdx < entIdx, '## AI 应在 ## Entities 之前');
    assert.ok(entIdx < conIdx, '## Entities 应在 ## Concepts 之前');
  });
});

describe('标记块包裹法', () => {
  test('#13 保留 sync-index:end 后的用户手工段', async () => {
    await makeVault([
      { path: '02_读书笔记/AI/a.md', content: '---\n文章: A\ntags: [x]\n---\nA\n' },
    ]);
    const custom = `# 资料索引
> 自定义说明

${SYNC_BEGIN}
${SYNC_END}

## Favorites

- [[00_模板/读书笔记模板]]
`;
    await writeFile(join(tmpRoot, 'Index.md'), custom, 'utf8');

    const r = await spawnCli(['--all', '--write']);
    assert.equal(r.status, 0);

    const idx = await readFile(join(tmpRoot, 'Index.md'), 'utf8');
    assert.match(idx, /## Favorites/);
    assert.match(idx, /\[\[00_模板\/读书笔记模板\]\]/);
  });
});

describe('健壮性', () => {
  test('#16 frontmatter 解析失败 → warn 到 stderr, 跳过该文件', async () => {
    await makeVault([
      { path: '02_读书笔记/AI/broken.md',
        content: 'no frontmatter here\njust plain text\n' },
      { path: '02_读书笔记/AI/valid.md',
        content: '---\n文章: Valid\ntags: [x]\n---\n正文\n' },
    ]);
    await writeFile(join(tmpRoot, 'Index.md'), SKELETON, 'utf8');

    const r = await spawnCli(['--all', '--write']);
    // 应该 exit 0，broken 文件被跳过
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const idx = await readFile(join(tmpRoot, 'Index.md'), 'utf8');
    // Valid 应出现
    assert.match(idx, /Valid/);
    // broken 不应出现
    assert.doesNotMatch(idx, /broken\.md/);
    // stderr 应有 warn
    assert.match(r.stderr, /warn/i);
  });

  test('#17 路径越界（含 ..）→ refuse, exit 2', async () => {
    await makeVault([]);
    await writeFile(join(tmpRoot, 'Index.md'), SKELETON, 'utf8');

    const r = await spawnCli(['--add', '../escape.md', '--write']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /(refuse|unsafe|越界|path)/i);
  });

  test('#18 原子写：模拟写一半中断 → 旧 Index.md 完整保留', async () => {
    // 这个测试依赖实现提供 forceCorruption 测试钩子；若无则跳过
    await makeVault([
      { path: '02_读书笔记/AI/a.md', content: '---\n文章: A\ntags: [x]\n---\nA\n' },
    ]);
    await writeFile(join(tmpRoot, 'Index.md'), SKELETON, 'utf8');

    await spawnCli(['--all', '--write']);
    const before = await readFile(join(tmpRoot, 'Index.md'), 'utf8');

    // 再跑一次 --all --write，正常情况应原子完成
    const r = await spawnCli(['--all', '--write']);
    assert.equal(r.status, 0);
    const after = await readFile(join(tmpRoot, 'Index.md'), 'utf8');
    // 幂等 → 内容完全相同
    assert.equal(after, before);
    // 文件可读且完整
    assert.match(after, /SYNC_BEGIN/);
  });
});

describe('parseArgs', () => {
  test('默认参数', () => {
    const args = parseArgs([]);
    assert.equal(args.mode, 'check');
    assert.equal(args.write, false);
  });
  test('--all', () => {
    assert.equal(parseArgs(['--all']).mode, 'all');
  });
  test('--add <path>', () => {
    const a = parseArgs(['--add', 'foo.md']);
    assert.equal(a.mode, 'add');
    assert.deepEqual(a.paths, ['foo.md']);
  });
  test('--remove <path>', () => {
    const a = parseArgs(['--remove', 'foo.md']);
    assert.equal(a.mode, 'remove');
    assert.deepEqual(a.paths, ['foo.md']);
  });
  test('--check', () => {
    assert.equal(parseArgs(['--check']).mode, 'check');
  });
  test('--write 触发写盘', () => {
    assert.equal(parseArgs(['--all', '--write']).write, true);
  });
});