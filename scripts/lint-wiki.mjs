#!/usr/bin/env node
/**
 * lint-wiki.mjs — Karpathy LLM Wiki 模式下的健康检查工具
 *
 * 扫描 02_读书笔记 + 11_entities + 12_concepts，输出 15 类问题 + 1 节 Vocab Suggestions 到 _lint-report.md。
 * Vocab Suggestions 从三类 tag-drift 归桶出"词表补全候选"（提示哪些值可入 00_模板/标签词表.md）。
 *
 *   ## source 笔记（02_读书笔记/，6 类）
 *   1.  missing-meta          : frontmatter 缺 tags 或 source
 *   2.  orphan                : 笔记无任何 [[wiki 链接]] 入向引用（且出向 < 3，叶节点阈值放宽）
 *   3.  stale                 : 状态: false 且 创建时间 > 天数阈值
 *   4.  tag-drift             : tags 不在 00_模板/标签词表.md §2 词表枚举内
 *   5.  duplicate             : 同 frontmatter.文章 + 路径不唯一
 *   6.  contradictions        : source 笔记末尾出现 ## Contradictions 段（多轮 ingest 冲突未消解）
 *
 *   ## entity 页（11_entities/，3 类）
 *   7.  entity-missing-aliases : aliases 字段缺失（必填 ≥ 1）
 *   8.  entity-tag-drift       : tags 不在词表 §3 entity 子类枚举
 *   9.  entity-name-clash      : 同目录内 normalize 后同名
 *
 *   ## concept 页（12_concepts/，3 类）
 *  10.  concept-missing-aliases : aliases 字段缺失
 *  11.  concept-tag-drift       : tags 不在词表 §4 concept 子类枚举
 *  12.  concept-name-clash      : 同目录内 normalize 后同名
 *
 *   ## 跨目录 / 共享（3 类）
 *  13.  entity-cross-dir-dup    : entity 与 concept 跨目录 normalize 同名
 *  14.  sources-too-many        : sources.length ≥ 50（entity / concept 共用）
 *  15.  quote-style             : frontmatter 标量字段值未带双引号（myconfig §4 v0.5 约定）
 *
 *   ## 不再检查的（已废止）
 *   - entity-orphan / concept-orphan: sources: 非必填字段（myconfig §4/§5），
 *     新建页必然为空，列入会全员误报——故不计入问题桶
 *
 * 用法：
 *   node scripts/lint-wiki.mjs [--stale-days=90] [--out=scripts/_lint-report.md]
 *
 * 输出：
 *   - 退出码：0 = 无问题；1 = 发现问题
 *   - 默认输出 Markdown 报告
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const VAULT = path.resolve(__dirname, '..');

/* ===================== 纯函数（可测试） ===================== */

/**
 * 从 markdown 文本中解析 frontmatter（YAML 简化版）
 * 仅支持 tags 数组 / 单值字段 / 创建时间 / 状态 / source / 文章
 * v2 增量：补读 aliases / protected / reviewed / type / sources 字段
 * @param {string} text 完整 md 文本
 * @returns {{tags: string[], source: string, status: string|undefined, article: string|undefined, created: string|undefined, aliases: string[], protected: boolean|undefined, reviewed: boolean|undefined, type: string|undefined, sources: string[], raw: string}}
 */
export function parseFrontmatter(text) {
  const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) {
    return {
      tags: [], source: '', status: undefined, article: undefined, created: undefined,
      aliases: [], protected: undefined, reviewed: undefined, type: undefined, sources: [], raw: '',
    };
  }
  const block = fmMatch[1];

  // tags 数组
  const tags = [];
  const tagBlock = block.match(/^tags:\s*\n((?:\s+-\s+.+\n?)+)/m);
  if (tagBlock) {
    for (const m of tagBlock[1].matchAll(/^\s+-\s+(.+)$/gm)) {
      tags.push(m[1].trim().replace(/^["']|["']$/g, ''));
    }
  } else {
    // 单行 tags: [a, b, c]（与 aliases 分支对齐）或 tags: a, b, c
    const single = block.match(/^tags:\s*\[(.+)\]\s*$/m);
    if (single) {
      for (const t of single[1].split(',')) {
        const v = t.trim().replace(/^["']|["']$/g, '');
        if (v) tags.push(v);
      }
    } else {
      const bare = block.match(/^tags:\s*(.+)$/m);
      if (bare) {
        for (const t of bare[1].split(',')) {
          const v = t.trim().replace(/^["']|["']$/g, '');
          if (v) tags.push(v);
        }
      }
    }
  }

  const get = (key) => {
    const re = new RegExp(`^${key}:\\s*(.*)$`, 'm');
    const m = block.match(re);
    if (!m) return undefined;
    return m[1].trim().replace(/^["']|["']$/g, '');
  };

  const getBool = (key) => {
    const v = get(key);
    if (v === 'true') return true;
    if (v === 'false') return false;
    return undefined;
  };

  // status: 接受 bare scalar `状态: true|false`（Obsidian checkbox 期望形态，
  // myconfig §4 v0.5），不引号。旧 list 形态也兼容（历史误迁移，已回滚）。
  const getStatus = () => {
    return get('状态');
  };

  // aliases 数组
  const aliases = [];
  const aliasBlock = block.match(/^aliases:\s*\n((?:\s+-\s+.+\n?)+)/m);
  if (aliasBlock) {
    for (const m of aliasBlock[1].matchAll(/^\s+-\s+(.+)$/gm)) {
      aliases.push(m[1].trim().replace(/^["']|["']$/g, ''));
    }
  } else {
    const single = block.match(/^aliases:\s*\[(.+)\]\s*$/m);
    if (single) {
      for (const t of single[1].split(',')) {
        const v = t.trim().replace(/^["']|["']$/g, '');
        if (v) aliases.push(v);
      }
    }
  }

  // sources 数组
  const sources = [];
  const sourceBlock = block.match(/^sources:\s*\n((?:\s+-\s+.+\n?)+)/m);
  if (sourceBlock) {
    for (const m of sourceBlock[1].matchAll(/^\s+-\s+(.+)$/gm)) {
      sources.push(m[1].trim().replace(/^["']|["']$/g, ''));
    }
  }

  return {
    tags,
    source: get('source') || '',
    status: getStatus(),
    article: get('文章'),
    created: get('创建时间'),
    aliases,
    reviewed: getBool('reviewed'),
    type: get('type'),
    sources,
    raw: block,
  };
}

/**
 * 从 markdown 文本中提取所有 [[wiki 链接]] 目标
 * @param {string} text 完整 md 文本
 * @returns {string[]} 链接目标数组（含 .md 后缀和管道别名）
 */
export function extractWikiLinks(text) {
  const links = new Set();
  for (const m of text.matchAll(/\[\[([^\]\|]+)(?:\|[^\]]*)?\]\]/g)) {
    const target = m[1].trim();
    // 规范化：去掉路径前缀，只保留文件基名用于入向引用匹配
    const base = target.split('/').pop().replace(/\.md$/i, '');
    links.add(base);
  }
  return [...links];
}

/**
 * 检查 frontmatter 完整性
 * @param {object} fm parseFrontmatter 结果
 * @returns {boolean} true 表示有 missing-meta 问题
 */
export function checkMissingMeta(fm) {
  return fm.tags.length === 0 || !fm.source;
}

/**
 * 检查孤立（无入向引用 + 出向 < 3）
 * @param {string[]} outLinks 该笔记的出向 wiki 链接基名
 * @param {Set<string>} allTargets 整个 vault 的 wiki 链接基名集合
 * @param {string} noteBasename 当前笔记基名
 * @returns {boolean} true 表示 orphan
 */
export function checkOrphan(outLinks, allTargets, noteBasename) {
  // 计算入向：allTargets 中是否有人指向自己
  // 注意：调用方需预先准备 BaseName ↔ outLinks 索引
  const hasInbound = noteBasename.length > 0 && allTargets.has(noteBasename);
  const fewOutbound = outLinks.length < 3;
  return !hasInbound && fewOutbound;
}

/**
 * 检查是否过期
 * @param {string} status 状态字段值
 * @param {string} created 创建时间（YYYY-MM-DD 或 YYYY/MM/DD）
 * @param {number} staleDays 阈值天数
 * @param {Date} now 当前时间
 * @returns {boolean}
 */
export function checkStale(status, created, staleDays, now = new Date()) {
  if (status !== 'false') return false; // 只检查 状态: false
  if (!created) return false;
  const m = created.match(/(\d{4})[\-\/](\d{1,2})[\-\/](\d{1,2})/);
  if (!m) return false;
  const c = new Date(+m[1], +m[2] - 1, +m[3]);
  if (Number.isNaN(c.getTime())) return false;
  const diffDays = (now - c) / (1000 * 60 * 60 * 24);
  return diffDays > staleDays;
}

/**
 * 检查 tag 是否在合法枚举内
 * @param {string[]} tags
 * @param {Set<string>} validTags 词表 §2 所有合法值（含 axis/ 前缀）
 * @returns {string[]} 漂移的 tag 列表
 */
export function checkTagDrift(tags, validTags) {
  return tags.filter(t => !validTags.has(t));
}

/**
 * 检查 source 笔记正文是否含 ## Contradictions 段（多轮 ingest 冲突未消解）
 * @param {string} _frontmatterRaw 解析后的 frontmatter 块（保留以备未来用）
 * @param {string} body 笔记正文（去掉 frontmatter 部分）
 * @returns {boolean} true 表示存在 Contradictions 段
 */
export function checkContradictions(_frontmatterRaw, body) {
  if (!body) return false;
  // 匹配行首 `## Contradictions`（标题级别，前后无嵌套 ## 子标题）
  return /^##\s+Contradictions\s*$/m.test(body);
}

// 前置声明：frontmatter 标量字段（myconfig §4 v0.5）
// 值必须带双引号。数组 / wiki-link / 已带引号的跳过。
// 注：`状态:` 是 checkbox 类型（bare boolean），不在此列。
const QUOTE_SCALAR_KEYS = ['type', 'reviewed', 'created', '创建时间', 'protected', '文章', '作者', 'source']
const QUOTE_KEY_ALT = QUOTE_SCALAR_KEYS.map(k => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
// 不跨行（用 `[ \t]+` 而非 `\s+`，避免吞掉下一行）
const QUOTE_LINE_RE = new RegExp(`^(${QUOTE_KEY_ALT}):[ \\t]+([^\\s\\n].*)$`, 'gm')

/**
 * 检查 frontmatter 标量字段值是否带双引号（myconfig §4 v0.5 约定）
 * @param {string} fmRaw frontmatter 块原文（不含 --- 包裹符）
 * @returns {string[]} 未带引号的字段名列表（key）
 */
export function checkQuoteStyle(fmRaw) {
  if (!fmRaw) return [];
  const violations = []
  for (const m of fmRaw.matchAll(QUOTE_LINE_RE)) {
    const key = m[1]
    const value = m[2].trim()
    // 已带双引号或单引号 → 合规
    if (value.startsWith('"') && value.endsWith('"')) continue
    if (value.startsWith("'") && value.endsWith("'")) continue
    // 含嵌套引号 / 转义 → 保守跳过（与迁移脚本策略一致）
    if (value.includes('"') || value.includes("'")) continue
    // 数组 / 对象 → 跳过
    if (value.startsWith('{')) continue
    // wiki-link 单值 [[...]]：source 字段必须加引号（Obsidian 报 unknown 类型）
    if (/^\[\[[^\n]*\]\]$/.test(value)) {
      if (key === 'source') violations.push(key)
      continue
    }
    // 其他以 [ 开头的是数组 → 跳过
    if (value.startsWith('[')) continue
    violations.push(key)
  }
  return violations
}

/**
 * 检查重复（基于 文章 字段）
 * @param {Array<{path: string, article: string|undefined}>} notes
 * @returns {Array<Array<string>>} 重复组（每组 ≥2 个路径，文章相同）
 */
export function findDuplicates(notes) {
  const byArticle = new Map();
  for (const n of notes) {
    if (!n.article) continue;
    if (!byArticle.has(n.article)) byArticle.set(n.article, []);
    byArticle.get(n.article).push(n.path);
  }
  const dups = [];
  for (const [, paths] of byArticle) {
    if (paths.length >= 2) dups.push(paths);
  }
  return dups;
}

/**
 * 从词表文件内容中提取合法 tag 集合。
 *
 * 词表实际格式（用户期望）：
 *   ### domain — 主题域（16 个）
 *
 *   | 值 | 含义 | 适用场景 |
 *   |---|---|---|
 *   | `ai` | 人工智能方法论/算法/应用 | ... |
 *
 * 解析规则（ponytail: 单次扫描 + axis 上下文）：
 * - `### <axis>` 三级标题里的第一个英文小写单词作为 axis（domain/layer/phase/maturity）
 * - 之后表格行 `| `<value>` | ...` 的 value 全部映射为 `<axis>/<value>`
 * - 遇下一个 `###` / `##` 切换上下文
 * - §3 Entity / §4 Concept 子标题下，没有 axis 前缀概念，值就是 entity/concept 自身
 *
 * @param {string} tagListText 00_模板/标签词表.md 全文
 * @returns {Set<string>} 合法值集合（4 轴含 axis 前缀如 "domain/ai"；entity/concept 裸值如 "person"）
 */
export function parseTagList(tagListText) {
  const set = new Set();
  // 4 轴 axis 标题匹配：`### domain` / `### layer` / `### phase` / `### maturity`
  const AXIS_HEADING_RE = /^###\s+(domain|layer|phase|maturity)\b/m;
  // §3/§4 二级标题：决定是否切到 entity/concept 模式
  const SECTION_RE = /^##\s+(3|4)\.\s+(Entity|Concept)\s+子类枚举/m;
  // 表格行：| `<value>` | ...
  const ROW_RE = /^\|\s+`([a-z0-9-]+)`\s*\|/gm;

  let inEntitySection = false;
  let inConceptSection = false;
  let currentAxis = null;
  // 按行扫描以便追踪标题位置
  const lines = tagListText.split(/\r?\n/);
  for (const line of lines) {
    const sectionM = line.match(SECTION_RE);
    if (sectionM) {
      // 切到 entity/concept 模式（无 axis 前缀）
      inEntitySection = sectionM[2] === 'Entity';
      inConceptSection = sectionM[2] === 'Concept';
      currentAxis = null;
      continue;
    }
    // 4 轴 ### 标题
    const axisM = line.match(AXIS_HEADING_RE);
    if (axisM) {
      currentAxis = axisM[1];
      inEntitySection = false;
      inConceptSection = false;
      continue;
    }
    // 其他 ## / ### 标题：清空 axis
    if (/^#{2,3}\s+/.test(line)) {
      currentAxis = null;
      inEntitySection = false;
      inConceptSection = false;
      continue;
    }
    // 表格行
    const rowM = line.match(/^\|\s+`([a-z0-9-]+)`\s*\|/);
    if (!rowM) continue;
    const value = rowM[1];
    if (currentAxis) {
      set.add(`${currentAxis}/${value}`);
    } else if (inEntitySection || inConceptSection) {
      set.add(value); // entity/concept 裸值
    }
    // 其他位置的反引号值（如开头设计原则里的示例）忽略
  }
  return set;
}

/* ===================== v2 增量：entity / concept 维度 ===================== */

/**
 * 规范化 slug 用于跨名/跨拼写 dedup。
 * ponytail: 全小写 + 去空格/连字符/下划线 + 去重。
 * 例："Baidu-Apollo" → "baiduapollo"; "Waymo" → "waymo"。
 * @param {string} s
 * @returns {string}
 */
export function normalize(s) {
  if (!s) return '';
  return String(s).toLowerCase().replace(/[\s\-_]/g, '');
}

/**
 * 检查 entity / concept 页 aliases 字段是否缺失（v2 必填 ≥1）
 * @param {{aliases: string[]}} fm
 * @returns {boolean}
 */
export function checkMissingAlias(fm) {
  return !fm.aliases || fm.aliases.length === 0;
}

/**
 * 在单目录内找 normalize 后重复的 slug（同 entity 或同 concept 内冲突）
 * @param {string[]} files 文件绝对路径列表
 * @returns {Array<{norm: string, paths: string[]}>} 重复组（≥2 个文件）
 */
export function findEntityDuplicates(files) {
  const byNorm = new Map();
  for (const f of files) {
    const basename = path.basename(f, '.md');
    const n = normalize(basename);
    if (!byNorm.has(n)) byNorm.set(n, []);
    byNorm.get(n).push(f);
  }
  const out = [];
  for (const [n, paths] of byNorm) {
    if (paths.length >= 2) out.push({ norm: n, paths });
  }
  return out;
}

/**
 * 跨 entity / concept 目录找 normalize 后同名（语义冲突）。
 * @param {string[]} entityFiles
 * @param {string[]} conceptFiles
 * @returns {Array<{norm: string, entityPath: string, conceptPath: string}>}
 */
export function findCrossDirDuplicates(entityFiles, conceptFiles) {
  const entityMap = new Map();
  for (const f of entityFiles) {
    entityMap.set(normalize(path.basename(f, '.md')), f);
  }
  const out = [];
  for (const cf of conceptFiles) {
    const n = normalize(path.basename(cf, '.md'));
    if (entityMap.has(n)) {
      out.push({ norm: n, entityPath: entityMap.get(n), conceptPath: cf });
    }
  }
  return out;
}

/**
 * entity 子类合法 tag 集合（来自词表 §3，7 个枚举）。
 * 供 entity tag-drift 校验。
 * @returns {Set<string>}
 */
export function entityTagVocabulary() {
  return new Set([
    'person', 'organization', 'project', 'product', 'event', 'place', 'other',
  ]);
}

/**
 * concept 子类合法 tag 集合（来自词表 §4，7 个枚举）。
 * 供 concept tag-drift 校验。
 * @returns {Set<string>}
 */
export function conceptTagVocabulary() {
  return new Set([
    'theory', 'method', 'field', 'phenomenon', 'standard', 'term', 'other',
  ]);
}

/**
 * 从 tag-drift / entity-tag-drift / concept-tag-drift 三类问题归桶出"词表补全建议"。
 * ponytail: 纯函数 + 启发式归桶；不上 LLM，剩下归不进的标 `(unclassified)` 让用户人工。
 *
 * 归桶规则：
 * 1. 含 axis 前缀 `domain|x|layer|x|phase|x|maturity|x` → 落到对应 axis
 * 2. 不含 axis 前缀 + 来自 entity-tag-drift → entity 子类
 * 3. 不含 axis 前缀 + 来自 concept-tag-drift → concept 子类
 * 4. 不含 axis 前缀 + 来自 source 笔记 tag-drift → `unclassified`（用户漏写 axis）
 *
 * @param {object} problems runLint 的 problems 对象
 * @returns {Array<{bucket: string, value: string, count: number, sources: string[]}>}
 *   bucket: 'domain'|'layer'|'phase'|'maturity'|'entity'|'concept'|'unclassified'
 *   sources: 去重后的来源文件路径，最多保留 5 个
 */
export function buildVocabSuggestions(problems) {
  const AXES = ['domain', 'layer', 'phase', 'maturity'];
  const key = (bucket, value) => `${bucket}::${value}`;
  const agg = new Map(); // key → {bucket, value, count, sources:Set}

  const bump = (bucket, value, sourcePath) => {
    const k = key(bucket, value);
    if (!agg.has(k)) agg.set(k, { bucket, value, count: 0, sources: new Set() });
    const e = agg.get(k);
    e.count++;
    e.sources.add(sourcePath);
  };

  // source 笔记 tag-drift：按 axis 前缀归桶
  for (const p of problems['tag-drift'] || []) {
    for (const t of p.drifted) {
      const m = t.match(/^(domain|layer|phase|maturity)\//);
      if (m) bump(m[1], t, p.path);
      else bump('unclassified', t, p.path);
    }
  }
  // entity tag-drift：全部进 entity 子类
  for (const p of problems['entity-tag-drift'] || []) {
    for (const t of p.drifted) bump('entity', t, p.path);
  }
  // concept tag-drift：全部进 concept 子类
  for (const p of problems['concept-tag-drift'] || []) {
    for (const t of p.drifted) bump('concept', t, p.path);
  }

  // 转为数组 + sources 截断到 5 + 按 (bucket 优先级, value) 排序
  const bucketOrder = ['domain', 'layer', 'phase', 'maturity', 'entity', 'concept', 'unclassified'];
  const out = [...agg.values()].map(e => ({
    bucket: e.bucket,
    value: e.value,
    count: e.count,
    sources: [...e.sources].slice(0, 5),
  }));
  out.sort((a, b) => {
    const ba = bucketOrder.indexOf(a.bucket);
    const bb = bucketOrder.indexOf(b.bucket);
    if (ba !== bb) return ba - bb;
    return a.value.localeCompare(b.value);
  });
  return out;
}

/* ===================== 集合层（vault 扫描） ===================== */

async function walk(dir, out = []) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith('.') || e.name === 'node_modules') continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, out);
    else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) out.push(full);
  }
  return out;
}

/**
 * walk 的安全版：目录不存在时返回空数组（用于合成测试 vault / 新仓库）。
 */
export async function walkSafe(dir) {
  try {
    return await walk(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

/**
 * 加载整个 vault，返回每篇笔记的元数据
 * @param {string} vaultRoot
 * @returns {Promise<{notes: Array<{path, basename, fm, links, outLinks, body}>, allLinkTargets: Set<string>, bodyMap: Map<string, string>}>}
 */
export async function loadVault(vaultRoot) {
  const NOTES = path.join(vaultRoot, '02_读书笔记');
  const files = await walk(NOTES);
  const notes = [];
  const allLinkTargets = new Set();
  const bodyMap = new Map();

  for (const f of files) {
    const text = await fs.readFile(f, 'utf8');
    const fm = parseFrontmatter(text);
    const links = extractWikiLinks(text);
    const relPath = path.relative(vaultRoot, f).replace(/\\/g, '/');
    for (const l of links) allLinkTargets.add(l);
    // body = 去掉 frontmatter 后的正文，供 contradictions 检查
    const bodyStart = text.indexOf('---', text.indexOf('---') !== -1 ? text.indexOf('---') + 3 : 0);
    const body = bodyStart !== -1 ? text.slice(bodyStart + 3) : text;
    bodyMap.set(relPath, body);
    notes.push({
      path: relPath,
      basename: path.basename(f, '.md'),
      fm,
      links,
      outLinks: links,
      body,
    });
  }

  // 第二遍：补全入向引用
  for (const n of notes) {
    n.hasInbound = allLinkTargets.has(n.basename);
  }

  return { notes, allLinkTargets, bodyMap };
}

/**
 * 运行所有检查，输出报告（Markdown）
 * @param {object} opts
 * @param {string} opts.vaultRoot
 * @param {number} [opts.staleDays=90]
 * @returns {Promise<{report: string, problems: object, exitCode: number}>}
 */
export async function runLint(opts) {
  const { vaultRoot, staleDays = 90 } = opts;

  // 加载词表
  const tagListPath = path.join(vaultRoot, '00_模板', '标签词表.md');
  let validTags = new Set();
  try {
    const tagListText = await fs.readFile(tagListPath, 'utf8');
    validTags = parseTagList(tagListText);
  } catch {
    // 词表不存在：跳过 tag-drift 检查
  }

  // 加载 vault
  const { notes, bodyMap } = await loadVault(vaultRoot);

  // v2 增量：加载 entity / concept 目录（不存在则跳过——合成测试 vault 可能没建）
  // README.md 不是 entity/concept 页，跳过
  const isRealPage = (f) => path.basename(f, '.md').toUpperCase() !== 'README';
  const entityDir = path.join(vaultRoot, '11_entities');
  const conceptDir = path.join(vaultRoot, '12_concepts');
  const entityFiles = (await walkSafe(entityDir)).filter(isRealPage);
  const conceptFiles = (await walkSafe(conceptDir)).filter(isRealPage);
  const entityFms = [];
  for (const f of entityFiles) {
    const text = await fs.readFile(f, 'utf8');
    const fm = parseFrontmatter(text);
    entityFms.push({ path: path.relative(vaultRoot, f).replace(/\\/g, '/'), fm });
  }
  const conceptFms = [];
  for (const f of conceptFiles) {
    const text = await fs.readFile(f, 'utf8');
    const fm = parseFrontmatter(text);
    conceptFms.push({ path: path.relative(vaultRoot, f).replace(/\\/g, '/'), fm });
  }

  // 5 + 8 类检查（source 6 类 + entity 5 类 + concept 5 类 + 跨目录 1 类，详见脚本头注释）
  const problems = {
    // source 笔记
    'missing-meta': [],
    'orphan': [],
    'stale': [],
    'tag-drift': [],
    'duplicate': [],
    'contradictions': [],
    // entity
    'entity-missing-aliases': [],
    'entity-tag-drift': [],
    'entity-name-clash': [],
    // concept
    'concept-missing-aliases': [],
    'concept-tag-drift': [],
    'concept-name-clash': [],
    // 跨目录
    'entity-cross-dir-dup': [],
    // 共享告警
    'sources-too-many': [],
    // 引号风格（myconfig §4 v0.5）
    'quote-style': [],
  };

  const now = new Date();

  for (const n of notes) {
    if (checkMissingMeta(n.fm)) {
      problems['missing-meta'].push(n.path);
    }
    if (!n.hasInbound && n.outLinks.length < 3) {
      // 真正 orphan：无入向且出向 < 3（叶节点阈值放宽到 3，避免误报）
      problems['orphan'].push(n.path);
    }
    if (checkStale(n.fm.status, n.fm.created, staleDays, now)) {
      problems['stale'].push({ path: n.path, created: n.fm.created });
    }
    const drifted = checkTagDrift(n.fm.tags, validTags);
    if (drifted.length > 0) {
      problems['tag-drift'].push({ path: n.path, drifted });
    }
    // contradictions：source 笔记末尾出现 ## Contradictions 段（多轮 ingest 冲突未消解）
    if (checkContradictions(n.fm.raw, bodyMap.get(n.path) || '')) {
      problems['contradictions'].push(n.path);
    }
    // quote-style：标量字段值未带双引号（myconfig §4 v0.5）
    const quoteViolations = checkQuoteStyle(n.fm.raw);
    if (quoteViolations.length > 0) {
      problems['quote-style'].push({ path: n.path, keys: quoteViolations });
    }
  }

  // v2 entity 维度
  for (const { path: p, fm } of entityFms) {
    if (checkMissingAlias(fm)) problems['entity-missing-aliases'].push(p);
    if (fm.sources && fm.sources.length >= 50) problems['sources-too-many'].push({ path: p, count: fm.sources.length, kind: 'entity' });
    // entity tag 必须在 7 子类枚举（词表 §3）
    const entityValid = entityTagVocabulary();
    const drifted = (fm.tags || []).filter(t => !entityValid.has(t));
    if (drifted.length > 0) {
      problems['entity-tag-drift'].push({ path: p, drifted });
    }
  }
  for (const { path: p, fm } of conceptFms) {
    if (checkMissingAlias(fm)) problems['concept-missing-aliases'].push(p);
    if (fm.sources && fm.sources.length >= 50) problems['sources-too-many'].push({ path: p, count: fm.sources.length, kind: 'concept' });
    // concept tag 必须在 7 子类枚举（词表 §4）
    const conceptValid = conceptTagVocabulary();
    const drifted = (fm.tags || []).filter(t => !conceptValid.has(t));
    if (drifted.length > 0) {
      problems['concept-tag-drift'].push({ path: p, drifted });
    }
  }

  // v2 dup 检查
  const entityDups = findEntityDuplicates(entityFiles);
  for (const { norm, paths } of entityDups) {
    problems['entity-name-clash'].push({
      norm,
      paths: paths.map(p => path.relative(vaultRoot, p).replace(/\\/g, '/')),
    });
  }
  const conceptDups = findEntityDuplicates(conceptFiles);
  for (const { norm, paths } of conceptDups) {
    problems['concept-name-clash'].push({
      norm,
      paths: paths.map(p => path.relative(vaultRoot, p).replace(/\\/g, '/')),
    });
  }
  const crossDups = findCrossDirDuplicates(entityFiles, conceptFiles);
  for (const { norm, entityPath, conceptPath } of crossDups) {
    problems['entity-cross-dir-dup'].push({
      norm,
      entityPath: path.relative(vaultRoot, entityPath).replace(/\\/g, '/'),
      conceptPath: path.relative(vaultRoot, conceptPath).replace(/\\/g, '/'),
    });
  }

  const dups = findDuplicates(notes.map(n => ({ path: n.path, article: n.fm.article })));
  problems['duplicate'] = dups;

  // 生成 Markdown 报告
  const total = notes.length;
  const counts = Object.fromEntries(Object.entries(problems).map(([k, v]) => [k, v.length]));
  const totalProblems = Object.values(counts).reduce((a, b) => a + b, 0);

  let report = `# lint-wiki 报告\n\n`;
  report += `> vault: \`${vaultRoot}\`\n`;
  report += `> 扫描笔记数：${total}\n`;
  report += `> 时间：${now.toISOString().slice(0, 10)}\n`;
  report += `> stale 阈值：${staleDays} 天\n\n`;

  report += `## 汇总\n\n`;
  report += `| 类型 | 数量 |\n|---|---|\n`;
  for (const [k, c] of Object.entries(counts)) {
    report += `| ${k} | ${c} |\n`;
  }
  report += `| **合计** | **${totalProblems}** |\n\n`;

  // —— 词表补全建议：从三类 tag-drift 归桶，提示哪些候选可补到 00_模板/标签词表.md ——
  // ponytail: 纯 grep 归桶，无 LLM；仅报告，不入词表
  const vocabSuggestions = buildVocabSuggestions(problems);
  if (vocabSuggestions.length > 0) {
    report += `## Vocab Suggestions (${vocabSuggestions.length})\n\n`;
    report += `> 来自 \`tag-drift\` / \`entity-tag-drift\` / \`concept-tag-drift\` 的候选归桶。`;
    report += `**仅报告，不入词表**——用户手动改 \`00_模板/标签词表.md\` 决定是否补枚举。\n\n`;
    report += `| 桶 | 候选值 | 出现次数 | 来源（最多 5） |\n|---|---|---|---|\n`;
    const bucketLabel = { domain: '§2 domain', layer: '§2 layer', phase: '§2 phase', maturity: '§2 maturity', entity: '§3 entity', concept: '§4 concept', unclassified: '待分类' };
    for (const s of vocabSuggestions) {
      report += `| ${bucketLabel[s.bucket] || s.bucket} | \`${s.value}\` | ${s.count} | ${s.sources.map(p => '`' + p + '`').join(', ')} |\n`;
    }
    report += `\n`;
  }

  if (totalProblems === 0) {
    report += `✅ **无问题**\n`;
  } else {
    for (const [type, list] of Object.entries(problems)) {
      if (list.length === 0) continue;
      report += `## ${type} (${list.length})\n\n`;
      if (type === 'missing-meta') {
        for (const p of list) report += `- ${p}\n`;
      } else if (type === 'orphan') {
        for (const p of list) report += `- ${p}\n`;
      } else if (type === 'stale') {
        for (const p of list) report += `- ${p.path}（创建 ${p.created}）\n`;
      } else if (type === 'tag-drift') {
        for (const p of list) report += `- ${p.path} → 漂移 tag：${p.drifted.map(t => '`' + t + '`').join(', ')}\n`;
      } else if (type === 'duplicate') {
        for (const group of list) {
          report += `- 重复组：${group.join(' | ')}\n`;
        }
      } else if (type === 'entity-missing-aliases' || type === 'concept-missing-aliases') {
        for (const p of list) report += `- ${p}\n`;
      } else if (type === 'entity-name-clash' || type === 'concept-name-clash') {
        for (const p of list) report += `- normalize \`${p.norm}\` → ${p.paths.join(' | ')}\n`;
      } else if (type === 'entity-tag-drift' || type === 'concept-tag-drift') {
        for (const p of list) report += `- ${p.path} → 漂移 tag：${p.drifted.map(t => '`' + t + '`').join(', ')}\n`;
      } else if (type === 'contradictions') {
        for (const p of list) report += `- ${p}（含 ## Contradictions 段）\n`;
      } else if (type === 'entity-cross-dir-dup') {
        for (const p of list) report += `- normalize \`${p.norm}\` → ${p.entityPath} ↔ ${p.conceptPath}\n`;
      } else if (type === 'sources-too-many') {
        for (const p of list) report += `- ${p.path}(${p.kind}) → sources.length = ${p.count}\n`;
      } else if (type === 'quote-style') {
        for (const p of list) report += `- ${p.path} → 未加引号: ${p.keys.map(k => '`' + k + '`').join(', ')}\n`;
      }
      report += `\n`;
    }
  }

  const exitCode = totalProblems === 0 ? 0 : 1;
  return { report, problems, exitCode };
}

/* ===================== CLI 入口 ===================== */

function parseCliArgs(argv) {
  const args = { staleDays: 90, out: null };
  for (const a of argv.slice(2)) {
    const m = a.match(/^--(\w+)(?:=(.+))?$/);
    if (!m) continue;
    const key = m[1];
    const val = m[2];
    if (key === 'stale-days') args.staleDays = +val;
    else if (key === 'out') args.out = val;
  }
  return args;
}

async function main() {
  const args = parseCliArgs(process.argv);
  const { report, exitCode } = await runLint({ vaultRoot: VAULT, staleDays: args.staleDays });
  if (args.out) {
    await fs.writeFile(path.resolve(args.out), report);
    console.error(`报告写入 ${args.out}`);
  } else {
    process.stdout.write(report);
  }
  process.exit(exitCode);
}

// 仅当作为 CLI 调用时执行 main（被 import 时不触发）
const invokedPath = process.argv[1] && path.resolve(process.argv[1]);
if (invokedPath === __filename) {
  main().catch(e => { console.error(e); process.exit(2); });
}