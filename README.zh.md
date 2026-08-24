# samsara

[English](README.md) | 中文

建立在 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 上的通用递归自改进（RSI）框架。

## 愿景

**samsara 是 agent harness 的自改进基座：让一个运行中的 harness 在来自现实的、未被优化器污染的、可追溯推翻的证据下持续迭代自己。**

- **来自现实**——真值在回路之外，即时或延迟到达，settlement 是事件
- **未被优化器污染**——holdout 是消耗品，裁判被机器隔离，judge 分数进不了 verdict
- **可追溯推翻**——每次采纳带完整坐标，世界变了就重审，champion 是活的

改的是 harness 不是权重：v1 开放 skill / prompt 段 / memory / tool 配置四个 surface；runtime control 与 route 先作坐标；optimizer 配置先记账、later 作慢时标 challenger。评测工件和三个不动点（book / gate / sign-off）永远不是 surface。机制固定、策略可换：统计方法、优化算法、评测逻辑、签字通道都是插件，默认严格，ledger 记着用的是哪个。

要领先的三件事：**holdout 记账**（Thresholdout/Ladder 在 agent 优化回路的首次工程化）、**延迟真值上的自动回路**、**活的 champion**（真值/scorer/模型/任务集变更 = 事件，沿祖先重打分并可降级）。在已有先例上闭环的三件事：surface 归因回馈 proposer、固定门下可撤销的跨 harness skill 认证、带采纳与结算标签的训练出口。完整论证见 `docs/design/philosophy.md`。

> 状态（2026-08-24）：M0–M5、P5、P6 与其后的采纳（`--parallel`、`run --resume`、sandbox 策略、`env_sha`、OTel 导出）已实现并提交——两条 loop（dsh、Claude Code）在 Aider Polyglot 上跑通，gate-default / ledger(sqlite) / scope / signoff / champion / proposer 全链路端到端验证，真实一轮 `claude -p` 提案已跑通。设计见 `docs/design/`，运行方式见下文"怎么跑"与 `ops/README.md`。

## 先读什么

| 文件 | 内容 |
|---|---|
| `CLAUDE.md` | 纪律：边界、硬约束索引、词汇、已定决策 |
| `docs/design/philosophy.md` | 理念与边界：三个不动点（book / gate / sign-off）在回路之外，其余一切可变 |
| `docs/design/architecture.md` | 仓库布局、插件与服务、**surface 分类（13 项）**、pack 契约、ledger 数据模型、生命周期、硬约束 E1–E8 / S1–S8、启动序 |
| `docs/design/packs.md` | pack 契约与消费者：`coding-tasks`（公开、即时真值）；第二个 pack 需要什么 |
| `docs/dsh-plugin-notes.md` | 在 dsh 上写插件的实战记录：心智模型、踩过的坑、验证过的模式 |

## 仓库布局（目标态）

```
profiles/host/       dsh --profile host 启动的东西；cordis.patch.yml == champion 保留的 rows
packages/            框架：TS 写的 dsh 插件，一个概念一个包
  kernel book pack ledger scope champion gate signoff loops loops-dsh loops-claude-code workdir submit proposers ui
packs/
  coding-tasks/      公开、即时真值；CI 跑它；也是开源 demo（唯一在树内的 pack）
examples/  ops/  tests/  docs/
data/                $SAMSARA_HOME（gitignored）：ledger sqlite + attempt 产物
```

## 外部依赖

| 依赖 | 版本 / 位置 | 作用 |
|---|---|---|
| dsh | 钉 `b150a551` = npm `@deepseek-ai/dsh@0.1.1-rc.2`（同一 tag）；源码检出在 `../deepseek-harness` | 内核：scope / loader / storage / llm seam / subprocess |
| Node + pnpm | Node ≥ 22.19，pnpm 11.7.0 | 工具链与 dsh 一致 |
| LLM 网关 | 任何 OpenAI/Anthropic 兼容网关（网关不可达时只有 null loop 与回放测试可用） | dsh 经 `llm-pi-ai` 的手工路由（`api: anthropic-messages`，baseURL = 网关根）接入；Claude Code loop 经 `ANTHROPIC_BASE_URL`。两条 wire、tool call、流式、并发均已实测 |
| Aider Polyglot | `Aider-AI/polyglot-benchmark`（Exercism 内容，MIT） | `packs/coding-tasks` 的 P1 任务源，取 Python 34 + JS 48 = 82 题 |
| Python + Node | pack 命令可用任意语言 | `packs/coding-tasks` 自带 `runtime/py/.venv`（3.12 + pytest）与 `runtime/js/node_modules` |

凭据（网关 API key）一律不进仓库：dsh 侧走 `$DSH_HOME/.credentials.yaml` 的 `apiKeyEnv` 引用，Claude Code 侧按 E5 显式注入。网关地址等部署事实写在 `profiles/host/cordis.patch.yml`（gitignored，样板见同目录 `.example.yml`）。

## 已定决策（勿重开）

- TS host；唯一 ledger 在 dsh `storageDomain`（sqlite）；v1 先做 `loops-dsh`，Claude Code 第二；v1 proposer 是外部 CLI；UI 独立路由；结构化输出由 host 用 pack 契约校验；v1 不发 npm
- 业务领域与开发记录不进本仓库：私有 pack 已移出；`docs/research/`、`docs/design/notes/`、`docs/handover/`、`ops/bootstrap.md` 本地保留但不入库
- 本地开发、本地验证，LLM 指向兼容网关；之后再迁服务器
- gate 初值：α = 0.05、β = 0.20、bootstrap B = 2000、n_eff 下限 20；SE 来自 ≥3 次同配置 rerun 的实测噪声底，不用假设 sd
- coding-tasks 从 Aider Polyglot 起步；后续用 SWE-smith 式合成 bug 补"真实 repo 结构"

## 开工前清单

| # | 项 | 状态 |
|---|---|---|
| 1 | 设计文档（philosophy / architecture / packs） | ✅ |
| 2 | dsh 源码检出 `b150a551`，已构建（`apps/cli/lib/bin.js`） | ✅ |
| 3 | pnpm 11.7.0、Node 22 | ✅ |
| 4 | 网关可用性实测（messages + responses 两条 wire） | ✅ |
| 5 | dsh → 网关接法确认（`llm-pi-ai` 手工路由；`llm-deepseek` 的 chat-completions wire 该网关不收） | ✅ |
| 6 | coding-tasks 任务源选定并看过题目结构 | ✅ |
| 7 | 对抗评审的门蒙特卡洛脚本保留在开发记录里（不入库，已移植为 `packages/gate/tests/sim.test.ts`） | ✅ |
| 8 | `dsh` CLI 进 PATH（`pnpm link` 或 alias 到源码 bin） | ✅ |
| 9 | 根 `package.json` + `pnpm-workspace.yaml`，dsh 包 exact pin `0.1.1-rc.2` | ✅ |
| 10 | `profiles/host/{package.json, cordis.patch.yml}`：网关路由 + `agent-default-model` | ✅ |
| 11 | `$DSH_HOME/.credentials.yaml` 放网关 key | ✅ |
| 12 | `dsh --profile host --dump-config` 含网关路由；headless 说一句话成功 | ✅ P0 门 |
| 13 | 三份 schema 文件：`pack.yaml`（含 `holdout` 与 `surfaces` 段）、`truth`/`score` stdout（含 cost 指标）、contract 校验方式 | ✅ |
| 14 | `LICENSE`；tests 运行方式 | ✅ |
| 15 | **holdout 可行性计算**：用 83 题的实际 n 代入 Thresholdout/Ladder 界，结果写进 S7 | ✅ |
| 16 | **dsh 暴露配置键清单**（compaction / hooks / sub-agent / runtime control）= v1 surface 在 dsh 上的分母 | ✅ |
| 17 | 一轮成本模型（重复次数 × 任务数 × K） | ✅ |

P0（= M0）已全部完成；`dsh` 经 `npm i -g @deepseek-ai/dsh@0.1.1-rc.2` 安装（pnpm -g 的隔离布局会让 loader 解析不到兄弟包）。

## 怎么跑

```sh
pnpm install && pnpm build && pnpm test                 # 39 files / 270 tests，全部离线
ops/leak-scan.sh                                        # 边界纪律 1：packages/ 里不许有领域词（CI 同款）
dsh plugin --profile host install                       # 首次：把 packages/bundle 链接进 host profile
dsh --profile host --dump-config | grep samsara         # 合成配置里应有 samsara 的行

# 跑 attempts（null 不调模型；dsh / claude-code 经网关调模型）
dsh --profile host run --pack packs/coding-tasks --loop null --set smoke --limit 2 --out data/runs/x
# 一个 challenger 走完整链路：diff scan → scope → attempts → gate → ledger
dsh --profile host challenge --pack packs/coding-tasks --loop null --set holdin --limit 2 \
    --surface skill --skill-dir <dir> --intent "..." --metric pass_rate --with-champion
# 一轮：proposer 出提案 → 同上
dsh --profile host round --pack packs/coding-tasks --loop dsh --proposer claude-p --set smoke --limit 2 --metric pass_rate --with-champion
# 晋升需要签字（unix socket + Ed25519，HTTP 不算证明）
node packages/signoff/lib/cli.js keygen --out data/signoff
dsh --profile host promote <challengerId> --wait 60 &
node packages/signoff/lib/cli.js confirm --socket data/signoff.sock --key data/signoff/signoff.key --row <challengerId> --action promote --who <name>
dsh --profile host demote <challengerId> --reason "..."
# UI：`serve` 会打印实际端口（默认 OS 分配；要固定端口在 profile patch 里给 webserver 行设 port）
dsh --profile host serve        # → samsara host serving; ui http://127.0.0.1:<port>/samsara
# 跨 harness 认证表
dsh --profile host certify --pack packs/coding-tasks --skill-dir <dir> --loops dsh,claude-code --set smoke --limit 2 --metric pass_rate
# 并发与断点续跑：--parallel N 走流水线；SIGINT 后 --resume <dir> 只补没写 marker 的 attempt
dsh --profile host run --pack packs/coding-tasks --loop dsh --set holdin --limit 32 --parallel 16 --out data/runs/x
dsh --profile host run --resume data/runs/x
# 导出：attempt 的 loop 事件 → OTel GenAI span
dsh --profile host export --run data/runs/x --format otlp-json --out data/runs/x.otlp.json
```

> ledger 是 cwd 相对的（`<cwd>/data/ledger/samsara_ledger.sqlite`），所以在仓库根跑的任何一次 `run` 都会写进那一个真实 ledger。只是想验证环境的话换个 cwd 跑。

## 里程碑（实际执行顺序）

| 里程碑 | 内容 | 状态 |
|---|---|---|
| M0 | workspace、kernel、schema、host profile ↔ 网关、可行性/配置键/成本三份 note | ✅ |
| M1 | `packs/coding-tasks`（Polyglot py+js 82 题）、`@oldbulb/samsara-pack`、`@oldbulb/samsara-book` | ✅ |
| M2 | loops seam + null、workdir、submit、loops-dsh、loops-claude-code、runner；两条 loop smoke 8/8；replay 离线测试 | ✅ |
| M3 | gate-default（BCa/Holm/MDE/Ladder + 策略定义模拟）、ledger on sqlite、runner 写 ledger | ✅ |
| M4 | scope（E1/E8 diff scan）、signoff（E2）、champion（E7）、`challenge/promote/demote/serve` | ✅ |
| M5 | proposers（claude-p / human）、proposer 视图、`round`、champion skill 默认 | ✅ 真实 `claude -p` 一轮已跑通 |
| P6 | `/samsara` 页面（host 路由插件，内联 HTML + JSON API，只读；Internal 设计体系）、`certify` 跨 harness 认证表、gate `facts:mismatch`、skill utilization | ✅ |
| P5 | 延迟真值那条线（`status: pending` → settlement 重打分、带 token 的 `data` 命令、按 `stratum` 分层打分）由一个私有 pack 验证过：两条 loop 各跑通 1 次真实 attempt。该 pack 已于 2026-08-24 移出本仓库，框架侧的能力留下了 | ✅（能力在；树内没有 pack 驱动它） |
| 采纳 | `--parallel N` 流水线（32/32 实测）、durable step marker + `run --resume`、`@oldbulb/samsara-sandbox` landlock 策略、`env_sha` 取自 lock 文件、OTel GenAI span 映射 + `export --format otlp-json` | ✅ |

已知局限：主力模型在 Python/JS Exercism 上 pass_rate 恒为 1.0（3 次同配置 rerun 实测噪声底 sd=0），阳性对照晋升需要更难任务（更多 Polyglot 语言 / SWE-smith），统计门因此还没被真正证伪过；live tier（mSPRT）未实现；proposer 进程在 macOS 上没有文件系统沙箱（E9，v1 开放）；SIGINT 会丢少量 ledger 写（`attempts.jsonl` 完整，`run --resume` 可重建）。

## 启动序（设计文档中的 P 序，供对照）

| 步 | 做什么 | 可观测门 |
|---|---|---|
| P0 | workspace、host profile、dsh↔网关打通、schema、LICENSE、holdout 可行性计算、dsh 配置键清单、成本模型 | 清单 8–17 |
| P1 | `pack` + `book` + `gate-default`（纯 TS，无 dsh 运行时）；`packs/coding-tasks` 从 Polyglot 转格式；score 契约含 cost；`gate_sim.py` 改成 TS 测试 | truth/score stdout 过校验；3 次 rerun 得噪声底；MDE 正确；holdout 按 `entity_key` 不相交；null siblings false-keep < α·K；纯噪声任务集零晋升；"更大预算优化器"臂不假晋升；阳性对照能晋升 |
| P2 | `kernel` + `scope` + `workdir` + `submit` + `loops-dsh`（null skill）；surface 边界与 diff 扫描（E8）；单 surface 约束 | 20/20 valid submits；dispose 后零进程、registry 复原、profile sha 不变（E1）；token guard 拒 deny_patterns；触碰 `bin/truth` 或越过 surface glob 的 patch 在运行前被拒 |
| P3 | `ledger` + `champion` + `signoff`；重打分 append 语义；champion 为内容寻址 alias；模型升级事件 | 重启后 ledger 一致；无 consent 的 promote 被拒；consent 只认 socket；热应用 sha 验证（E7）；model pool 变更触发祖先重打分 |
| P4 | coding-tasks 端到端 + `claude -p` proposer + tiers + holdout 预算 + CI | 真实 skill diff 跑完 smoke→holdin→holdout；`|Δ|<MDE` 被拒；过夜 K=4 无签字零晋升；预算耗尽轮换 holdout；真值修订重打分并降级 |
| P5 | 延迟真值：pending 真值、带 token 的 `data` 命令、分层打分 | settlement 事件重打分 held rows；时间参数被拒；sandbox 内 gated query 403 |
| P6 | `loops-claude-code` + `ui`；跨 harness 认证输出 | 两条 loop 两行；facts 不同拒 A/B；`skill_utilization` 与 pass rate 分列；adapter 版本入账；UI 首屏 = champion · settlement · challengers · sign-offs |

之后：历史回放 tier、codex / pi loop、optimizer 作为 surface、训练导出。

## 词汇

book · task · settlement · champion · challenger · surface · scope · attempt · loop · tier(smoke/holdin/holdout/live) · gate · sign-off · ledger · pack。不用 experiment / case / cutoff / consent 等前身系统时代的词汇。

## Claude Code loop 默认关

`loops-claude-code` 依赖 `@anthropic-ai/claude-agent-sdk`——它不是开源许可（"© Anthropic PBC. All rights reserved."）。因此它是 optional peer，bundle 里那一行默认 `disabled: true`，装 samsara 不会把它装上。要用这条 loop：

```sh
dsh plugin --profile <name> add @anthropic-ai/claude-agent-sdk
# 然后在 profile 的 patch 层：- { id: loops-claude-code, disabled: false, config: {...} }
```

没装就启用会报人话：`loops-claude-code: @anthropic-ai/claude-agent-sdk is not installed…`。框架其余部分不碰它。

## 参与与许可

| 文件 | 内容 |
|---|---|
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 什么样的贡献最合适（pack / loop provider / gate policy）、开发环境、房规、DCO |
| [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) | 对事不对人 |
| [`SECURITY.md`](SECURITY.md) | 漏洞私下报告的通道、在乎哪几类失败、已知的平台限制 |
| [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) | 依赖与任务夹具的来源和许可，含唯一一个非开源依赖（Claude Agent SDK） |
| [`LICENSE`](LICENSE) | MIT |

npm 上以 `@oldbulb` scope 发布：bundle 是 `@oldbulb/samsara`，其余是 `@oldbulb/samsara-<包名>`。
