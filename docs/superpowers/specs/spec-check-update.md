# SessionStart Plugin Update Check — 设计

- 日期:2026-08-23
- 作者:zhigangliu
- 状态:待用户 review

## 背景

`llm-wiki-plugin` 通过 marketplace 安装后,本地仓根是 git working tree(`~/.claude/plugins/cache/myself-marketplace/llm-wiki-plugin/<version>/`,含 `.git/`)。plugin 作者 push 新 commit 后,**用户本地副本不会自动更新** — Claude Code 缓存策略是按 version 锁住,要更新必须重装或手动 `git pull`。

问题:用户感知不到 plugin 升级。开发者这边 push 完,用户那边还是旧版本。

## 目标

在 plugin 里加一个 **SessionStart hook**(matcher=`startup`),Claude Code 启动时:
1. 自动 `git pull --ff-only`,把 plugin 仓本地副本拉到与远端一致
2. **不修改未 commit 改动**(`--ff-only` 保证非快进时失败而非合并)
3. 失败(无网络 / 非 git 仓 / ff 失败)**静默 + stdout 一行警告**,不阻断 session 启动
4. 成功时 stdout 输出 commit 摘要,让 LLM 在下次对话看到并主动告知用户

**非目标**(YAGNI):
- 不更新 `myself-marketplace` 仓(marketplace 不是 plugin,无 hook 机制;且 `/plugin marketplace update` 是官方命令)
- 不自动 push(只 pull)
- 不修改 plugin 版本号(`marketplace.json` 维护者手动 bump)
- 不做版本兼容性检查
- 不在 `resume` / `clear` / `compact` / `fork` matcher 触发(只 startup)

## 行为契约

| 场景 | 行为 | stdout | exit code |
|---|---|---|---|
| 无更新(本地 = origin) | 静默成功 | (空) | 0 |
| 有更新,`git pull --ff-only` 成功 | stdout 提示 | `✓ llm-wiki-plugin updated: <old>..<new>` | 0 |
| 本地有未 commit 改动 + 远端无新 commit | 静默成功(不动) | (空) | 0 |
| 本地有未 commit 改动 + 远端有新 commit + ff 失败 | 跳过 pull | `⚠ llm-wiki-plugin update skipped: local changes + remote diverged` | 0 |
| `git fetch` 失败(无网络 / remote 不可达) | 静默 | `⚠ llm-wiki-plugin update check failed: <reason>` | 0 |
| plugin 安装目录**不是** git 仓(理论上不会发生,但防御) | 跳过 | `⚠ llm-wiki-plugin update skipped: not a git repository` | 0 |
| `--ff-only` 失败(非快进,远端改写历史) | 跳过 | `⚠ llm-wiki-plugin update skipped: non-fast-forward` | 0 |

**所有失败都 exit 0** — hook 绝不阻断 session 启动。LLM 看到的 stdout 进 context,会主动告诉你"plugin 有更新失败 / 有未 commit 改动"。

## 架构

```
hooks/hooks.json                                    # SessionStart hook 配置
  └─ matcher "startup" → command: node scripts/check-update.mjs

scripts/check-update.mjs                            # 纯 Node async 脚本
  steps:
    1. 检查 cwd 是否在 git 仓内 → 不是则 stdout warning + exit 0
    2. 检查本地是否有未 commit 改动 → 不影响 ff 拉取,但记录
    3. git fetch origin main → 失败 stdout warning + exit 0
    4. 比较本地 HEAD vs origin/main:
       - 相同 → 静默 exit 0
       - 不同 → git pull --ff-only
         - 成功 → stdout "updated: old..new" + exit 0
         - 失败(非 ff / 冲突) → stdout warning + exit 0
    5. 全部静默失败兜底
```

### 为什么用脚本包装而非一行 command hook

按 CLAUDE.md "执行 sub agent 默认 Subagent-Driven" 原则对齐 — **逻辑都进脚本,hooks.json 只放配置**。理由:
- 失败处理(8 种场景)用 shell 难写、易错、不可测
- Node 脚本可被 `node --test` 覆盖(grep stderr / stdout / exit code)
- `scripts/check-update.test.mjs` 单元测试覆盖核心逻辑,跟 `init-vault` / `lint-wiki` 同模型

## 数据流

```
Claude Code 启动
  ↓ 触发 SessionStart hook (matcher=startup)
node scripts/check-update.mjs  (cwd = plugin 安装根 = ${CLAUDE_PLUGIN_ROOT})
  ↓
fetch → 比较 → pull --ff-only (或不)
  ↓
stdout 输出 (空 / ✓ / ⚠)
  ↓
Claude Code 把 stdout 加进 session context
  ↓
LLM 下次看到 → 主动告知用户
```

### hooks.json 完整内容

```json
{
  "description": "Auto-update llm-wiki-plugin from GitHub on session start",
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "node \"${CLAUDE_PLUGIN_ROOT}/scripts/check-update.mjs\"",
            "async": true
          }
        ]
      }
    ]
  }
}
```

`async: true` 因为 `git fetch` 在网络慢时会阻塞 session 启动,`async` 让 hook 后台跑,stdout 延迟到 session 期间注入(Claude Code 支持)。

## 实现细节

### `check-update.mjs` 主流程

```js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promisify as p } from 'node:child_process';  // 实际写法见 plan

const exec = promisify(execFile);
const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT ?? process.cwd();

async function git(...args) {
  try { return { ok: true, stdout: (await exec('git', args, { cwd: PLUGIN_ROOT })).stdout.trim() }; }
  catch (e) { return { ok: false, stderr: e.stderr?.toString().trim() ?? e.message }; }
}

async function main() {
  // 1. 是否 git 仓
  const rev = await git('rev-parse', '--git-dir');
  if (!rev.ok) { console.log('⚠ llm-wiki-plugin update skipped: not a git repository'); return; }

  // 2. 本地是否有未 commit 改动(记录用,不影响 pull)
  const status = await git('status', '--porcelain');
  const hasLocalChanges = status.ok && status.stdout.length > 0;

  // 3. fetch
  const fetch = await git('fetch', 'origin', 'main');
  if (!fetch.ok) { console.log(`⚠ llm-wiki-plugin update check failed: ${fetch.stderr.split('\n')[0]}`); return; }

  // 4. 比较
  const local = await git('rev-parse', 'HEAD');
  const remote = await git('rev-parse', 'origin/main');
  if (!local.ok || !remote.ok) { console.log('⚠ llm-wiki-plugin update check failed: rev-parse error'); return; }
  if (local.stdout === remote.stdout) return;  // 已最新

  // 5. pull --ff-only
  const pull = await git('pull', '--ff-only', 'origin', 'main');
  if (pull.ok) {
    const newHead = await git('rev-parse', '--short', 'HEAD');
    console.log(`✓ llm-wiki-plugin updated: ${local.stdout.slice(0, 7)}..${newHead.stdout}`);
  } else {
    const reason = hasLocalChanges ? 'local changes + remote diverged' : 'non-fast-forward';
    console.log(`⚠ llm-wiki-plugin update skipped: ${reason}`);
  }
}
```

(实际写法会在 plan 阶段细化,包括并发优化 / 错误边界 / 测试 mocking `execFile`)

### 测试覆盖

| 测试 | 验证 |
|---|---|
| `not a git repository` 时 stdout warning + exit 0 | cwd 防御 |
| 无网络(模拟 fetch ENOTFOUND)→ warning + exit 0 | 失败静默 |
| 本地 = origin → 空 stdout + exit 0 | 幂等 |
| 本地 < origin + 无本地改动 → `git pull --ff-only` + `✓ updated: old..new` | 正常更新 |
| 本地 < origin + 有本地改动 + ff 成功 → 同上(ff-only 不影响未 commit 改动) | 不破坏用户工作 |
| 本地 < origin + 远端改写历史(模拟 ff 失败)→ warning + exit 0 | 防御非 ff |
| stdout 单行格式严格匹配 (`✓ ` / `⚠ ` 前缀) | 给 LLM 解析稳定 |

测试用 mock `execFile` 隔离真实 git(也允许在 sandbox 里跑)。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| hook 跑得慢,阻塞 session 启动 | `async: true`,hook 后台跑 |
| `git pull` 在用户工作中断 → 合并冲突 | `--ff-only`,非快进直接跳过不合并 |
| 用户本地仓被 hook 改了 → 与市场 catalog 版本不一致 | ff-only 拉取 = 远端 history 包含本地 → 不会改变 plugin 行为,Claude Code 下次 reload 用新版本 |
| hook 反复跑(每天 N 次 session)→ 浪费网络 | matcher=`startup` 只触发一次/启动;fetch 本身轻量 |
| `CLAUDE_PLUGIN_ROOT` 未设(开发模式直接跑脚本) | fallback 到 `process.cwd()`,跟 `lint-wiki` 一致 |
| 用户开发 plugin 时 push 完,下次 session 又被拉回远端覆盖本地未 push 改动 | **会** — 但只影响未 push 的本地 commit;`--ff-only` 不会覆盖本地未 commit 改动;若有本地 commit 但没 push + 远端有新 commit → ff 失败 → 跳过 → warning |

## 实施路线

按 writing-plans skill 产出 plan,3 个任务:

1. **写 `scripts/check-update.mjs` + 8 个测试通过**(`node --test scripts/check-update.test.mjs`)
2. **写 `hooks/hooks.json` + plugin manifest 验证**(`claude plugin validate`)
3. **更新 plugin README,加 SessionStart hook 说明 + 失败排查**

## 参考

- Claude Code Hooks 文档:https://code.claude.com/docs/en/hooks
- Plugin hooks 位置:https://code.claude.com/docs/en/plugins-reference#hooks
- `CLAUDE_PLUGIN_ROOT` 环境变量:hook command 里引用 plugin 安装目录
