# samsara — RSI framework on DeepSeek Harness

**一句话**：建立在 dsh 上的通用递归自改进（RSI）框架——每个改动是一个 challenger，在可处置的子 scope 里求值，只凭回路之外的真值经统计门晋升为 champion，人类 sign-off 走回路够不到的通道。**最终目标是开源发布。** pricing 只是它的一个消费者（pack），与框架不耦合。

先读 `docs/design/philosophy.md`（理念与边界）、`docs/design/architecture.md`（仓库/插件/契约/约束/启动序）、`docs/design/packs.md`（两个消费者）、`docs/design/migration.md`（legacy 基建各自归位）。本文只放纪律。

## Language
- 与用户用中文交流；代码、commit message、PR 描述、设计文档用英文；技术术语保留英文
- commit message 不加任何 Co-Authored-By 尾注

## 边界纪律（每次改动前自问）
1. **框架不认识领域。** `packages/` 里不得出现任何表名、字段、业务词、具体指标名、中文业务术语；CI 泄露 grep 必须为空
2. **框架与 pack 只通过 `pack.yaml` + 命令 stdout 通信。** 不跨线 import；pack 命令永远是子进程
3. **两个 pack 同时成立。** 一个框架改动若只对 coding-tasks 或只对 pricing 有意义，先怀疑抽象错了
4. **legacy 不是依赖。** pricing pack 可以 vendor legacy 代码实现自己的命令；legacy 的 store / runner / 原则 / CLAUDE.md 不进框架。LLM proxy 由 gateway 接管，samsara 只经 base_url 使用，不实现 proxy
5. **三个不动点在回路之外**：book（真值）、gate、signoff。回路内任何东西不能写它们；optimizer 自己可以被优化，裁判和签字权不行
6. **dsh 只经 `packages/kernel` 进入。** 其他包不直接 import dsh 内部路径；重新 pin 是一个文件的事
7. **`packs/pricing` 是私有内容，直接放本仓库**；开源发布时再单独考量迁移（拆 submodule / 镜像剥离）。发布前本仓库不对外

## 硬约束
`docs/design/architecture.md` 的 E1–E8（工程：无历史依赖、sign-off 不可伪造、env_sha、子进程 effect、凭据、TMPDIR、热应用验证、裁判机器隔离 + surface 边界）与 S1–S8（科学：MDE 口径、n_eff 下限、分层打分、futility-only 早停、diff 扫描、真值钉快照、holdout 预算、门含成本）。E1–E8、S5、S6 是框架不变量；S1–S4、S7、S8 是 `gate-default` 的行为，可被替换但 ledger 必须记录。实现任何一步前先对照；它们来自对抗评审与 2026-08-23 的文献校准，不是建议。
一个 challenger 只触一个 surface（v1）；surface 分类以 architecture.md 的 13 项表为准。

## 词汇（公开、领域中性）
book · task · settlement · champion · challenger · surface · scope · attempt · loop · tier(smoke/holdin/holdout/live) · gate · sign-off · ledger · pack。不用 experiment/case/cutoff/consent/cm_id 等 legacy 时代词汇（research 文档除外）。

## 工作方式
- 按 `architecture.md` 的启动序走，每步有可观测门；做完一步与用户同步再继续
- 分析优先于实现；先读现有代码再写；不加未要求的功能；最简单方案
- 已定决策（勿重开）：TS host、唯一 ledger 在 dsh storageDomain、v1 loops-dsh 先 CC 第二、v1 proposer 外部 CLI、UI 独立路由、结构化输出由 host 用 pack 契约校验、v1 不发 npm

## 与 dsh 的关系
- 形态：dsh bundle（`samsara` patch 层）+ profile 模板（`host`）；身份：dsh 的 RSI 层；不 fork
- 拥抱 cordis service 但不过度——只有真正需要被替换/注入的边界才做成 service，纯函数（统计、校验、哈希）保持纯函数。设计兼顾 cordis 的模式与哲学：进程内 seam（gate / proposer / loop / book …）就是 cordis service——`inject`/`provide`、schemastery `Config`、Definition + Provider + Consumer 一起发布、按 dsh 的角色词汇（Registry/Runtime/Provider/Backend/Policy）命名；替换策略 = 改一行 `cordis.patch.yml`，不自造插件机制
- 只有跨进程/跨语言的数据契约（`pack.yaml`、命令 stdout、ledger 行、训练导出）不含 dsh 类型——pack 作者与外部 proposer CLI 无需知道 dsh 存在
- 持续跟踪 dsh 演进：每次 re-pin 记录我们适配了什么、dsh 哪些变化对我们有利/不利；接口稳定后（P4 之后）把通用件（gate seam、settlement 事件等）作为有价值的 PR 提给 dsh，不是现在

## Environment
- Node + pnpm；dsh 钉 `b150a551`（需要源码时重新 clone 并 checkout）
- pack 命令可用任意语言；pricing pack 用 Python ≥ 3.11（自带 .venv）
- macOS 开发；跑批在 pod
