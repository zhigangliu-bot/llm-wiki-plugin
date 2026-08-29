# Query Skill 设计（v3：自动路径选择）

- 日期：2026-08-29（v3）
- 作者：zhigangliu
- 状态：v3 自动路径选择（SessionStart hook 探测 + state.json override）
- 适用 skill：`llm-wiki-query`
- 关联资产：`scripts/qmd-detect.mjs`（新建）+ `scripts/qmd-detect.test.mjs`（新建）+ `hooks/hooks.json`（新增 matcher）+ `skills/llm-wiki-query/SKILL.md`（阶段 B0 改）

## 增量：v3（2026-08-29）

v3 把 v2 时代「LLM 自主 grep / 自动切 qmd」的弱可预测性，提升为「**脚本决定路径、LLM 按指令执行**」。三件套：

1. **`scripts/qmd-detect.mjs`** —— SessionStart 时跑，输出当前 vault 的 `tier` + `effective_path`，缓存到 vault 根 `.llm-wiki-cache.json`
2. **`hooks/hooks.json`** —— 新增 `SessionStart` matcher（**额外加**，不替换现有的 `check-update` matcher），调 `qmd-detect.mjs`，结果注入 LLM system context
3. **`vault/.llm-wiki-query-state.json`** —— vault 用户手动 override（可选）：

   ```json
   {
     "path_override": "grep",  // "grep" | "qmd" | "auto"
     "引导_skipped_at": "2026-08-29T10:00:00Z"  // ISO 8601, 主对话引导过且 vault 用户跳过后写入
   }
   ```

**v3 替换 v2「LLM 自检 vault 大小 + 自动判断」的方案**——后者行为依赖 LLM 自检、不可文档化、测试不可写。v3 让路径选择由 Node 脚本计算、LLM 只读 system context 知道当前 `effective_path` 然后调对应工具。

## §1 阈值与分档

vault 大小 = 递归数 vault 根下所有 `.md` 文件（不含 `.obsidian/` / `node_modules/` / `.git/` / `temp/` / `00_模板/`）：

| tier | vault_size | 强制行为 |
|---|---|---|
| `small` | `< 500` | `effective_path = "grep"` 强制，不看 qmd 是否装，不出引导提示 |
| `medium` | `500 ≤ v < 3000` | `effective_path = qmd_available ? "qmd" : "grep"`；qmd 未装且 `state.引导_skipped_at` 缺省（缺字段 / null / 空字符串）时，主对话**出装说明一次**（一次性） |
| `large` | `>= 3000` | `effective_path = qmd_available ? "qmd" : "grep"`；qmd 未装**每次询问前**出强提示（`vault >= 3000 朴素 grep 召回不稳，建议装 qmd`），直到 vault 用户装上或 state.json 写 `path_override: "grep"` |

`vault_size` 阈值（500 / 3000）写死在 `scripts/qmd-detect.mjs` 顶部 `THRESHOLDS = { small: 500, large: 3000 }`，改时单文件改。

**v3 vs v2 阈值差异：** v2 用单阈值 `>= 1000` 作为硬分界；v3 改用**两阈值三档**（`500` / `3000`），无中间硬阈值——`medium` 不强行切，靠「首次引导」让 vault 用户自己决定。降低阈值数量、易测试。

## §2 state.json override 语义

`vault/.llm-wiki-query-state.json` 是 vault 用户可读写的可选配置文件：

| 字段 | 取值 | 含义 |
|---|---|---|
| `path_override` | `"grep"` / `"qmd"` / `"auto"` / 缺省 | 强制锁定路径 / 强制锁定路径 / 用默认决策（v3 默认 = auto） |
| `引导_skipped_at` | ISO 8601 string / 缺省 | medium tier 下 QMD 未装时，引导已跳过的时间戳 |

**计算 `effective_path` 的优先级**（按从上到下短路）：

1. `state.path_override === "grep"` → `"grep"`（vault 用户永远拒绝 qmd；large tier 下用于一次性解封强提示）
2. `state.path_override === "qmd"` → `"qmd"`（vault 用户强制 qmd；**qmd 未装时 effective_path 仍取 `qmd`，但 LLM 主对话遇 `mcp__qmd__query` tool-not-found 时强提示**——与 §1 `large` tier 行为一致：是「每询问前」强提示，不是「一次性」）
3. 否则按 tier + qmd_available 决策：
   - small → `grep`
   - medium → qmd_available ? `qmd` : `grep`
   - large → qmd_available ? `qmd` : `grep`

**字段非法 / 缺字段 / 错类型**：脚本容忍，`path_override` 非法值忽略按 `auto` 处理，`引导_skipped_at` 非法值忽略按缺省处理，warning 打到 stderr（不进 LLM 上下文，hook 不阻塞）。

## §3 组件

### §3.1 `scripts/qmd-detect.mjs`

**职责：** SessionStart 时跑一次，输出 `/path/to/vault/.llm-wiki-cache.json` + stdout JSON 给 hook 注入 LLM。

**输入：** `--vault=<vaultRoot>`（必填，hook 从 `process.cwd()` 或环境变量解析）。

**输出：**

```js
{
  tier: 'small' | 'medium' | 'large',
  effective_path: 'grep' | 'qmd',
  qmd_available: boolean,
  vault_size: number,           // 实际数到的 .md 数
  cache_age_seconds: number,    // 距上次 cache 写入的秒数; 0 表示本次重数
  vault_mtime_iso: string,      // 当前 vault mtime (ISO 8601)
  state_override: 'grep' | 'qmd' | 'auto' | null,  // state.json 是否 override; null = state.json 不存在
  should_suggest_qmd_install: boolean,             // medium tier + qmd 未装 + 未引导过 = true
  should_warn_grep_unstable: boolean,              // large tier + qmd 未装 + state.path_override !== "grep" = true
}
```

**Cache 行为：**

- 读 `vault/.llm-wiki-cache.json`（不存在则空对象）
- 数 vault：递归 `find . -name "*.md" -type f`，过滤 `00_模板/` `.obsidian/` `node_modules/` `.git/` `temp/`
- 数前后比 vault mtime（`stat -c %Y` / `fs.statSync().mtimeMs`）：
  - mtime 变化 → 重新数 vault_size，覆盖 cache
  - mtime 未变 → 用 cache 的 vault_size
- 探 qmd：`qmd collection list` 进程跑，5 秒 timeout，exit 0 = available
- 读 `vault/.llm-wiki-query-state.json`：字段容忍策略见 §2
- 算 tier + effective_path + should_suggest_qmd_install + should_warn_grep_unstable
- 写回 cache：vault_mtime_iso + vault_size + qmd_available + last_run_iso + effective_path + tier
- stdout 输出 JSON 给 hook

**退出：** 永远 exit 0。失败 → warning 到 stderr，stdout 输出 `tier: 'small', effective_path: 'grep'` 安全降级（hook 不阻塞 session start）。

**DI 注入：** Node 22 内置模块 namespace 冻结时绕开用 DI 参数（参考 `scripts/check-update.mjs` 的 `execFn` 模式）。

### §3.2 `hooks/hooks.json`

新增第二个 SessionStart matcher，**不替换**现有的 `check-update` matcher：

```json
{
  "matchers": [
    {
      "event": "SessionStart",
      "name": "qmd-detect",
      "async": true,
      "command": "node scripts/qmd-detect.mjs --vault=\"$CLAUDE_PROJECT_DIR\" 2>/dev/null"
    },
    { "existing check-update matcher...": "..." }
  ]
}
```

**`async: true`** —— 永不阻塞 session start，与 check-update 行为一致。

**`2>/dev/null`** —— hook 输出里的 warning 不污染 LLM 上下文（warning 写到日志文件或 plugin `temp/`）。

### §3.3 hook 输出注入 LLM 上下文

Claude Code 的 `SessionStart` hook stdout 会被注入到 LLM context（与 plugin check-update 现行行为一致）。`qmd-detect.mjs` stdout 输出格式：

```
<system-context>
llm-wiki-query path selection:
  tier: medium (vault_size: 1200 .md files)
  effective_path: grep
  qmd_available: false
  state_override: null
  should_suggest_qmd_install: true  (only medium tier + qmd not installed + never prompted)
</system-context>
```

LLM 看到这段就知道：当前 `effective_path = grep`（medium tier + qmd 未装），且 `should_suggest_qmd_install: true` 是真 → 触发「首次引导」动作（出装说明一次 + 把 `引导_skipped_at` 写入 state.json）。

## §4 数据流（一次会话）

```
SessionStart event
  │
  ▼
hooks/hooks.json matchers (并行)
  ├─ matcher #1 (已有): check-update.mjs → 输出 plugin 更新提示
  └─ matcher #2 (新增): qmd-detect.mjs →
       │
       ├─ 读 vault/.llm-wiki-cache.json (有则用, 无则空)
       ├─ 读 vault/.llm-wiki-query-state.json (有则用, 无则空)
       ├─ 数 vault (mtime 变化则重数, 否则用 cache)
       ├─ 探 qmd (qmd collection list, 5s timeout)
       ├─ 算 tier / effective_path / suggestion flags
       ├─ 写回 .llm-wiki-cache.json
       └─ stdout 输出 <system-context>...</system-context>
  │
  ▼
LLM 上下文注入 (check-update + qmd-detect 各自一段)
  │
  ▼
用户输入: "在知识库查一下 X"
  │
  ▼
SKILL.md 阶段 A 触发判定命中
  │
  ▼
SKILL.md 阶段 B (新 B0):
  B0.0: 读 system context, 记 effective_path
  B0.1: effective_path = grep → 走 v2 老路径 (B1 多 anchor grep + B2 Read)
       effective_path = qmd →
         B1': mcp__qmd__query(vec=<query>, limit=10)
         B2': 对 hits (score ≥ 0.6) 调 Read frontmatter+重点段 (与 grep 同样粒度)
         B3': (qmd 失败 / tool not found) → 降级 B1 多 anchor grep, warning 提示
  │
  ▼
阶段 C 答案输出 + Q1-Q5 自检 + 建议归档
  │
  ▼
阶段 D 用户确认归档 → 写 vault + Log
  │
  ▼
should_suggest_qmd_install 为真:
  ├─ medium tier + 首次 (state.引导_skipped_at 为空) → 主对话出装说明一次
  │   └─ vault 用户回「跳过」→ 写 state.引导_skipped_at 当前 ISO 8601, 后续不再引导
  └─ large tier + qmd 未装 → 每次询问前都强提示 (不提就不用)
```

## §5 错误处理

| 失败 | 行为 |
|---|---|
| `qmd-detect.mjs` 跑挂 (uncaught throw) | hook 仍然 exit 0 (catch all in main)，warning 打 stderr |
| vault 路径不存在 / 无 .md 文件 | `tier='small'`、`effective_path='grep'`、`vault_size=0`、正常降级 |
| `.llm-wiki-cache.json` 写失败 (权限) | warning，继续（下次 hook 重试） |
| `qmd collection list` 超时 (5s) | `qmd_available=false`，warning |
| state.json 字段非法 | 忽略该字段 + warning，不阻塞 |
| `path_override` 值不在枚举 | 忽略 `path_override` 字段（按 `auto` 处理），warning |
| mtime 比对失败 (文件系统异常) | 强制重数 vault（不用 cache） |
| LLM 收到的 system context 字段缺失 | 兼容模式：`effective_path` 缺省按 `'grep'` 处理，其他字段 `false` |

**所有失败都用「降级到 grep」兜底** —— 朴素 grep 是 default safe path，qmd 是 enhancement。

## §6 测试

`scripts/qmd-detect.test.mjs` 覆盖：

1. **tier 分档** —— mock vault_size = 100 / 1500 / 3500 → tier = small / medium / large
2. **state.json override priority** —— `path_override: "grep"` 强制覆盖 effective_path，不看 tier
3. **state.json `path_override: "qmd"`** 但 qmd 未装 → effective_path 仍取 `qmd`，但 should_warn 触发（提示 vault 用户 qmd 不可用）
4. **cache mtime 触发** —— mock 写入 cache 时 mtime=A，stat 当前 vault mtime=B ≠ A → 重数
5. **cache mtime 不变** —— mtime 相同 → 用 cache vault_size，不重数
6. **qmd_available = false fallback** —— mock `qmd collection list` exit 1 → medium tier → effective_path='grep'
7. **`should_suggest_qmd_install` 触发条件** —— medium + qmd 未装 + state.引导_skipped_at 缺省 = true；state 写入 ISO 后 = false
8. **`should_warn_grep_unstable` 触发条件** —— `large` + `qmd_available = false` + `state.path_override != "grep"` = true（vault 用户写 `path_override: "grep"` 后此 flag = false）
9. **state.json 非法字段容错** —— 缺字段 / 错类型 / 错枚举值 → 不抛，正常容忍
10. **process exit 0** —— 所有失败场景 main() 都 catch → exit 0，stdout 输出 `{tier: 'small', effective_path: 'grep'}` 兜底
11. **vault 大小过滤** —— `00_模板/` `.obsidian/` `node_modules/` `.git/` `temp/` 下的 .md 不计入 vault_size

`node --test scripts/qmd-detect.test.mjs` 必须全绿。

e2e 测试：**不写**（依赖实际 Claude Code session + vault）。README 写明 vault 用户跑 `node scripts/qmd-detect.mjs --vault=.` 看到 stdout JSON 即可验证。

## §7 已知 trade-off（spec 内显式写）

1. **Q1-Q5 跨模式不感知** —— LLM 看答案本身，Q1（≥3 事实点）等阈值在 qmd 模式不调优。结果：vault >= 1500 用了 qmd 后，Q1 比 grep 模式**更容易**触发（qmd 召回 top-K 准）。**可接受**——本就如此设计。

2. **测试仅单元级** —— e2e 依赖 Claude Code session + vault。无法 mock 整个 session。**可接受**——README 引导 vault 用户跑脚本验证。

3. **state.json 不做 lint-wiki 校验** —— vault 用户手改 `path_override: "banana"` 不会被 lint-wiki 报错（`qmd-detect.mjs` 容错）。**YAGNI**——vault 用户手写坏自己修。

4. **大 vault 未装 qmd 的强提示是噪声** —— `large` tier 下每次询问前都强提示 vault 用户装 qmd，对 vault 用户干扰大。**可接受**——`state.path_override: "grep"` 一行解封；vault 真到 3000+ 还拒绝装 qmd 的话，**值得被强提示**。

5. **vault mtime 受 fsatomic move 影响** —— atomic rename 不改源文件 mtime，但 vault 增删文件 mtime 必变。脚本处理是「mtime 变就重数」，所以 atomic-rename-then-add 这种罕见模式 mtime 不变 → vault_size cache 失效，但**只会少算（不会多算）**——safe direction。

6. **`qmd collection list` 命令存在但未配置 vault** —— 进程 exit 0 返回空数组，qmd_available = true 但实际不可用。**已知误判**——v3 不深入解决，留 future work（v4 可考虑 `qmd collection show <vaultRoot>` 二次校验）。

## §8 变更清单（这次实施涉及的文件）

按 plugin `CLAUDE.md` 第 61 行「单文件改动走单文件提交」，预计 6-7 个独立 commit：

| # | 文件 | 性质 | commit message 类型 |
|---|---|---|---|
| 1 | `skills/llm-wiki-query/SKILL.md` | 改阶段 B0 + 重写 qmd 决策段 | `feat(skill)` |
| 2 | `scripts/qmd-detect.mjs` | 新建 | `feat(script)` |
| 3 | `scripts/qmd-detect.test.mjs` | 新建 | `test(script)` |
| 4 | `hooks/hooks.json` | 新增 matcher（保留 check-update） | `feat(hook)` |
| 5 | `00_模板/Log_Spec.md` | 召回方式枚举扩 `'qmd'` 值 | `feat(template)` |
| 6 | `CLAUDE.md`（plugin） | ASCII 协作图 sync + 文件索引表 | `docs(plugin)` |
| 7 | `README.md` | 「关于召回路径」段更新 | `docs(readme)` |

**不改：**
- `00_模板/CLAUDE_Template.md`（铁律 #2 不涉及——本次是 query skill 内部决策）
- `10_schema/config.md`（不涉及 schema）
- `docs/superpowers/specs/spec-plugin-overview.md`（plugin 上游 spec，本次不破坏接口）

## §9 future work

- v4：`qmd collection show <vault>` 二次校验，避免「qmd 命令存在但未配置当前 vault」的误判（见 §7 trade-off 6）
- v4：lint-wiki 加 state.json schema 校验
- v4：脚本输出从 stdout JSON 改为 `claude-code://context-inject?json=...` 形式（更结构化）
- v4：vault 用户可能想要 `vault/.llm-wiki-query-state.json` 是 vault 内文件而非 root——考虑放在 vault `00_模板/` 内部
- v5：拆独立 skill `llm-wiki-query-qmd`，让 `path_override` 只在新 skill 内生效，本 skill 仍是纯 grep（v3 反过来，把 qmd 引入本 skill 的代价已付，未来真要拆容易）
