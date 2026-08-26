# samsara — RSI framework on DeepSeek Harness

**一句话**：建立在 dsh 上的通用递归自改进（RSI）框架——每个改动是一个 challenger，在可处置的子 scope 里求值，只凭回路之外的真值经统计门晋升为 champion，人类 sign-off 走回路够不到的通道。**最终目标是开源发布。** coding-tasks 是它当前唯一的消费者（pack），与框架不耦合——框架不认识任何 pack，只认 `pack.yaml` 与命令 stdout。

先读 `docs/design/philosophy.md`（理念与边界）、`docs/design/architecture.md`（仓库/插件/契约/约束/启动序）、`docs/design/packs.md`（pack 契约与消费者）。本文只放纪律。

## Language
- 与用户用中文交流；代码、commit message、PR 描述、设计文档用英文；技术术语保留英文
- commit message 不加任何 Co-Authored-By 尾注

## 边界纪律（每次改动前自问）
1. **框架不认识领域。** `packages/` 里不得出现任何表名、字段、业务词、具体指标名、中文业务术语；泄露 grep（`ops/leak-scan.sh`，CI 的 `leak-scan` job）必须为空
2. **框架与 pack 只通过 `pack.yaml` + 命令 stdout 通信。** 不跨线 import；pack 命令永远是子进程
3. **框架不为单个 pack 服务。** 一个框架改动若只有放在 coding-tasks 上才讲得通，先怀疑抽象错了；判据是它对一个只共享 pack 契约、别的什么都不共享的 pack（别的语言、别的真值口径、别的时钟）是否同样成立
4. **前身系统不是依赖。** 前身项目的 store / runner / 原则不进框架；pack 要什么自己 vendor。samsara 不实现 LLM proxy——任何 OpenAI/Anthropic 兼容网关都只经 base_url 使用
5. **三个不动点在回路之外**：book（真值）、gate、signoff。回路内任何东西不能写它们；optimizer 自己可以被优化，裁判和签字权不行
6. **dsh 只经 `packages/kernel` 进入。** 其他包不直接 import dsh 内部路径；重新 pin 是一个文件的事
7. **业务领域与开发记录不进本仓库。** 私有 pack 在仓库外的独立检出里；开发记录（`docs/research/`、`docs/design/notes/`、`docs/handover/`、`ops/bootstrap.md`）与部署事实（`profiles/*/cordis.patch.yml`）留在本地磁盘但不入库。2026-08-24 已用 `git filter-repo` 把它们连同内网术语（网关主机名、前身项目名）一起从历史里剥离
8. **状态转移只经 lifecycle。** `packages/lifecycle` 之外的包不写 `status`、`verdict`、`compares`、`rounds`、`servings`、`noise_floors`；runner 命令、workbench 工具、UI 都是它的消费者，只调它的转移与只读动词

## 硬约束
`docs/design/architecture.md` 的 E1–E8（工程：无历史依赖、sign-off 不可伪造、env_sha、子进程 effect、凭据、TMPDIR、热应用验证、裁判机器隔离 + surface 边界）与 S1–S8（科学：MDE 口径、n_eff 下限、分层打分、futility-only 早停、diff 扫描、真值钉快照、holdout 预算、门含成本）。E1–E8、S5、S6 是框架不变量；S1–S4、S7、S8 是 `gate-default` 的行为，可被替换但 ledger 必须记录。实现任何一步前先对照；它们来自对抗评审与 2026-08-23 的文献校准，不是建议。
一个 challenger 只触一个 surface（v1）；surface 分类以 architecture.md 的 13 项表为准。

## 词汇（公开、领域中性）
book · task · settlement · champion · challenger · surface · scope · attempt · loop · environment · tier(smoke/holdin/holdout/live) · gate · sign-off · ledger · pack · experiment · round · campaign · operator · notebook。不用 case/cutoff 等前身系统时代的词汇。

## 工作方式
- 按 `architecture.md` 的启动序走，每步有可观测门；做完一步与用户同步再继续
- 分析优先于实现：先理解问题全貌再动手；给出方案前先确认理解对不对；最简单的方案优先，不过度工程
- 写代码前先读现有代码，跟着它的风格和模式写；不加未要求的功能、注释或重构
- 已定决策（勿重开）：TS host、唯一 ledger 在 dsh storageDomain、v1 loops-dsh 先 CC 第二、v1 proposer 外部 CLI、UI 独立路由、结构化输出由 host 用 pack 契约校验、v1 不发 npm

## 与 dsh 的关系
- 形态：dsh bundle（`samsara` patch 层）+ 两个 profile 模板：`host` = `dsh-base` + `samsara`（CLI：`run`/`campaign`/`promote`…，脚本与 CI），`workbench` = `dsh-base` + `dsh-web-app` + `samsara` + `samsara-workbench`（对话：operator agent 持 `samsara_*` 工具，`/samsara …` 命令给人）；两者同一 `lifecycle`、同一 ledger；CLI 的 argv 解析行与 `dsh-web-app` 不能共存（B4），所以是两个而不是一个。身份：dsh 的 RSI 层；不 fork
- 拥抱 cordis service 但不过度——只有真正需要被替换/注入的边界才做成 service，纯函数（统计、校验、哈希）保持纯函数。设计兼顾 cordis 的模式与哲学：进程内 seam（gate / proposer / loop / book …）就是 cordis service——`inject`/`provide`、schemastery `Config`、Definition + Provider + Consumer 一起发布、按 dsh 的角色词汇（Registry/Runtime/Provider/Backend/Policy）命名；替换策略 = 改一行 `cordis.patch.yml`，不自造插件机制
- 只有跨进程/跨语言的数据契约（`pack.yaml`、命令 stdout、ledger 行、训练导出）不含 dsh 类型——pack 作者与外部 proposer CLI 无需知道 dsh 存在
- 持续跟踪 dsh 演进：每次 re-pin 记录我们适配了什么、dsh 哪些变化对我们有利/不利
- **dsh 不接受外部 PR**（2026-08-24 核实）：`CONTRIBUTING.md` 明写 "cannot accept external pull requests at the moment"，公开仓库的 PR 功能在 GitHub 上是禁用的（`/pulls` → 404），Issues 也关（`has_issues: false`），只开 Discussions。公开仓是内部仓的发布镜像（我们 pin 的 commit 是 "Merge pull request #2908 from deepseek-harness/…"）。因此投递路径改为：**小的 bug/DX 发现走 Discussions；通用能力件（loops seam、durable steps、OTel GenAI spans、config trial scope）自己发独立插件包并打 `dsh-plugin` topic**，不进官方仓。CONTRIBUTING 的措辞是 "at the moment"，每次 re-pin 顺手复查这个状态。候选清单与分档见 `docs/dsh-plugin-notes.md` E 节

## Environment
- Node + pnpm；dsh 钉 `b150a551`（需要源码时重新 clone 并 checkout）
- pack 命令可用任意语言；coding-tasks 自带两个 runtime（`runtime/py/.venv` CPython 3.12 + `runtime/js/node_modules`）。Python 一律走项目内的 venv，不用系统解释器
- macOS 开发；跑批在 pod
