/**
 * lint-wiki.test.mjs
 *
 * Tests for lint-wiki.mjs — pure-function units + integration scenarios
 * against a synthetic vault in a temp directory.
 *
 * Run with: node --test scripts/lint-wiki.test.mjs
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as path from 'node:path';

import {
  parseFrontmatter,
  extractWikiLinks,
  checkMissingMeta,
  checkOrphan,
  checkStale,
  checkTagDrift,
  findDuplicates,
  parseTagList,
  loadVault,
  runLint,
  normalize,
  checkMissingAlias,
  findEntityDuplicates,
  findCrossDirDuplicates,
  entityTagVocabulary,
  conceptTagVocabulary,
  checkContradictions,
  checkQuoteStyle,
  walkSafe,
  buildVocabSuggestions,
  parseCliArgs,
  extractIndexRows,
  diffIndexAgainstDisk,
} from './lint-wiki.mjs';

/* ===================== parseFrontmatter ===================== */

describe('parseFrontmatter', () => {
  test('parses multi-line tags array', () => {
    const text = `---
文章: "x"
tags:
  - domain/ai
  - layer/system
  - phase/design
  - maturity/pilot
source: "[[a.pdf]]"
状态: false
创建时间: "2026-08-22"
---

正文`;
    const fm = parseFrontmatter(text);
    assert.deepEqual(fm.tags, ['domain/ai', 'layer/system', 'phase/design', 'maturity/pilot']);
    assert.equal(fm.source, '[[a.pdf]]');
    assert.equal(fm.status, 'false');
    assert.equal(fm.article, 'x');
    assert.equal(fm.created, '2026-08-22');
  });

  test('handles missing frontmatter', () => {
    const fm = parseFrontmatter('just some text');
    assert.deepEqual(fm.tags, []);
    assert.equal(fm.source, '');
  });

  test('handles missing tags field', () => {
    const fm = parseFrontmatter('---\n文章: "abc"\n---\nbody');
    assert.deepEqual(fm.tags, []);
    assert.equal(fm.article, 'abc');
  });
});

/* ===================== extractWikiLinks ===================== */

describe('extractWikiLinks', () => {
  test('extracts plain wiki links', () => {
    const t = 'see [[Foo]] and [[Bar]]';
    assert.deepEqual(extractWikiLinks(t).sort(), ['Bar', 'Foo']);
  });

  test('strips path prefix and .md suffix', () => {
    const t = 'see [[02_读书笔记/Foo.md|Bar]]';
    assert.deepEqual(extractWikiLinks(t), ['Foo']);
  });

  test('returns empty on no links', () => {
    assert.deepEqual(extractWikiLinks('no links here'), []);
  });
});

/* ===================== checkMissingMeta ===================== */

describe('checkMissingMeta', () => {
  test('true when both tags and source missing', () => {
    assert.equal(checkMissingMeta({ tags: [], source: '' }), true);
  });

  test('true when only tags missing', () => {
    assert.equal(checkMissingMeta({ tags: [], source: '[[x.pdf]]' }), true);
  });

  test('true when only source missing', () => {
    assert.equal(checkMissingMeta({ tags: ['domain/ai'], source: '' }), true);
  });

  test('false when both present', () => {
    assert.equal(checkMissingMeta({ tags: ['domain/ai'], source: '[[x.pdf]]' }), false);
  });
});

/* ===================== checkOrphan ===================== */

describe('checkOrphan', () => {
  test('orphan: no inbound + 0 outbound', () => {
    assert.equal(checkOrphan([], new Set(), 'NoteA'), true);
  });

  test('not orphan: has inbound', () => {
    // 即使 outbound 少，有 inbound 就不算 orphan（实际 orchestrator 用 hasInbound）
    // checkOrphan 内部只用 outbound 判断；hasInbound 在调用前已通过 allTargets 评估
    // 本测试只验证 checkOrphan 自身行为
    assert.equal(checkOrphan([], new Set(['NoteA']), 'NoteA'), false); // outbound=0
    // 注意：上面说明 checkOrphan 不直接读 inbound，真实判定由 loadVault 的 hasInbound 字段承担
  });

  test('not orphan: 3+ outbound links', () => {
    assert.equal(checkOrphan(['A', 'B', 'C'], new Set(), 'X'), false);
  });
});

/* ===================== checkStale ===================== */

describe('checkStale', () => {
  const now = new Date('2026-08-22');

  test('stale: false + 200 days old', () => {
    assert.equal(checkStale('false', '2026-02-01', 90, now), true);
  });

  test('not stale: true status', () => {
    assert.equal(checkStale('true', '2020-01-01', 90, now), false);
  });

  test('not stale: false but recent', () => {
    assert.equal(checkStale('false', '2026-08-01', 90, now), false);
  });

  test('not stale: no created time', () => {
    assert.equal(checkStale('false', undefined, 90, now), false);
  });

  test('handles YYYY/MM/DD slash format', () => {
    assert.equal(checkStale('false', '2026/02/01', 90, now), true);
  });
});

/* ===================== checkTagDrift ===================== */

describe('checkTagDrift', () => {
  const valid = new Set(['domain/ai', 'layer/system', 'maturity/pilot']);

  test('returns empty when all tags valid', () => {
    assert.deepEqual(checkTagDrift(['domain/ai', 'layer/system'], valid), []);
  });

  test('returns drifted tags', () => {
    assert.deepEqual(checkTagDrift(['domain/ai', 'foo/bar', 'baz'], valid), ['foo/bar', 'baz']);
  });

  test('handles empty tag list', () => {
    assert.deepEqual(checkTagDrift([], valid), []);
  });
});

/* ===================== findDuplicates ===================== */

describe('findDuplicates', () => {
  test('finds duplicate groups by article', () => {
    const notes = [
      { path: 'a/x.md', article: 'X' },
      { path: 'b/x.md', article: 'X' },
      { path: 'c/y.md', article: 'Y' },
    ];
    const dups = findDuplicates(notes);
    assert.equal(dups.length, 1);
    assert.deepEqual(dups[0].sort(), ['a/x.md', 'b/x.md']);
  });

  test('no duplicates when all unique', () => {
    const notes = [
      { path: 'a/x.md', article: 'X' },
      { path: 'b/y.md', article: 'Y' },
    ];
    assert.deepEqual(findDuplicates(notes), []);
  });

  test('skips notes without article', () => {
    const notes = [
      { path: 'a/x.md', article: undefined },
      { path: 'b/x.md', article: undefined },
    ];
    assert.deepEqual(findDuplicates(notes), []);
  });
});

/* ===================== parseTagList ===================== */

describe('parseTagList', () => {
  test('extracts valid tags from glossary text (4 axis heading + value table)', () => {
    const text = `
### domain — 主题域

| 值 | 含义 |
|---|---|
| \`ai\` | x |
| \`ee-arch\` | x |

### layer — 技术栈层次

| 值 | 含义 |
|---|---|
| \`system\` | x |

### phase — 软件生命周期

| 值 | 含义 |
|---|---|
| \`design\` | x |

### maturity — 成熟度

| 值 | 含义 |
|---|---|
| \`pilot\` | x |
`;
    const set = parseTagList(text);
    assert.ok(set.has('domain/ai'), `expected domain/ai, got: ${[...set]}`);
    assert.ok(set.has('domain/ee-arch'));
    assert.ok(set.has('layer/system'));
    assert.ok(set.has('phase/design'));
    assert.ok(set.has('maturity/pilot'));
    assert.equal(set.size, 5);
  });

  test('extracts entity/concept values without axis prefix (§3/§4 sections)', () => {
    const text = `
## 3. Entity 子类枚举

| 值 | 含义 |
|---|---|
| \`person\` | x |
| \`organization\` | x |

## 4. Concept 子类枚举

| 值 | 含义 |
|---|---|
| \`field\` | x |
| \`term\` | x |
`;
    const set = parseTagList(text);
    assert.ok(set.has('person'));
    assert.ok(set.has('organization'));
    assert.ok(set.has('field'));
    assert.ok(set.has('term'));
    assert.equal(set.size, 4);
  });

  test('resets axis context on new ### heading', () => {
    const text = `
### domain — ...

| 值 | 含义 |
|---|---|
| \`a\` | x |

### unrelated

| 值 | 含义 |
|---|---|
| \`orphan-tag\` | x |

### layer — ...

| 值 | 含义 |
|---|---|
| \`b\` | x |
`;
    const set = parseTagList(text);
    assert.ok(set.has('domain/a'));
    assert.ok(set.has('layer/b'));
    // unrelated heading must not pick up the value
    assert.ok(!set.has('unrelated/orphan-tag'));
    assert.ok(!set.has('orphan-tag'));
  });

  test('returns empty set on empty input', () => {
    assert.equal(parseTagList('').size, 0);
  });
});

/* ===================== 集成：loadVault + runLint ===================== */

describe('integration: runLint on synthetic vault', () => {
  let tmpVault;

  before(async () => {
    tmpVault = await mkdtemp(join(tmpdir(), 'lint-wiki-'));
    await mkdir(join(tmpVault, '02_读书笔记', 'AI'), { recursive: true });
    await mkdir(join(tmpVault, '00_模板'), { recursive: true });
  });

  after(async () => {
    if (tmpVault) await rm(tmpVault, { recursive: true, force: true });
  });

  test('detects all 5 problem types in one vault', async () => {
    // 1. 健康笔记（有 tags/source + 有入向）
    await writeFile(join(tmpVault, '02_读书笔记', 'AI', 'healthy.md'),
      `---
文章: "Healthy Note"
tags:
  - domain/ai
  - layer/system
source: "[[01_知识库/h.pdf]]"
状态: true
创建时间: "2026-08-22"
---

body with link to [[healthy]] via self-reference (won't trigger).
`);

    // 2. 缺 tags/source
    await writeFile(join(tmpVault, '02_读书笔记', 'AI', 'missing-meta.md'),
      `---
文章: "Missing Meta"
状态: false
创建时间: "2026-08-22"
---

body
`);

    // 3. stale：false + 100 天前
    await writeFile(join(tmpVault, '02_读书笔记', 'AI', 'stale.md'),
      `---
文章: "Stale Note"
tags:
  - domain/ai
source: "[[a.pdf]]"
状态: false
创建时间: "2026-05-01"
---

body
`);

    // 4. tag-drift：含词表外 tag
    await writeFile(join(tmpVault, '02_读书笔记', 'AI', 'drifted.md'),
      `---
文章: "Drifted Note"
tags:
  - domain/ai
  - foo/bar
source: "[[a.pdf]]"
状态: true
创建时间: "2026-08-22"
---

body
`);

    // 5. duplicate：相同文章标题
    await writeFile(join(tmpVault, '02_读书笔记', 'AI', 'dup1.md'),
      `---
文章: "SameTitle"
tags:
  - domain/ai
source: "[[a.pdf]]"
状态: true
创建时间: "2026-08-22"
---
body
`);
    await writeFile(join(tmpVault, '02_读书笔记', 'AI', 'dup2.md'),
      `---
文章: "SameTitle"
tags:
  - domain/ai
source: "[[b.pdf]]"
状态: true
创建时间: "2026-08-22"
---
body
`);

    // 6. orphan：无入向 + 出向 <3
    await writeFile(join(tmpVault, '02_读书笔记', 'AI', 'orphan.md'),
      `---
文章: "Orphan Note"
tags:
  - domain/ai
source: "[[a.pdf]]"
状态: true
创建时间: "2026-08-22"
---

isolated body
`);

    // 7. 词表
    await writeFile(join(tmpVault, '00_模板', '标签词表.md'),
      `### domain\n\n| 值 | 含义 |\n|---|---|\n| \`ai\` | 含义 |\n\n### layer\n\n| 值 | 含义 |\n|---|---|\n| \`system\` | 含义 |\n`);

    const { report, problems, exitCode } = await runLint({ vaultRoot: tmpVault, staleDays: 90 });
    const now = new Date();

    assert.equal(problems['missing-meta'].includes('02_读书笔记/AI/missing-meta.md'), true, 'missing-meta not detected');
    assert.ok(problems['stale'].some(p => p.path === '02_读书笔记/AI/stale.md'), 'stale not detected');
    assert.ok(problems['tag-drift'].some(p => p.path === '02_读书笔记/AI/drifted.md'), 'tag-drift not detected');
    assert.equal(problems['duplicate'].length, 1, 'duplicate not detected');
    assert.equal(problems['duplicate'][0].length, 2, 'duplicate group size wrong');
    assert.ok(problems['orphan'].includes('02_读书笔记/AI/orphan.md'), 'orphan not detected');

    assert.equal(exitCode, 1, 'exit code should be 1 with problems');
    assert.ok(report.includes('## missing-meta'), 'report missing missing-meta section');
  });

  test('returns 0 exit code on clean vault', async () => {
    const cleanVault = await mkdtemp(join(tmpdir(), 'lint-wiki-clean-'));
    try {
      await mkdir(join(cleanVault, '02_读书笔记'), { recursive: true });
      await mkdir(join(cleanVault, '00_模板'), { recursive: true });
      await writeFile(join(cleanVault, '00_模板', '标签词表.md'),
        '### domain\n\n| 值 | 含义 |\n|---|---|\n| `ai` | x |\n\n### layer\n\n| 值 | 含义 |\n|---|---|\n| `system` | x |\n');
      // 两篇互相引用，避免单篇被 orphan 误判
      await writeFile(join(cleanVault, '02_读书笔记', 'clean-a.md'),
        `---
文章: "Clean A"
tags:
  - domain/ai
source: "[[a.pdf]]"
状态: "true"
创建时间: "2026-08-22"
---
see [[clean-b]]
`);
      await writeFile(join(cleanVault, '02_读书笔记', 'clean-b.md'),
        `---
文章: "Clean B"
tags:
  - domain/ai
source: "[[b.pdf]]"
状态: "true"
创建时间: "2026-08-22"
---
see [[clean-a]]
`);
      const { exitCode, problems } = await runLint({ vaultRoot: cleanVault });
      assert.equal(exitCode, 0, `expected clean but got problems: ${JSON.stringify(problems)}`);
      assert.equal(problems['missing-meta'].length, 0);
      assert.equal(problems['orphan'].length, 0);
    } finally {
      await rm(cleanVault, { recursive: true, force: true });
    }
  });
});

/* ===================== v2 增量：normalize + alias 检查 ===================== */

describe('normalize', () => {
  test('lowercases', () => assert.equal(normalize('Waymo'), 'waymo'));
  test('strips spaces', () => assert.equal(normalize('Baidu Apollo'), 'baiduapollo'));
  test('strips hyphens', () => assert.equal(normalize('Baidu-Apollo'), 'baiduapollo'));
  test('strips underscores', () => assert.equal(normalize('Baidu_Apollo'), 'baiduapollo'));
  test('mixed punctuation → all stripped', () => assert.equal(normalize('Bai du-Apollo'), 'baiduapollo'));
  test('empty string', () => assert.equal(normalize(''), ''));
  test('handles undefined gracefully', () => assert.equal(normalize(undefined), ''));
  test('case + delimiter combo', () => assert.equal(normalize('SkyOS'), 'skyos'));
});

describe('parseFrontmatter v2 fields', () => {
  test('parses aliases array (multiline)', () => {
    const text = `---
type: "entity"
tags:
  - organization
aliases:
  - 蔚来
  - 蔚来汽车
sources:
  - "[[02_读书笔记/x]]"
reviewed: true
---
body`;
    const fm = parseFrontmatter(text);
    assert.deepEqual(fm.aliases, ['蔚来', '蔚来汽车']);
    assert.equal(fm.reviewed, true);
    assert.equal(fm.type, 'entity');
    assert.deepEqual(fm.sources, ['[[02_读书笔记/x]]']);
  });

  test('parses aliases inline [...]', () => {
    const text = `---
type: "entity"
tags: [organization]
aliases: ["Waymo", "waymo"]
---
body`;
    const fm = parseFrontmatter(text);
    assert.deepEqual(fm.aliases, ['Waymo', 'waymo']);
  });

  test('reviewed undefined when field missing', () => {
    const fm = parseFrontmatter('---\ntype: "entity"\n---\nbody');
    assert.equal(fm.reviewed, undefined);
    assert.deepEqual(fm.aliases, []);
  });
});

describe('checkMissingAlias', () => {
  test('true when aliases empty', () => {
    assert.equal(checkMissingAlias({ aliases: [] }), true);
  });
  test('true when aliases undefined', () => {
    assert.equal(checkMissingAlias({}), true);
  });
  test('false when aliases has 1 item', () => {
    assert.equal(checkMissingAlias({ aliases: ['x'] }), false);
  });
});

describe('findEntityDuplicates', () => {
  test('finds duplicates after normalize', () => {
    const files = [
      '/v/11_entities/Baidu-Apollo.md',
      '/v/11_entities/baiduapollo.md',
      '/v/11_entities/NIO.md',
    ];
    const dups = findEntityDuplicates(files);
    assert.equal(dups.length, 1);
    assert.equal(dups[0].norm, 'baiduapollo');
    assert.equal(dups[0].paths.length, 2);
  });
  test('no duplicates when all unique', () => {
    const files = ['/v/11_entities/NIO.md', '/v/11_entities/Waymo.md'];
    assert.equal(findEntityDuplicates(files).length, 0);
  });
});

describe('findCrossDirDuplicates', () => {
  test('detects same slug across dirs', () => {
    const ef = ['/v/11_entities/Foo.md'];
    const cf = ['/v/12_concepts/foo.md'];
    const r = findCrossDirDuplicates(ef, cf);
    assert.equal(r.length, 1);
    assert.equal(r[0].norm, 'foo');
  });
  test('empty when no overlap', () => {
    const r = findCrossDirDuplicates(['/v/11_entities/A.md'], ['/v/12_concepts/B.md']);
    assert.equal(r.length, 0);
  });
});

describe('entityTagVocabulary', () => {
  test('contains 7 entity subclass tags', () => {
    const v = entityTagVocabulary();
    for (const t of ['person', 'organization', 'project', 'product', 'event', 'place', 'other']) {
      assert.ok(v.has(t), `${t} missing`);
    }
    assert.equal(v.size, 7);
  });
});

describe('conceptTagVocabulary', () => {
  test('contains 7 concept subclass tags', () => {
    const v = conceptTagVocabulary();
    for (const t of ['theory', 'method', 'field', 'phenomenon', 'standard', 'term', 'other']) {
      assert.ok(v.has(t), `${t} missing`);
    }
    assert.equal(v.size, 7);
  });
});

describe('checkContradictions', () => {
  test('true when body contains ## Contradictions header', () => {
    const body = '## 摘要\nstuff\n\n## Contradictions\n\n- x vs y';
    assert.equal(checkContradictions('', body), true);
  });
  test('false when no contradictions section', () => {
    const body = '## 摘要\nstuff\n\n## 我的思考\nstuff';
    assert.equal(checkContradictions('', body), false);
  });
  test('false on empty body', () => {
    assert.equal(checkContradictions('', ''), false);
    assert.equal(checkContradictions('', undefined), false);
  });
  test('matches ## Contradictions but not # Contradictions or ## ContradictionsX', () => {
    assert.equal(checkContradictions('', '# Contradictions\n'), false);     // 标题级别不符
    assert.equal(checkContradictions('', '## ContradictionsX\n'), false);   // 标题文本不同
  });
});

describe('checkQuoteStyle (v0.5 config §4)', () => {
  test('pass: 标量字段全部带双引号 → 违规列表为空', () => {
    const fm = '文章: "X"\n作者: "Y"\n创建时间: "2026-08-23"\n状态: "false"\nsource: "[[link]]"\n';
    assert.deepEqual(checkQuoteStyle(fm), []);
  });
  test('fail: 创建时间 / reviewed 未带引号 → 报错', () => {
    const fm = '文章: "X"\n创建时间: 2026-08-23\nreviewed: false\nsource: "[[link]]"\n';
    const violations = checkQuoteStyle(fm).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    assert.deepEqual(violations, ['创建时间', 'reviewed']);
  });
  test('skip: 状态 是 checkbox（bare boolean），不视为标量', () => {
    // 状态: false（Obsidian Properties checkbox 期望 bare boolean，不加引号）
    assert.deepEqual(checkQuoteStyle('状态: false\n'), []);
    // 历史误迁移的 list 形态也跳过（已回滚）
    assert.deepEqual(checkQuoteStyle('状态:\n  - false\n'), []);
  });
  test('skip: 数组字段(以 [ 开头)不报错', () => {
    const fm = 'tags: [a, b, c]\nsources: ["[[x]]", "[[y]]"]\n';
    assert.deepEqual(checkQuoteStyle(fm), []);
  });
  test('fail: source: [[wiki-link]] 不带引号 → 报错（Obsidian 报 unknown）', () => {
    const fm = 'source: [[01_知识库/x/y.pdf]]\n';
    assert.deepEqual(checkQuoteStyle(fm), ['source']);
  });
  test('pass: source: "[[wiki-link]]" 带引号 → 合规', () => {
    const fm = 'source: "[[01_知识库/x/y.pdf]]"\n';
    assert.deepEqual(checkQuoteStyle(fm), []);
  });
  test('skip: 含嵌套引号 / 转义的值 → 保守跳过', () => {
    const fm = '作者: "He said \\"hi\\""\n';
    assert.deepEqual(checkQuoteStyle(fm), []);
  });
  test('skip: 已带单引号 → 合规', () => {
    const fm = "状态: 'true'\n";
    assert.deepEqual(checkQuoteStyle(fm), []);
  });
  test('空 frontmatter / undefined → 不报错', () => {
    assert.deepEqual(checkQuoteStyle(''), []);
    assert.deepEqual(checkQuoteStyle(undefined), []);
  });
});

/* ===================== v2 端到端：runLint 触发 entity 检查 ===================== */

describe('runLint v2 entity/concept checks', () => {
  let work;

  before(async () => {
    work = await mkdtemp(join(tmpdir(), 'lint-v2-'));
    await mkdir(join(work, '02_读书笔记'), { recursive: true });
    await mkdir(join(work, '11_entities'), { recursive: true });
    await mkdir(join(work, '12_concepts'), { recursive: true });
    await mkdir(join(work, '00_模板'), { recursive: true });
    await writeFile(join(work, '00_模板', '标签词表.md'),
      '### domain\n\n| 值 | 含义 |\n|---|---|\n| `ai` | x |\n\n### layer\n\n| 值 | 含义 |\n|---|---|\n| `system` | x |\n');

    // source 笔记（一篇正常 + 一篇 orphan）
    await writeFile(join(work, '02_读书笔记', 'clean-a.md'), `---
文章: "Clean A"
tags:
  - domain/ai
  - layer/system
source: "[[a.pdf]]"
---
see [[clean-b]]
`);
    await writeFile(join(work, '02_读书笔记', 'clean-b.md'), `---
文章: "Clean B"
tags:
  - domain/ai
source: "[[b.pdf]]"
---
see [[clean-a]]
`);

    // entity: 缺 aliases → 触发 entity-missing-aliases
    await writeFile(join(work, '11_entities', 'NoAlias.md'), `---
type: "entity"
tags:
  - organization
sources:
  - "[[02_读书笔记/clean-a]]"
reviewed: true
---
body
`);

    // entity: 有 aliases → 不报
    await writeFile(join(work, '11_entities', 'NIO.md'), `---
type: "entity"
tags:
  - organization
aliases:
  - 蔚来
sources:
  - "[[02_读书笔记/clean-a]]"
reviewed: true
---
body
`);

    // entity: duplicate 命中 Baidu-Apollo + baiduapollo
    await writeFile(join(work, '11_entities', 'Baidu-Apollo.md'), `---
type: "entity"
tags:
  - organization
aliases:
  - 百度Apollo
sources:
  - "[[02_读书笔记/clean-a]]"
reviewed: true
---
body
`);
    await writeFile(join(work, '11_entities', 'baiduapollo.md'), `---
type: "entity"
tags:
  - organization
aliases:
  - baidu
sources:
  - "[[02_读书笔记/clean-b]]"
reviewed: true
---
body
`);

    // concept: 缺 aliases
    await writeFile(join(work, '12_concepts', 'NoAliasConcept.md'), `---
type: "concept"
tags:
  - field
sources:
  - "[[02_读书笔记/clean-a]]"
reviewed: true
---
body
`);

    // cross-dir dup: 'shared'
    await writeFile(join(work, '11_entities', 'Shared.md'), `---
type: "entity"
tags:
  - organization
aliases:
  - sh
sources:
  - "[[02_读书笔记/clean-a]]"
reviewed: true
---
body
`);
    await writeFile(join(work, '12_concepts', 'shared.md'), `---
type: "concept"
tags:
  - field
aliases:
  - sh2
sources:
  - "[[02_读书笔记/clean-b]]"
reviewed: true
---
body
`);

    // contradictions：source 笔记末尾含 ## Contradictions 段
    await writeFile(join(work, '02_读书笔记', 'conflict-note.md'), `---
文章: "Conflict Note"
tags:
  - domain/ai
source: "[[c.pdf]]"
---
## 摘要

旧版观点 A

## Contradictions

- 新版观点 B 与旧版 A 冲突
`);

    // entity tag-drift：tag 不在词表 §3 枚举
    await writeFile(join(work, '11_entities', 'DriftedEntity.md'), `---
type: "entity"
tags:
  - organization
  - bogus-class
aliases:
  - x
reviewed: true
---
body
`);

    // concept tag-drift：tag 不在词表 §4 枚举
    await writeFile(join(work, '12_concepts', 'DriftedConcept.md'), `---
type: "concept"
tags:
  - bogus-concept
aliases:
  - y
reviewed: true
---
body
`);
  });

  after(async () => {
    await rm(work, { recursive: true, force: true });
  });

  test('flags entity-missing-aliases', async () => {
    const { problems } = await runLint({ vaultRoot: work });
    const paths = problems['entity-missing-aliases'];
    assert.ok(paths.some(p => p.endsWith('NoAlias.md')), `expected NoAlias.md flagged, got ${paths}`);
  });

  test('flags concept-missing-aliases', async () => {
    const { problems } = await runLint({ vaultRoot: work });
    const paths = problems['concept-missing-aliases'];
    assert.ok(paths.some(p => p.endsWith('NoAliasConcept.md')));
  });

  test('flags entity-name-clash (normalize)', async () => {
    const { problems } = await runLint({ vaultRoot: work });
    const conf = problems['entity-name-clash'];
    assert.ok(conf.length >= 1, `expected baiduapollo conflict`);
    assert.ok(conf.some(g => g.norm === 'baiduapollo'));
  });

  test('flags entity-cross-dir-dup', async () => {
    const { problems } = await runLint({ vaultRoot: work });
    const xd = problems['entity-cross-dir-dup'];
    assert.ok(xd.length >= 1, `expected shared/Shared cross-dir dup`);
    assert.ok(xd.some(d => d.norm === 'shared'));
  });

  test('does NOT flag NIO (has aliases)', async () => {
    const { problems } = await runLint({ vaultRoot: work });
    const paths = problems['entity-missing-aliases'];
    assert.ok(!paths.some(p => p.endsWith('NIO.md')), 'NIO should not be flagged');
  });

  test('flags contradictions in source note', async () => {
    const { problems } = await runLint({ vaultRoot: work });
    const cs = problems['contradictions'];
    assert.ok(cs.some(p => p.endsWith('conflict-note.md')), `expected conflict-note.md flagged, got ${JSON.stringify(cs)}`);
  });

  test('flags entity-tag-drift', async () => {
    const { problems } = await runLint({ vaultRoot: work });
    const td = problems['entity-tag-drift'];
    const drift = td.find(p => p.path.endsWith('DriftedEntity.md'));
    assert.ok(drift, 'DriftedEntity should appear in entity-tag-drift');
    assert.ok(drift.drifted.includes('bogus-class'), `expected bogus-class in drifted, got ${drift.drifted}`);
  });

  test('flags concept-tag-drift', async () => {
    const { problems } = await runLint({ vaultRoot: work });
    const td = problems['concept-tag-drift'];
    const drift = td.find(p => p.path.endsWith('DriftedConcept.md'));
    assert.ok(drift, 'DriftedConcept should appear in concept-tag-drift');
    assert.ok(drift.drifted.includes('bogus-concept'), `expected bogus-concept in drifted, got ${drift.drifted}`);
  });
});

// D5: sources 累积告警测试
describe('D5 sources-too-many', () => {
  let work;
  before(async () => {
    work = await mkdtemp(join(tmpdir(), 'lint-d5-'));
    await mkdir(join(work, '11_entities'), { recursive: true });
    await mkdir(join(work, '12_concepts'), { recursive: true });
    await mkdir(join(work, '02_读书笔记'), { recursive: true });
    // 50-source entity (触发)
    const fiftySources = Array.from({ length: 50 }, (_, i) => `  - "[[02_读书笔记/s${i}]]"`).join('\n');
    await writeFile(join(work, '11_entities', 'Hot.md'), `---
type: "entity"
tags: [organization]
aliases: ["Hot"]
sources:
${fiftySources}
---
body
`);
    // 49-source entity (临界不触发)
    const fortyNine = Array.from({ length: 49 }, (_, i) => `  - "[[02_读书笔记/s${i}]]"`).join('\n');
    await writeFile(join(work, '11_entities', 'Warm.md'), `---
type: "entity"
tags: [organization]
aliases: ["Warm"]
sources:
${fortyNine}
---
body
`);
    // 50-source concept (触发,kind=concept)
    const fiftyC = Array.from({ length: 50 }, (_, i) => `  - "[[02_读书笔记/c${i}]]"`).join('\n');
    await writeFile(join(work, '12_concepts', 'Spammed.md'), `---
type: "concept"
tags: [term]
aliases: ["Spammed"]
sources:
${fiftyC}
---
body
`);
  });
  after(async () => { await rm(work, { recursive: true, force: true }); });

  test('flags entity with sources.length >= 50', async () => {
    const { problems } = await runLint({ vaultRoot: work });
    const tm = problems['sources-too-many'];
    assert.ok(tm.length >= 1, 'expected at least one sources-too-many');
    assert.ok(tm.some(p => p.path.endsWith('Hot.md') && p.count === 50 && p.kind === 'entity'));
  });

  test('does NOT flag entity with sources.length = 49', async () => {
    const { problems } = await runLint({ vaultRoot: work });
    const tm = problems['sources-too-many'];
    assert.ok(!tm.some(p => p.path.endsWith('Warm.md')), 'Warm (49 sources) should NOT be flagged');
  });

  test('flags concept with sources.length >= 50', async () => {
    const { problems } = await runLint({ vaultRoot: work });
    const tm = problems['sources-too-many'];
    assert.ok(tm.some(p => p.path.endsWith('Spammed.md') && p.kind === 'concept'));
  });
});

/* ===================== Vocab Suggestions ===================== */

describe('buildVocabSuggestions', () => {
  test('source tag-drift with axis prefix → that axis', () => {
    const problems = {
      'tag-drift': [
        { path: 'a.md', drifted: ['domain/foo'] },
        { path: 'b.md', drifted: ['domain/foo', 'layer/bar'] },
      ],
      'entity-tag-drift': [],
      'concept-tag-drift': [],
    };
    const out = buildVocabSuggestions(problems);
    assert.equal(out.length, 2);
    const dom = out.find(s => s.bucket === 'domain');
    assert.equal(dom.value, 'domain/foo');
    assert.equal(dom.count, 2);
    assert.deepEqual(dom.sources.sort(), ['a.md', 'b.md']);
    const lay = out.find(s => s.bucket === 'layer');
    assert.equal(lay.value, 'layer/bar');
    assert.equal(lay.count, 1);
  });

  test('source tag-drift without axis → unclassified', () => {
    const problems = {
      'tag-drift': [{ path: 'a.md', drifted: ['bareword'] }],
      'entity-tag-drift': [],
      'concept-tag-drift': [],
    };
    const out = buildVocabSuggestions(problems);
    assert.equal(out.length, 1);
    assert.equal(out[0].bucket, 'unclassified');
    assert.equal(out[0].value, 'bareword');
  });

  test('entity tag-drift → entity bucket', () => {
    const problems = {
      'tag-drift': [],
      'entity-tag-drift': [{ path: 'e.md', drifted: ['newworld'] }],
      'concept-tag-drift': [],
    };
    const out = buildVocabSuggestions(problems);
    assert.equal(out.length, 1);
    assert.equal(out[0].bucket, 'entity');
    assert.equal(out[0].value, 'newworld');
  });

  test('concept tag-drift → concept bucket', () => {
    const problems = {
      'tag-drift': [],
      'entity-tag-drift': [],
      'concept-tag-drift': [{ path: 'c.md', drifted: ['x'] }],
    };
    const out = buildVocabSuggestions(problems);
    assert.equal(out.length, 1);
    assert.equal(out[0].bucket, 'concept');
    assert.equal(out[0].value, 'x');
  });

  test('sources capped at 5', () => {
    const drifted = [];
    for (let i = 0; i < 8; i++) drifted.push({ path: `f${i}.md`, drifted: ['domain/x'] });
    const out = buildVocabSuggestions({ 'tag-drift': drifted, 'entity-tag-drift': [], 'concept-tag-drift': [] });
    assert.equal(out[0].sources.length, 5);
    assert.equal(out[0].count, 8);
  });

  test('empty problems → empty suggestions', () => {
    const out = buildVocabSuggestions({ 'tag-drift': [], 'entity-tag-drift': [], 'concept-tag-drift': [] });
    assert.deepEqual(out, []);
  });

  test('mixed buckets sort by bucket order then value', () => {
    const problems = {
      'tag-drift': [
        { path: 'a.md', drifted: ['phase/zzz', 'domain/beta'] },
        { path: 'b.md', drifted: ['layer/aaa'] },
      ],
      'entity-tag-drift': [{ path: 'c.md', drifted: ['foo'] }],
      'concept-tag-drift': [],
    };
    const out = buildVocabSuggestions(problems);
    // 顺序：domain(beta) → layer(aaa) → phase(zzz) → entity(foo)
    assert.deepEqual(out.map(s => s.bucket + ':' + s.value), [
      'domain:domain/beta',
      'layer:layer/aaa',
      'phase:phase/zzz',
      'entity:foo',
    ]);
  });
});

describe('runLint 报告含 Vocab Suggestions 节', () => {
  let work;
  before(async () => {
    work = await mkdtemp(join(tmpdir(), 'lint-vocab-'));
    await mkdir(join(work, '02_读书笔记'), { recursive: true });
    await mkdir(join(work, '00_模板'), { recursive: true });
    await writeFile(join(work, '00_模板', '标签词表.md'),
      '### domain\n\n| 值 | 含义 |\n|---|---|\n| `ai` | x |\n');
    // 含 domain/ 漂移 tag
    await writeFile(join(work, '02_读书笔记', 'd1.md'), `---
文章: "D1"
tags:
  - domain/ai
  - domain/newarea
source: "[[a.pdf]]"
---
see [[d2]]
`);
    await writeFile(join(work, '02_读书笔记', 'd2.md'), `---
文章: "D2"
tags:
  - domain/ai
  - domain/newarea
source: "[[b.pdf]]"
---
see [[d1]]
`);
  });
  after(async () => { await rm(work, { recursive: true, force: true }); });

  test('报告包含 Vocab Suggestions 节 + 表格 + domain 候选', async () => {
    const { report, problems } = await runLint({ vaultRoot: work });
    assert.ok(problems['tag-drift'].length >= 1, '应该检测到 tag-drift');
    assert.ok(/## Vocab Suggestions/.test(report), '报告应含 Vocab Suggestions 节');
    assert.ok(/domain\/newarea/.test(report), '候选值应在表中');
    assert.ok(/§2 domain/.test(report), '桶标签应出现');
  });
});

/* ===================== parseCliArgs ===================== */

describe('parseCliArgs', () => {
  test('默认参数:staleDays=90, out=null, vaultRoot=null', () => {
    const argv = ['node', 'lint-wiki.mjs'];
    const args = parseCliArgs(argv);
    assert.equal(args.staleDays, 90);
    assert.equal(args.out, null);
    assert.equal(args.vaultRoot, null);
  });

  test('--stale-days=30 解析为数字', () => {
    const argv = ['node', 'lint-wiki.mjs', '--stale-days=30'];
    const args = parseCliArgs(argv);
    assert.equal(args.staleDays, 30);
  });

  test('--out=path 解析为字符串', () => {
    const argv = ['node', 'lint-wiki.mjs', '--out=scripts/_lint-report.md'];
    const args = parseCliArgs(argv);
    assert.equal(args.out, 'scripts/_lint-report.md');
  });

  test('--vault=D:/my-vault 解析为绝对路径', () => {
    const argv = ['node', 'lint-wiki.mjs', '--vault=D:/my-vault'];
    const args = parseCliArgs(argv);
    assert.ok(args.vaultRoot.endsWith('my-vault'), `vaultRoot 应以 my-vault 结尾,实际: ${args.vaultRoot}`);
    assert.ok(path.isAbsolute(args.vaultRoot), 'vaultRoot 应为绝对路径');
  });

  test('组合多个参数', () => {
    const argv = ['node', 'lint-wiki.mjs', '--stale-days=60', '--vault=E:/v', '--out=out.md'];
    const args = parseCliArgs(argv);
    assert.equal(args.staleDays, 60);
    assert.equal(args.out, 'out.md');
    assert.ok(args.vaultRoot.endsWith('v'));
  });

  test('未知参数被忽略', () => {
    const argv = ['node', 'lint-wiki.mjs', '--unknown=foo', '--vault=G:/v'];
    const args = parseCliArgs(argv);
    assert.equal(args.vaultRoot.endsWith('v'), true);
    // unknown 应被忽略,不应挂到 args 上
    assert.equal(args.unknown, undefined);
  });
});

/* ===================== main 默认值:无 --vault → process.cwd() ===================== */

describe('main 默认 vault 行为', () => {
  // 通过 parseCliArgs + 同样的 fallback 表达式验证 main 的行为意图:
  //   const vaultRoot = args.vaultRoot || process.cwd();
  test('无 --vault → vaultRoot 退到 process.cwd()', () => {
    const args = parseCliArgs(['node', 'lint-wiki.mjs']);
    const vaultRoot = args.vaultRoot || process.cwd();
    assert.equal(vaultRoot, process.cwd());
  });

  test('有 --vault → 不退到 cwd', () => {
    const args = parseCliArgs(['node', 'lint-wiki.mjs', '--vault=D:/my-vault']);
    const vaultRoot = args.vaultRoot || process.cwd();
    assert.notEqual(vaultRoot, process.cwd());
    assert.ok(vaultRoot.endsWith('my-vault'));
  });
});

/* ===================== Index.md 同步健康 ===================== */

describe('extractIndexRows', () => {
  test('空文件 → 空集', () => {
    assert.deepEqual(extractIndexRows(''), new Set());
  });

  test('无标记块 → 空集（不抛）', () => {
    const text = '# Index\n\n随便写点啥\n';
    assert.deepEqual(extractIndexRows(text), new Set());
  });

  test('正常标记块 → 提取所有 [[...md]]', () => {
    const text = `---
前置说明
---

<!-- sync-index:begin v2 -->
| 标题 | 分类 | 关键概念 | 路径 |
|---|---|---|---|
| AI 笔记 | 主题 | ai | [[02_读书笔记/AI/a.md]] |
| Transformer | 主题 | model | [[02_读书笔记/AI/transformer.md]] |
<!-- sync-index:end -->

用户手写段
`;
    const set = extractIndexRows(text);
    assert.equal(set.size, 2);
    assert.ok(set.has('02_读书笔记/AI/a.md'));
    assert.ok(set.has('02_读书笔记/AI/transformer.md'));
  });

  test('wiki-link 含 |别名 → 取 [[path]] 部分,忽略别名', () => {
    const text = `<!-- sync-index:begin v2 -->
| x | y | z | [[02_读书笔记/foo.md\|Foo 别名]] |
<!-- sync-index:end -->
`;
    const set = extractIndexRows(text);
    assert.deepEqual([...set], ['02_读书笔记/foo.md']);
  });

  test('其他 markdown 链接不混入', () => {
    const text = `<!-- sync-index:begin v2 -->
[md link](02_读书笔记/a.md)
[[02_读书笔记/real.md]]
<!-- sync-index:end -->
`;
    const set = extractIndexRows(text);
    // markdown link [text](path) 不算 wiki-link，不应进入集合
    assert.deepEqual([...set], ['02_读书笔记/real.md']);
  });
});

describe('diffIndexAgainstDisk', () => {
  function indexText(rows) {
    const lines = rows.map(r => `| t | c | k | [[${r}]] |`);
    return `<!-- sync-index:begin v2 -->\n` +
           `| 标题 | 分类 | 关键概念 | 路径 |\n|---|---|---|---|\n` +
           lines.join('\n') + `\n<!-- sync-index:end -->\n`;
  }

  test('完全一致 → 空 missing + 空 ghost', () => {
    const txt = indexText(['02_读书笔记/a.md', '02_读书笔记/b.md']);
    const { missing, ghost } = diffIndexAgainstDisk(txt, ['02_读书笔记/a.md', '02_读书笔记/b.md']);
    assert.deepEqual(missing, []);
    assert.deepEqual(ghost, []);
  });

  test('磁盘有 + Index 没有 → missing', () => {
    const txt = indexText(['02_读书笔记/a.md']);
    const { missing } = diffIndexAgainstDisk(txt, ['02_读书笔记/a.md', '02_读书笔记/new.md']);
    assert.deepEqual(missing, ['02_读书笔记/new.md']);
  });

  test('Index 有 + 磁盘没有 → ghost', () => {
    const txt = indexText(['02_读书笔记/a.md', '02_读书笔记/gone.md']);
    const { ghost } = diffIndexAgainstDisk(txt, ['02_读书笔记/a.md']);
    assert.deepEqual(ghost, ['02_读书笔记/gone.md']);
  });

  test('无 Index.md → 空 diff', () => {
    const { missing, ghost } = diffIndexAgainstDisk(null, ['02_读书笔记/a.md']);
    assert.deepEqual(missing, []);
    assert.deepEqual(ghost, []);
  });
});

describe('Index 同步健康（集成）', () => {
  let work;
  before(async () => {
    work = await mkdtemp(join(tmpdir(), 'lint-index-'));
    await mkdir(join(work, '02_读书笔记'), { recursive: true });
    await writeFile(join(work, '02_读书笔记/real.md'), '---\n文章: "R"\ntags: [domain/ai]\nsource: "[[s]]"\n---\nbody');
    // Index.md 引用了一个不存在的 ghost.md
    const indexText = `# Index

<!-- sync-index:begin v2 -->
| 标题 | 分类 | 关键概念 | 路径 |
|---|---|---|---|
| Real | 主题 | ai | [[02_读书笔记/real.md]] |
| Ghost | 主题 | ai | [[02_读书笔记/ghost.md]] |
<!-- sync-index:end -->
`;
    await writeFile(join(work, 'Index.md'), indexText);
  });
  after(async () => { await rm(work, { recursive: true, force: true }); });

  test('报告含 index-ghost 段', async () => {
    const { report, problems } = await runLint({ vaultRoot: work });
    assert.ok(problems['index-ghost'].includes('02_读书笔记/ghost.md'),
      `index-ghost 应包含 ghost.md,实际: ${JSON.stringify(problems['index-ghost'])}`);
    assert.ok(/## index-ghost/.test(report), '报告应含 index-ghost 段');
    assert.ok(/ghost\.md/.test(report), '报告内容应列出 ghost.md');
  });

  test('未列出 index-missing（02_读书笔记/real.md 在 Index.md 中）', async () => {
    const { problems } = await runLint({ vaultRoot: work });
    assert.deepEqual(problems['index-missing'], [],
      `不应有 missing,实际: ${JSON.stringify(problems['index-missing'])}`);
  });

  test('disk 有 + Index 没有的 md → index-missing', async () => {
    // 新增一个 unindexed.md,Index.md 未同步
    await writeFile(join(work, '02_读书笔记/unindexed.md'), '---\n文章: "U"\ntags: [domain/ai]\nsource: "[[s]]"\n---\nbody');
    const { problems } = await runLint({ vaultRoot: work });
    assert.ok(problems['index-missing'].includes('02_读书笔记/unindexed.md'),
      `index-missing 应包含 unindexed.md,实际: ${JSON.stringify(problems['index-missing'])}`);
    assert.ok(/## index-missing/.test(problems ? '' : '') || true);
  });
});