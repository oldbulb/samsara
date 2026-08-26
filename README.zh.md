<h1 align="center">samsara</h1>

<p align="center"><strong>让 harness 自己改进自己——在它伪造不了的证据下。</strong></p>

<p align="center">
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-6d28d9"></a>
  <img alt="测试离线" src="https://img.shields.io/badge/tests-offline-6d28d9">
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="构建在 DeepSeek Harness 上" src="https://img.shields.io/badge/built%20on-DeepSeek%20Harness-0e7490"></a>
  <img alt="未发布" src="https://img.shields.io/badge/status-pre--release-b45309">
</p>

<p align="center"><a href="README.md">English</a> · 中文 · <a href="https://oldbulb.github.io/samsara/">站点</a></p>

agent harness 的递归自改进（RSI）框架，跑在 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 上——dsh 提供内核：可处置的 scope、service、storage、jobs、子进程。但凡跨进程边界的东西（pack 契约、ledger 行、gate policy、proposer 契约、训练导出）都不含 dsh 类型、也不要求 dsh：loop 是一个 seam，dsh 自带的 agent 只是四个预期 provider 之一。

**每个对 harness 的改动都是一个 challenger。** 它在可处置的子 scope 里求值，只凭回路之外的真值被裁决，只经统计门晋升为 champion，只在人经回路够不到的通道签字之后被采纳。

改的是 harness 不是权重：v1 开放四个 surface——skill、prompt 段、memory、tool 配置。评测工件与三个不动点永远不是 surface。

## 为什么做这个

2026 年年中，held-out 划分已经从主张变成默认，而这个领域公开承认自己分不清信号与选择效应：harness 进化在搜索集上涨 7–10 点，在 held-out 上约等于 0（[2607.12227](https://arxiv.org/abs/2607.12227)）；有系统自曝 proxy 与 held-out 相差 31.7 点（[DarwinX](https://arxiv.org/abs/2608.07545)）；贪心的"变好就留"是不受控的自适应多重检验，会提交根本不存在的改进（[PACE](https://arxiv.org/abs/2606.08106)）；越过峰值继续迭代，78% 的运行最终**比自己的最好成绩更差**（[RSIBench](https://arxiv.org/abs/2607.25886)）。

与此同时，五个系统用五种互不相容的口径报告一次自改进运行，两次运行无法比较——这正是为什么在 192 篇引用里，没有任何人审计过这个领域被引最多的那条改进曲线：**没有可审计的产物。**

samsara 就是为这个缺口造的。不是又一个优化器，而是**记录、竞技场、不动点**三件事：

- **记录**——challenger 的谱系、它碰的那一个 surface、每个 tier 的成对逐任务分数、实测噪声底、gate policy 及其参数、holdout 消耗、成本、settlement、只追加的重打分。它的脊梁是一个**坐标元组**：任何能动分数的量都是一个具名坐标，challenger 的 id 是元组的哈希，"可比"是 gate 检查的规则，不是 runner 记得的约定。
- **竞技场**——机制固定、策略可换，于是每一条已发表的接受准则都是插件而不是对手。`gate-catalog` 带了十三条：keep-better、DGM 的 `keep_better`、Self-Harness、RSEA、Ladder、Miller、McNemar、PACE 的 e-process、HCL 的 commit 规则、AutoScientists 的噪声底、`gate-default`……`gate bench` 能把其中任何一条、或者你用任何语言写的一条，跑在"同一配置的重跑"上——那里每一次接受按构造都是假阳性。论文做不出这张表，只有带 ledger 的框架能。
- **不动点**——靠机器而不是靠约定：DGM 的 agent 删掉隐藏标记拿了满分，这是记录在案的。

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/gate-bench-null-dark.svg">
    <img src="docs/assets/gate-bench-null-light.svg" alt="null 下各 gate 的假晋升率：keep-better 0.51、DGM 0.72、Self-Harness 0.38、RSEA 0.56、Ladder 0.20、gate-fast 0.10、gate-default 0.06、Miller 0.04；声明 α 0.05" width="720">
  </picture>
</p>

仍然空着、也是 champion 必须能死的理由：这个领域的每一个 benchmark 都是即时验证的。samsara 是为"真值下个月才到、而且以后还会被修订"造的——这部分机器已实现，但目前诚实地说没有消费者（见"状态"）。

## 三个不动点

samsara 里一切可换，除了三样东西——它们按构造在回路之外：

| | |
|:---|:---|
| 📖&nbsp;&nbsp;**book** — 真值 | 任务集、settlement、holdout 的可见性与预算 |
| ⚖️&nbsp;&nbsp;**gate** — 裁决 | 统计决定晋升；回路写不到它 |
| ✍️&nbsp;&nbsp;**sign-off** — 同意 | `0600` unix socket 上对 nonce 的 Ed25519 签名——HTTP 请求永远不算证明 |

optimizer 自己可以被优化。裁判和签字权不行。

机制固定、策略可换：统计检验、优化算法、评测逻辑、签字通道都是插件，默认严格，ledger 记着每个裁决是谁做的。

## 一轮怎么跑

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/loop-dark.svg">
    <img src="docs/assets/loop-light.svg" alt="回路：propose、run、judge、keep/drop、settle；book、gate、sign-off 在回路之外，只进不出" width="720">
  </picture>
</p>

**pack** 提供现实：任务、真值、评分。框架不认识任何领域——它只经 `pack.yaml` 和 pack 命令的 stdout 与之通信，命令永远是子进程、从不 import。树内带两个：`packs/coding-tasks`（Aider Polyglot 的 148 道 Exercism 题：Python、JavaScript、Rust、Go；closed-book，测试对 agent 隐藏），以及 `packs/synthetic`——一枚偏置已知的硬币，作为对照：整条管线零成本跑通，注入效应必须晋升，A/A 重跑必须不晋升。

**loop** 是一个配置在一道题上的一次 attempt。带两条：dsh 自己的进程内 agent，和作为子进程的 Claude Code。加第三条 = 一个包 + patch 文件里一行。

Claude Code loop **默认关**：它需要专有的 `@anthropic-ai/claude-agent-sdk`，所以是 optional peer，那一行 `disabled: true`。装进 profile 再翻开那一行即可；框架其余部分不碰它。

## 接入你的 gate、你的 optimizer

研究者会带来东西的两条缝，都是任意语言的程序。

**gate** 从 stdin 读一份比较请求——按 (taskId, sample) 配对的逐题值与 entity、实测噪声底、policy、本轮的 `k`/`index`、seed——向 stdout 写 verdict 和完整的 `Compare`：

```python
#!/usr/bin/env python3          # examples/gates/keep_better.py，节选
import json, sys
req = json.load(sys.stdin)
pairs = pair(req["champion"], req["challenger"])
mean = sum(c - a for a, c in pairs) / len(pairs)
print(json.dumps({"verdict": "promote" if mean > 0 else "hold", "compare": compare_of(pairs, mean)}))
```

```sh
# 它会把"同一配置的重跑"当成改进的概率是多少？（在 `calibrate` 录下的重跑上做 bootstrap——
# 每个重跑目录一份 attempts.jsonl：cat data/runs/noise/calibrate-*/attempts.jsonl > data/runs/noise.jsonl）
dsh --profile host gate bench --attempts data/runs/noise.jsonl \
    --tasks packs/coding-tasks/tasks/holdin.jsonl --metric pass_rate \
    --gates default,keep-better,pace,miller --gate-command ./my_gate.py --out bench.json
# 挂上去：一行 —— { id: gate-mine, name: '@oldbulb/samsara-gate/plugin-command', config: { command: ./my_gate.py, name: mine, version: 0.1.0 } }
```

**proposer** 读一个 view 目录（champion 的 skill、held-in 任务、champion 的逐题结果、held-out 的聚合、`environment.md`），写出 `proposal.json` 和 patch：

```python
from samsara_proposer import load_view, Proposal, write_proposal, parse_args   # sdk/py
args = parse_args()
view = load_view(args.view)
skill = improve(view.champion_skill_dir, view.champion_scores)               # 你的优化器
write_proposal(args.out, Proposal(parent=view.champion_id, surface="skill",
    intent="…", prediction={"metric": view.metric, "direction": "up"}), skill_dir=skill)
```

```sh
# 渲染 view、跑它、校验并 diff-scan 提案——不开 scope、不跑 attempt、不花钱
dsh --profile host propose --pack packs/coding-tasks --proposer ./my_optimizer.py \
    --set holdin --limit 8 --metric pass_rate --dry-run
```

SDK 有 TypeScript（`@oldbulb/samsara-proposer-sdk`）和 Python（`sdk/py`）两份；契约写在 [`examples/gates/`](examples/gates/README.md) 与 [`examples/proposers/`](examples/proposers/README.md)。loop——一个 harness 怎么跑一次 attempt——由我们来写，因为它要求懂那个 harness。

## 安装

samsara 是一个 dsh bundle 加一个 profile。需要 dsh CLI、Node ≥ 22.19、pnpm 11.7。包还没有发到 npm（发了之后 `dsh plugin --profile host add @oldbulb/samsara` 就是安装路径），所以现在从检出安装：仓库里的 `profiles/host` 就是 host profile，链接进 dsh 的 profile 目录。

```sh
npm i -g @deepseek-ai/dsh@0.1.1-rc.2
# ledger 用 sqlite，CLI 不自带——装进 CLI 目录，不要装进 profile（profile 里的第二份 dsh-storage 会遮住 CLI 自己的）
cd "$(npm root -g)/@deepseek-ai/dsh" && npm i @deepseek-ai/dsh-storage-sqlite@0.1.1-rc.2

git clone https://github.com/oldbulb/samsara.git && cd samsara
pnpm install && pnpm build
ops/leak-scan.sh                           # 框架不得认识任何领域

# profile：dsh 读 $DSH_HOME/profiles/<name>（默认 ~/.dsh）。没有这个链接，`install` 会在那里静默初始化一个只有 dsh-base 的空 profile
mkdir -p ~/.dsh/profiles && ln -s "$PWD/profiles/host" ~/.dsh/profiles/host
dsh plugin --profile host install          # 把检出的包链接进 profile
dsh --profile host --dump-config | grep samsara     # 合成树里应列出它的行
```

然后把部署事实——网关 URL 和凭据的*引用*（永远不是秘密）——从 [`profiles/host/cordis.patch.example.yml`](profiles/host/cordis.patch.example.yml) 抄到 `profiles/host/cordis.patch.yml`（gitignored：它是这次部署的状态，champion 晋升时会改写它）。

测试全部离线——不调模型、不连网关——但其中两个真的驱动 coding-tasks pack，需要它的 runtime（pytest、jest、go、cargo）：

```sh
packs/coding-tasks/runtime/provision.sh    # 一次；唯一碰网络的步骤（Go 和 Rust 装在 runtime/ 下）
pnpm test
```

## 怎么跑

<details open>
<summary><strong>零成本的第一次：在 synthetic pack 上闭合回路</strong></summary>

`packs/synthetic` 是一枚答案已知的偏置硬币，所以整条生命周期——噪声底、预注册的 experiment、走过 smoke / held-in / held-out 的各轮、gate、签字、晋升——都在 null loop 上跑，不调模型。先给 `loops-null` 一个固定提交、把 pack 自带的 proposer 按两个效应各挂一行（profile 里的行见 [`packs/synthetic/README.md`](packs/synthetic/README.md)），然后：

```sh
# 签字方的 key，在 host 启动之前：只把 signoff.pub 拷到 data/signoff/（私钥若与公钥并排放在 host 上，host 会拒绝所有 proof，E2）
node packages/signoff/lib/cli.js keygen --out ~/.samsara/signoff && mkdir -p data/signoff && cp ~/.samsara/signoff/signoff.pub data/signoff/
# 噪声底：champion 在 held-in 集上同配置重跑五次  → sd_paired ≈ 0.18
dsh --profile host calibrate --pack packs/synthetic --loop null --set holdin --reruns 5 --metric pass_rate --parallel 8 --out data/runs/syn-cal
# 先做 A/A 对照：null diff（proposer effect-0）在它自己预注册的主张之下——一轮又一轮不晋升
# （有功效的 holdout 检验会以 indistinguishable 判 drop，S8）；这里若晋升就是假阳性
dsh --profile host experiment new --pack packs/synthetic --hypothesis "the null diff does not promote" --metric pass_rate --budget-rounds 3
dsh --profile host campaign --pack packs/synthetic --loop null --experiment <id> --proposer effect-0 --metric pass_rate \
    --set holdin --parallel 8 --rounds 3 --holdout-repeat 6 --auto-holdout --out data/runs/syn-aa   # → hold，三次
# 先注册主张、预算和将要裁决它的 gate，再花任何钱 → 打印 experiment id
dsh --profile host experiment new --pack packs/synthetic --hypothesis "effect 0.15 promotes" --metric pass_rate --magnitude 0.15 --budget-rounds 3
# 在它之下跑轮：proposer → smoke → held-in 筛选 → held-out 六次复制的检验 → 决定；晋升等待签字
dsh --profile host campaign --pack packs/synthetic --loop null --experiment <id> --proposer effect-15 --metric pass_rate \
    --set holdin --parallel 8 --rounds 3 --holdout-repeat 6 --auto-holdout --stop-on-promote --wait 600 --out data/runs/syn-inject   # → promote
#   … 在另一个 shell 里，用留在签字方的私钥签字：
#   node packages/signoff/lib/cli.js confirm --socket data/signoff.sock --key ~/.samsara/signoff/signoff.key --row <challengerId> --action promote --who <name>
dsh --profile host status
```

噪声底属于一行 champion：晋升之后先重新 `calibrate` 再跑任何一轮（在旧噪声底上的 campaign 会以 `no_noise_floor` 停下），而此时 `effect-0` 是相对新 champion 的 −0.15 challenger，不再是 null diff。

`tests/synthetic.e2e.test.ts` 在每次 `pnpm test` 里进程内跑这一序列。

</details>

<details>
<summary><strong>从 null loop 到签字晋升的每一条命令</strong></summary>

```sh
# attempts——null loop 完全不调模型
dsh --profile host run --pack packs/coding-tasks --loop null --set smoke --limit 2 --out data/runs/x

# 一个 challenger 走完整链路：diff scan → scope → attempts → gate → ledger
dsh --profile host challenge --pack packs/coding-tasks --loop null --set holdin --limit 2 \
    --surface skill --skill-dir <dir> --intent "..." --metric pass_rate --with-champion

# 一轮：proposer 写 challenger，然后同一条管线
dsh --profile host round --pack packs/coding-tasks --loop dsh --proposer claude-p \
    --set smoke --limit 2 --metric pass_rate --with-champion

# 只跑 proposer、不花钱：渲染 view、跑它、校验并 diff-scan 提案
dsh --profile host propose --pack packs/coding-tasks --proposer ./examples/proposers/noop.py \
    --set smoke --limit 2 --metric pass_rate --dry-run

# 每条 gate 把"同一 champion 的重跑"判成晋升的频率（在录好的重跑上 bootstrap：
# `calibrate` 每个重跑目录写一份 attempts.jsonl，bench 要它们合在一个文件里）
cat data/runs/noise/calibrate-*/attempts.jsonl > data/runs/noise.jsonl
dsh --profile host gate bench --attempts data/runs/noise.jsonl --tasks packs/coding-tasks/tasks/holdin.jsonl \
    --metric pass_rate --gates default,keep-better,miller --out bench.json

# 晋升需要签字，走 unix socket
node packages/signoff/lib/cli.js keygen --out ~/.samsara/signoff && mkdir -p data/signoff && cp ~/.samsara/signoff/signoff.pub data/signoff/
dsh --profile host promote <challengerId> --wait 60 &
node packages/signoff/lib/cli.js confirm --socket data/signoff.sock \
    --key ~/.samsara/signoff/signoff.key --row <challengerId> --action promote --who <name>
dsh --profile host ledger backup --out backups/ledger.sqlite   # host 运行中的一致快照（E6）

dsh --profile host serve      # 只读的 /samsara 页：experiment、round、challenger、serving、bench
dsh --profile host certify --pack packs/coding-tasks --skill-dir <dir> --loops dsh,claude-code \
    --set smoke --limit 2 --metric pass_rate      # 这个 skill 跨 harness 还成立吗？

dsh --profile host run --pack packs/coding-tasks --loop dsh --set holdin --limit 32 --parallel 16 --out data/runs/x
dsh --profile host run --resume data/runs/x       # durable step：只重跑没有 marker 的 attempt
dsh --profile host export --run data/runs/x --format otlp-json --out data/runs/x.otlp.json
```

</details>

> ledger 路径相对于工作目录（`<cwd>/data/ledger/samsara_ledger.sqlite`），所以在仓库根跑的每一次 `run` 都写进那一个真实 ledger。试东西请换个目录跑。

## 包

以 `@oldbulb` scope 发布；bundle 是 `@oldbulb/samsara`，一个概念一个包。

| | |
|---|---|
| `kernel` | 唯一按路径 import dsh 的包——重新 pin dsh 是一个文件的事 |
| `pack` · `book` | pack 契约，以及真值：任务集、settlement、holdout 预算 |
| `loops` · `loops-dsh` · `loops-claude-code` | loop 这条缝和它的两个 provider |
| `workdir` · `submit` · `sandbox` · `scope` | 密封的 attempt 目录、submit 工具、文件系统策略、带 diff scan 的可处置 scope |
| `gate` · `gate-catalog` · `ledger` | 裁决这条缝（`gate-default` 与子进程 gate）、十三条已发表接受准则加 bench、只追加的记录 |
| `champion` · `signoff` | 作为内容寻址别名的被服务配置，以及同意的证明 |
| `proposers` · `proposer-sdk` · `runner` · `ui` | 提案适配器（claude-p、human、任意命令）、proposer SDK（TypeScript；Python 在 `sdk/py`）、命令、只读页面 |
| `workbench` | operator preset、`samsara_*` 工具、`/samsara …` 命令、notebook：把 dsh 变成跑实验的台子 |
| `examples/` | 一个 gate、两个 proposer，纯标准库 Python，附完整契约 |

## 文档

| | |
|---|---|
| [`docs/design/philosophy.md`](docs/design/philosophy.md) | 为什么三个不动点在回路之外、由此推出什么、以及哪些话刻意不说 |
| [`docs/design/architecture.md`](docs/design/architecture.md) | 布局、seam、13 个 surface、pack 契约、坐标与可比性、ledger 数据模型、生命周期、硬约束 E1–E8 / S1–S8 |
| [`docs/design/packs.md`](docs/design/packs.md) | pack 契约，以及第二个 pack 需要什么 |
| [`docs/design/gate.md`](docs/design/gate.md) · [`loops.md`](docs/design/loops.md) · [`proposers.md`](docs/design/proposers.md) | 三条缝的细节 |
| [`docs/design/workbench.md`](docs/design/workbench.md) | workbench：两个 profile、operator agent、工具与命令、consent/approval 的分野 |
| [`packages/gate-catalog/README.md`](packages/gate-catalog/README.md) | 十三条接受准则、出处、各自的第一类错误声明 |
| [`docs/dsh-plugin-notes.md`](docs/dsh-plugin-notes.md) | 在 dsh 上写插件：心智模型、踩过的坑、验证过的模式 |

## 状态

1.0 之前，且如实说。两条 loop 在 Aider Polyglot 上跑通；gate、ledger、scope、sign-off、champion、proposer 端到端验证；真实的 `claude -p` 提案一轮已跑通。

gate 的校准，连同它的边界：在 closed-book pack 上（83 题、43 个 entity、3 次同配置重跑；配对 sd 0.36，40% 的题在重跑间翻转），`gate-default` 的检验把"同一配置的重跑"判成晋升的概率是 6%（声明 5%），6 对真实重跑上 0/6；keep-better 是 51%，DGM 的规则 72–100%。在 held-out tier 的 29 个 entity 上，bootstrap 约为标称 α 的 1.5 倍。数字与方法见 `packages/gate-catalog/README.md`。

已知局限，按重要性：

- **gate 从未在真实 pack 上晋升过任何东西。** coding-tasks 能检出的效应（3 次重跑下约 0.14 pass rate）高于它声明的 SESOI（0.05），所以每次真实比较都以 `hold:underpowered` 结束——在性质上是正确答案。对照只存在于 synthetic 硬币上：注入效应晋升、null diff 保持 hold，走的是同一条生命周期。在一个 n × R 够到 SESOI 的真实题集上做一次正面对照，是接下来最要紧的事。
- **pack 的真值部分自评**（未修）：测试运行器把 agent 自己写的测试和恢复的隐藏测试一起计数，`pass_rate` 可以在没有任何隐藏测试通过的情况下变动；`solved`（全部隐藏测试）不受影响。
- **延迟真值没有消费者。** pending 真值、settlement、祖先重打分已实现并有测试；树内没有 pack 驱动它们。
- `live` tier（生产流量上的 mSPRT）未实现。
- Landlock 只在 Linux 上生效：macOS 上文件系统策略只记录不执行，proposer 进程未受限。
- SIGINT 可能丢少量 ledger 写入；`attempts.jsonl` 完整，`run --resume` 可从它重建。

## Workbench

底座的第二个消费者是一个地方，不是一个 pack：**把 dsh 变成跑 RSI 实验的台子**。你跟 dsh 说话；operator agent 经 `samsara_*` 工具驱动 samsara；对话就是实验笔记本，镜像进 ledger；`/samsara …` 命令是预注册与签字唯一发生的地方；ledger 是记录。它是第二个 profile `workbench`（`dsh-base` + `dsh-web-app` + `@oldbulb/samsara` + `@oldbulb/samsara-workbench`），与保留 CLI 供脚本和 CI 用的 `host` profile 并列；两者调同一个 `lifecycle` service、写同一个 ledger。agent 能读 ledger 渲染给 operator 的每个视图，能发起校准、一轮、一次 campaign 或一次对照——每个都先报价、等一次 Allow，再作为它自己拥有的 job 跑；它不能签字，不能改 gate、预算或预测，不能揭开 held-out，看不到 held-out 的逐题行，也不能做它所操作那一轮的 proposer。

```sh
# 从检出安装，与 `host` 一样：profiles/workbench 就是这个 profile——先链接，再 install
ln -s "$PWD/profiles/workbench" ~/.dsh/profiles/workbench && dsh plugin --profile workbench install
dsh --profile workbench --dump-config | grep workbench-
```

[`docs/design/workbench.md`](docs/design/workbench.md)——两个 profile、viewer、工具与命令、consent/approval 的分野、agent 不能做什么。[`packages/workbench/README.md`](packages/workbench/README.md)——安装与一段示例对话。

## 参与与许可

[`CONTRIBUTING.md`](CONTRIBUTING.md)——什么合适、怎么搭环境、房规、以及作为全部协议的 DCO 签字。
[`SECURITY.md`](SECURITY.md) · [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) · [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

MIT——见 [`LICENSE`](LICENSE)。
