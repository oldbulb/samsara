# samsara — 自迭代 agent 体系（dsh 内核 · 实验账本为主对象）

**一句话**：一个宿主（host），agent loop（dsh / Claude Code / Codex / pi）是插进宿主里的可替换服务；每次自迭代 = 一个可处置的子 scope（skill@sha × harness × model × cases × cutoff），跑 → 判分 → keep 或 drop；**系统状态 = main 血统上所有 kept 行的集合**，与历史顺序无关。主入口不是 chat，是**实验账本（ledger）**；人和 agent 的动词相同：propose / run / judge / keep-or-drop。

血统：internal（在位）→ legacy（Python 回路：as_of / contracts / 真值铸造 / verifier / runner / server / slime）→ **samsara（挑战者：以 DeepSeek Harness 为内核重建宿主层）**。legacy 不废：它的 Python 件按需 vendor 进 `py/`，legacy 仓库逐步退化为数据与历史。

## Language
- 与用户用中文交流；代码、commit message、PR 描述用英文；技术术语保留英文
- commit message 不加任何 Co-Authored-By 尾注

## 设计来源（读这些，不要重新调研）
- `docs/research/dsh-host/synth_design.md` —— 综合设计（ecosystem-first 骨架 + optimizer-first 回路 + ledger-first 不变量）
- `docs/research/dsh-host/critiques/c_engineering.md`、`c_science.md` —— 对综合设计的对抗评审；**其 blocker 已转为下方硬约束**
- `docs/research/dsh-host/surveys/s1..s4` —— dsh 源码级事实（snapshot `b150a551`, 0.1.1-rc.2）、自改进方法综述、legacy/internal 资产清单、四种 loop 的包裹方式
- `docs/research/prior/refactor-multi-harness.md` —— Python 地基（执行器契约、legacy-data CLI、case token、判分重写、P0–P7）

## 仓库结构（定稿）
```
samsara/
├── CLAUDE.md / README.md
├── package.json / pnpm-workspace.yaml     # @deepseek-ai/cordis + dsh peers 钉死 commit；v1 不发 npm
├── profiles/host/                         # dsh --profile host 启动的东西；cordis.patch.yml == main 上 kept 行
├── packages/                              # TS dsh 插件（公开候选；v1 仅 workspace 内）
│   ├── ledger/                 ctx.ledger      行/动词/@Remote RPC/脱敏读
│   ├── experiment-scope/       ctx.experiments 子 scope 开/keep/drop，harness_sha
│   ├── gate/                   ctx.gate        纯统计库 + verdict(tier)
│   ├── loops/                  ctx.loops       seam: AttemptSpec/LoopRun/HarnessFacts + 注册表
│   ├── loops-dsh/  loops-claude-code/          （后续 loops-codex/ loops-pi/）
│   ├── case-workdir/           ctx.caseWorkdir 密封 workdir + 签名 case token + pre-tool 守卫
│   ├── tool-submit-structured/                 submit_<name> 工具 → <cwd>/<name>.json
│   └── ledger-ui/                              /ledger SPA + sidebar/overlay 座位
├── py/                                    # Python（从 legacy vendor，按启动序逐步搬）
│   ├── samsara_core/           公开候选：runner 池/retry/resume、BreakerGate、proxy、contracts loader、scorer-core、gate-stats
│   └── pricing/                私有：legacy-data CLI、mint、score(arm policy)、store
├── pack/pricing/                          # 私有 domain pack：SKILL.md 正文、decision_v3.yaml、queries/、sources/、minting/、cohorts、fixtures
├── skills/                                # skill 文本血统载体（git；keep = ff main，drop = refs/exp/<id> 留着）
├── data/（gitignored）/ tests/ / docs/
```
公开/私有分界线：**凡是命名表、字段、机构、bp 量纲、利率上限、中文业务词的，一律私有**。公开件里 `case_id` 不用 `cm_id`。发布前 CI 泄露 grep 必须为空。v1 **不发 npm**（dsh 仍是 rc，"发包 + pin rc 内核"自相矛盾）。

## 不变量（账本七条，勿重开讨论）
1. 一行一实验，不可变、不删；被拒行保留
2. `id = sha(parent_ids + patch_sha + harness_sha + skill_sha + caseset_sha + route)`；同提案重跑 = 新 attempt set
3. 影响过分数的坐标全部入列：patch / harness_sha / **env_sha** / skill_sha / caseset_sha / truth_sha（含冻结的 dwd_day） / scorer_version / route / harness_facts
4. verdict 由 gate 代码写；人只 consent 不改分；提议者 ≠ 接受者；judge 类分数在类型层被拒
5. **host 状态 = main 上 kept 行**；replay 校验：从空 profile 重放 kept 行，harness_sha/skill_sha 必须相等
6. scorer / caseset 变更本身是行，重评所有祖先后才可 kept
7. 暴露不对称：proposer 逐 case 只见 held-in，held-out 只见聚合，永不拿到 truth/scores 路径；由 `ledger.read` 返回什么强制，不靠 prompt

## 硬约束（来自对抗评审，设计与实现必须满足）
**工程（历史依赖与越权）**
- E1 实验 scope **不得**经 profile 的文件型 Include 树挂载（`Group`/`tree.write()` 会把实验写进 cordis.yml，下次启动重挂 = 历史依赖）。必须 `ctx.loader.create(..., null)` 进内存根树；门禁：实验前后 profile 配置文件 sha 不变
- E2 consent 证明必须是 optimizer 沙箱够不到的通道（unix socket / 0600 文件签名 nonce）；webserver 无 auth、gateway 是 trusted-host，HTTP 端点不算人类证明
- E3 实验行禁 `!!js`；`harness_sha` 之外必须记 `env_sha`（LaunchEnvironmentSnapshot），否则同 sha 不同路由
- E4 实验 scope 内子进程走 `ctx.subprocess.spawn` + 自己 `ctx.effect` 包 terminate/waitForExit（spawn 不在调用方 fiber 注册 effect）；不用 `ctx.jobs`（需要 Agent owner）
- E5 凭据注入显式声明（subprocess 会剥掉 *KEY/TOKEN/SECRET*/DSH_*）；导出到训练的轨迹先脱敏
- E6 每 attempt 独立 `TMPDIR`（workspace-write 默认放开 /tmp，会跨 attempt 污染）；两个 sqlite 同目录、单写者、备份用 sqlite backup API 不用 cp
- E7 keep 的热应用要有成功信号（`hmr/config-update-failed` 之外再验 `--dump-config` sha），不只靠 file watcher

**科学（keep/drop 可判定性）**
- S1 MDE 按 α=.05 / power 80% 算（≈2.8·SE），不用 `1.28·sd/√n`；噪声底要多次同配置重跑估计，不是 n=1
- S2 **n=19 不可判定**；search/holdout 集合要 ≥50–100 个不同客户 × ≥2 个 cutoff 月，从 Doris cohort 轮换抽取（render-pack 物化），holdout 与 held-in **客户不相交**
- S3 主 keep 指标 = hold 臂 Brier；cut 臂只做分层次级；每指标 n_arm 下限，不足标 `hold:underpowered`；常数/LOCF 基线作永久行；cut_bp/cut_propensity 无真值，只做机械校验
- S4 早停只允许 futility；一次预注册 holdout 检验；Holm 对同轮全部提案；禁止跨轮取极值
- S5 proposal diff 扫描 case id / 字面量；prediction-vs-outcome 作为 gate 输入之一
- S6 truth 修订触发祖先重评；as_of 钉 `dwd_day` / sqlite `snapshot_dt`

## 已定决策（评委推荐，默认采纳；要改先说）
1. TS host，**唯一** ledger 在 dsh storageDomain（不镜像）；大数据留 Python sqlite，两者同在 `$SAMSARA_HOME/<profile>/`
2. v1 loops：`loops-dsh` 先，`loops-claude-code` 第二；Codex / pi 延后（pi 的 worker.ts 池化协议可复用）
3. v1 proposer 是外部 CLI（`claude -p` / `codex exec` / 人经 UI），走 ledger RPC；in-host subagent optimizer 等 consent 通道验证后再加
4. UI = 独立 `/ledger` 路由（`webServer.register`），不替换 conversation slot
5. 四种 loop 一律 Python 侧 `jsonschema` 校验结构化输出，原生 schema 只作提示；成本走 per-attempt `/proxy/a/<attempt>/v1`
6. 数据入口 = `legacy-data` CLI（bash 是四家唯一共有工具面）；cutoff 绑签名 case token，服务端从 token 取；sqlite 模式只支持 pack 模式

## 启动序（每步有可观测门；做完一步与用户同步）
| 步 | 建 | 门 |
|---|---|---|
| 0 | 仓库骨架 + 本文 + research 索引 | 首 commit |
| 1 | **真值 + scorer + gate-stats，纯 Python 不碰 dsh**：mint / score（v3，按实现臂）/ gate-stats；scoped case token + `/doris/query` 403 | mint 复刻 2026-05-31；冻结基线重跑两次分数一致；噪声底 + 正确 MDE 报出；沙箱 curl → 403；**cohort 规模满足 S2** |
| 2 | scope + loops-dsh + case-workdir + submit，跑 null-skill | 20/20 decision.json 有效；dispose 后零子进程、`ctx.registry` 大小复原、profile 文件 sha 不变（E1）；`--cutoff` 被拒；两次启动 harness_sha 相同 |
| 3 | ledger + gate + keep/drop 往返 | 重启后 ledger.list 一致；agent 身份 keep 被拒（E2 通道）；keep 热应用且 dump-config 可见；坏 patch 留 last good；holdout 行 read(cases) 只返回聚合 |
| 4 | domain pack + 真 skill + 分级门 | parity fixtures 绿；真 diff 走 smoke→search→holdout；|Δ|<MDE 拒 keep；scorer 变更触发祖先重评 |
| 5 | loops-claude-code + ledger-ui + terminal 门 | 双 loop null-skill 探针成两行；facts 不同拒 A/B；proxy 成本 ±5%；main 上 keep 需人点；K=4 过夜无一行未经 consent 进 main |

之后：历史月 replay 作快速代理层 → Codex/pi loops → slime 导出（store 中介，rollout 永不直连 trainer）。

## 与 legacy 的关系
- legacy 的 Python 件（as_of、contracts、runner、proxy、server、evals）是 `py/` 的 vendor 源；搬过来的以 samsara 为权威，legacy 侧不再改
- internal 的 `pricing-standalone` 是唯一业务 skill，vendor 进 `pack/pricing/`（SKILL.md 正文去 harness 语法）；pricing-explorer 退役
- 五原则沿用：as_of 唯一取数口 / Decision 一等公民 / rollout 与用途解耦 / 裁决只认现实分层递降 / 一切可回放

## Environment
- Node + pnpm（dsh 侧）；Python ≥ 3.11 用项目内 .venv；macOS 开发，pod 跑批
- dsh 源码快照：调研时位于 `/private/tmp/claude-501/.../scratchpad/src/dsh`（易失）；需要时重新 clone 并 checkout `b150a551`
