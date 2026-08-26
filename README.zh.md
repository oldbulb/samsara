<p align="center"><img src="docs/assets/mark.svg" width="72" alt=""></p>
<h1 align="center">samsara</h1>

<p align="center"><strong>让 harness 自己改进自己——在它伪造不了的证据下。</strong></p>

<p align="center">
  <a href="LICENSE"><img alt="MIT" src="https://img.shields.io/badge/license-MIT-6d28d9"></a>
  <img alt="测试离线" src="https://img.shields.io/badge/tests-offline-6d28d9">
  <a href="https://github.com/deepseek-ai/deepseek-harness"><img alt="构建在 DeepSeek Harness 上" src="https://img.shields.io/badge/built%20on-DeepSeek%20Harness-0e7490"></a>
  <img alt="未发布" src="https://img.shields.io/badge/status-pre--release-b45309">
</p>

<p align="center"><a href="README.md">English</a> · 中文 · <a href="https://oldbulb.github.io/samsara/">站点</a></p>

<p align="center">
  <a href="#为什么">为什么</a> ·
  <a href="#怎么运转">怎么运转</a> ·
  <a href="#两种用法">两种用法</a> ·
  <a href="#接入你的-gate你的优化器">接入</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#状态">状态</a> ·
  <a href="#路线图">路线图</a> ·
  <a href="#包与文档">文档</a>
</p>

<br>

samsara 是 agent harness 递归自改进的底座，也是裁决"自改进"的评测台。

**每个对 harness 的改动都是一个 challenger。** 它在可处置的 scope 里求值，只凭回路之外的真值打分，只经统计门晋升，只在人经回路够不到的通道签字之后被采纳。

任何优化器都可以是 proposer，任何已发表的接受准则都可以是 gate——用任意语言写——它们全部在同一个 ledger 上留下同样的证据。

它作为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的一个 bundle 和两个 profile 运行：**`host`** 是给脚本和 CI 的命令行，**`workbench`** 是一场对话——一个 operator agent 替你跑实验。改的是 harness 不是权重——skill、prompt 段、memory、tool 配置。评测工件和三个不动点永远不是 surface。

<br>

## 为什么

2026 年年中，这个领域公开承认自己分不清信号与选择效应。harness 进化在搜索集上涨 7–10 点、held-out 上约 0（[2607.12227](https://arxiv.org/abs/2607.12227)）；有系统自曝 proxy 与 held-out 相差 31.7 点（[DarwinX](https://arxiv.org/abs/2608.07545)）；贪心的"变好就留"是不受控的自适应多重检验（[PACE](https://arxiv.org/abs/2606.08106)）；越过峰值继续迭代，78% 的运行最终比峰值更差（[RSIBench](https://arxiv.org/abs/2607.25886)）。

而五个系统用五种互不相容的口径报告一次运行，所以没人审计过这个领域被引最多的那条改进曲线。没有可审计的产物。

samsara 就是为这个缺口造的。不是又一个优化器——**记录、竞技场、不动点。**

<br>

**记录。** 谱系、碰的那一个 surface、每个 tier 的成对逐题分数、实测噪声底、gate 及参数、成本、holdout 消耗、settlement、只追加的重打分。脊梁是一个坐标元组，所以"可比"是 gate 检查的规则，不是 runner 记得的约定。

**竞技场。** 十三条已发表的接受准则作为 policy 装在 `gate-catalog` 里。`gate bench` 能把其中任何一条——或你写的一条——跑在"同一配置的重跑"上，那里每一次接受都是假阳性：

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/gate-bench-null-dark.svg">
    <img src="docs/assets/gate-bench-null-light.svg" alt="null 下各 gate 的假晋升率：keep-better 0.51、DGM 0.72、Self-Harness 0.38、RSEA 0.56、Ladder 0.20、gate-fast 0.10、gate-default 0.06、Miller 0.04；声明 α 0.05" width="720">
  </picture>
  <br>
  <sub>coding-tasks，closed-book：83 题 × 3 次同配置重跑。这些是一个 pack 上的 bootstrap 接受率，不是总体错误率。</sub>
</p>

**不动点。** 靠机器而不是靠约定，因为反例记录在案：DGM 的 agent 删掉隐藏标记拿了满分。

| | |
|:---|:---|
| 📖&nbsp;&nbsp;**book** — 真值 | 任务集、settlement、holdout 的可见性与预算 |
| ⚖️&nbsp;&nbsp;**gate** — 裁决 | 统计决定晋升；回路写不到它 |
| ✍️&nbsp;&nbsp;**sign-off** — 同意 | `0600` unix socket 上对 nonce 的 Ed25519 签名——HTTP 请求永远不算证明 |

optimizer 可以被优化。裁判和签字权不行。

<br>

## 怎么运转

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/loop-dark.svg">
    <img src="docs/assets/loop-light.svg" alt="回路：propose、run、judge、keep/drop、settle；book、gate、sign-off 在回路之外，只进不出" width="720">
  </picture>
  <br>
  <sub>propose → run → judge → keep-or-drop → settle。真值、裁决与签字只进不出。</sub>
</p>

| | |
|:---|:---|
| **pack** | 提供现实——任务、真值、评分——只经 `pack.yaml` 和它的命令的 stdout，命令永远是子进程。带三个：`coding-tasks`（四种语言的 148 道 Exercism 题，closed-book）、`synthetic`（一枚带已知偏差的硬币：注入的效应必须晋升、A/A 重跑必须不晋升——整个回路零花费跑通）、`harbor-hello`（从一个 Harbor 任务生成；`import harbor` 还能把 Harbor job 的 trial 直接落成 attempt）。 |
| **loop** | 在一个配置下跑一道题的一次 attempt：dsh 自己的 agent、Claude Code、或者装在 **environment** 里的 agent——本机目录、Docker 容器、Modal 沙箱——每种都记录实际跑的是什么。 |
| **lifecycle** | 拥有每一次状态迁移。**experiment** 预注册假设、预测和预算；**campaign** 把 round 推过 smoke、held-in、held-out；**control**（`aa` / `inject`）拿已知答案检验 gate；`calibrate` 测出 gate 计算功效所依据的噪声底。CLI、workbench、UI 是同一个 service 的三个入口。 |
| **gate** | 用配对、按 entity 聚类的统计对着噪声底裁决——当设计看不见 pack 声明的效应时，它说 `hold:underpowered`。换 gate = 一行 patch + 一次签字的 `gate change`。 |

<br>

## 两种用法

<table>
<tr>
<td width="50%" valign="top">

### `host` —— 命令行

给脚本和 CI。

`calibrate` · `experiment new` · `campaign` · `control` · `promote` · `gate bench` · `import harbor` · `serve`

每个裁决、签字、settlement 都落在 ledger 上；`serve` 只读地渲染它。

</td>
<td width="50%" valign="top">

### `workbench` —— 对话

operator agent 持有 `samsara_*` 工具，把校准、round、campaign、control 作为 job 跑。每个先报价、等一个 Allow。

`/samsara …` 命令是预注册和签字唯一发生的地方。

</td>
</tr>
</table>

两者调同一个 `lifecycle`、写同一个 ledger。agent 能读 ledger 渲染给 operator 的每个视图；它不能签字、不能改 gate、预算或预测，看不到 held-out 的逐题行，也不能做它所操作的那一轮的 proposer。

<p align="center">
  <img src="docs/img/experiment-dark.png" alt="experiment 页：假设与预测、预算、带晋升裁决和每个影子 gate 一列的 round 表、谱系曲线" width="720">
  <br>
  <sub>experiment 页：假设、预算、每个影子 gate 一列的 round 表、谱系曲线。每页有一个 <code>.json</code> 孪生，指名它的数字来自哪些行。</sub>
</p>

<br>

## 接入你的 gate、你的优化器

两者都是任意语言的程序。

**gate** 从 stdin 读一份比较请求——按 entity 配对的逐题值、噪声底、policy、本轮的 `k`/`index`、seed——向 stdout 写 verdict 和完整的 `Compare`。

```python
# 一个 gate —— examples/gates/keep_better.py，节选
req = json.load(sys.stdin)
pairs = pair(req["champion"], req["challenger"])         # 按 (taskId, sample) 配对
mean = sum(c - a for a, c in pairs) / len(pairs)
print(json.dumps({"verdict": "promote" if mean > 0 else "hold",
                  "compare": compare_of(pairs, mean)}))
```

**proposer** 读一个 view 目录——champion 的 skill、held-in 任务与结果、held-out 聚合、`environment.md`——写出 `proposal.json` 和 patch。

```python
# 一个 proposer —— sdk/py（TypeScript：@oldbulb/samsara-proposer-sdk）
view = load_view(args.view)
skill = improve(view.champion_skill_dir, view.champion_scores)   # 你的优化器
write_proposal(args.out,
    Proposal(parent=view.champion_id, surface="skill", intent="…",
             prediction={"metric": view.metric, "direction": "up"}),
    skill_dir=skill)
```

> [!TIP]
> 信任 gate 之前先测它，花钱之前先 dry-run proposer——都是一条命令，都不碰模型。

```sh
dsh --profile host gate bench --attempts noise.jsonl \
    --tasks packs/coding-tasks/tasks/holdin.jsonl --metric pass_rate \
    --gates default,keep-better,pace --gate-command ./my_gate.py

dsh --profile host propose --pack packs/coding-tasks --proposer ./my_optimizer.py \
    --set holdin --limit 8 --metric pass_rate --dry-run
```

契约：[`examples/gates/`](examples/gates/README.md) · [`examples/proposers/`](examples/proposers/README.md)。loop 和 environment 由我们来写——它们要求懂那个 harness。

<br>

## 快速开始

Node ≥ 22.19、pnpm 11.7、dsh CLI。

> [!NOTE]
> 包还没上 npm。在那之前，profile 就是检出里的 `profiles/host`，链接进 dsh 的 profile 目录——上架后安装路径是 `dsh plugin --profile host add @oldbulb/samsara`。

```sh
npm i -g @deepseek-ai/dsh@0.1.1-rc.2
cd "$(npm root -g)/@deepseek-ai/dsh" \
    && npm i @deepseek-ai/dsh-storage-sqlite@0.1.1-rc.2      # ledger 的 sqlite，装进 CLI

git clone https://github.com/oldbulb/samsara.git && cd samsara
pnpm install && pnpm build
mkdir -p ~/.dsh/profiles && ln -s "$PWD/profiles/host" ~/.dsh/profiles/host
dsh plugin --profile host install
dsh --profile host --dump-config | grep samsara
```

然后在 synthetic pack 上零花费闭合整个回路：噪声底、预注册的 experiment、必须不晋升的 A/A 对照、必须晋升的注入效应、采纳它的那个签名。

```sh
# 签字人的密钥；只有公钥进主机
node packages/signoff/lib/cli.js keygen --out ~/.samsara/signoff
mkdir -p data/signoff && cp ~/.samsara/signoff/signoff.pub data/signoff/

# 噪声底、主张、对照
dsh --profile host calibrate --pack packs/synthetic --loop null --set holdin \
    --reruns 5 --metric pass_rate --out data/runs/cal
dsh --profile host experiment new --pack packs/synthetic \
    --hypothesis "effect 0.15 promotes" --metric pass_rate --magnitude 0.15 --budget-rounds 3
dsh --profile host control aa --pack packs/synthetic --loop null --metric pass_rate      # → hold

# campaign：一轮轮跑到晋升，晋升等待签字
dsh --profile host campaign --pack packs/synthetic --loop null --experiment <id> \
    --proposer effect-15 --metric pass_rate --set holdin --rounds 3 \
    --holdout-repeat 6 --auto-holdout --stop-on-promote --wait 600                       # → promote
node packages/signoff/lib/cli.js confirm --socket data/signoff.sock \
    --key ~/.samsara/signoff/signoff.key --row <challengerId> --action promote --who <name>
dsh --profile host status
```

`tests/synthetic.e2e.test.ts` 每次 `pnpm test` 都跑这一串。workbench 同理，链接 `profiles/workbench`。

<details>
<summary><b>更多</b>——接真实模型、真实 pack、完整命令表</summary>
<br>

部署事实——网关 URL 和凭据的*引用*，永远不是秘密——写进 `profiles/host/cordis.patch.yml`（从 `.example.yml` 抄；gitignored，champion 晋升时会重写它）。Claude Code loop 默认关：它需要专有的 `@anthropic-ai/claude-agent-sdk`，是 optional peer。`packs/coding-tasks/runtime/provision.sh` 一次装齐该 pack 的四个 runtime；有两个测试会真跑它。

```sh
dsh --profile host run --pack packs/coding-tasks --loop dsh --set holdin \
    --limit 32 --parallel 16 --out data/runs/x
dsh --profile host run --resume data/runs/x            # durable step：只重跑没有 marker 的 attempt

dsh --profile host challenge --pack packs/coding-tasks --loop dsh --set holdin \
    --surface skill --skill-dir <dir> --intent "..." --metric pass_rate --with-champion
dsh --profile host round --pack packs/coding-tasks --loop dsh --proposer claude-p \
    --set smoke --limit 2 --metric pass_rate --with-champion
dsh --profile host certify --pack packs/coding-tasks --skill-dir <dir> \
    --loops dsh,claude-code --set smoke --metric pass_rate

dsh --profile host import harbor <jobDir> --pack <dir> --as noise-floor --metric reward
dsh --profile host gate change keep-better@0.1.0 --wait 600     # 一条 gate 要先有签字同意才能用于晋升
dsh --profile host ledger backup --out backups/ledger.sqlite
dsh --profile host export --run data/runs/x --format otlp-json --out data/runs/x.otlp.json
dsh --profile host serve                                        # 只读页面，在它打印的回环地址上
```

ledger 路径相对于工作目录（`<cwd>/data/ledger/samsara_ledger.sqlite`）。噪声底属于一个 champion 行，晋升之后先 `calibrate` 再跑下一轮。

</details>

<br>

## 状态

1.0 之前，且如实说。回路在 synthetic 对照上端到端闭合；两条真实模型的 loop 跑通 coding pack；gate 在实测噪声底上校准过。

> **校准，连同它的边界。** coding-tasks，closed-book，83 题 × 3 次重跑：`gate-default` 把"同一配置的重跑"判成晋升的概率是 6%，声明 5%；6 对真实重跑上 0/6。keep-better 是 51%，DGM 的规则 72–100%。held-out tier 的 29 个 entity 上，bootstrap 约为标称的 1.5 倍。

> [!IMPORTANT]
> **真实 pack 上还没有一次晋升。** coding-tasks 在 3 次重跑下能检出约 0.14 pass rate，而它声明的 SESOI 是 0.05，所以每次真实比较都以 `hold:underpowered` 结束——性质上对，事实上未被证伪。对照只在 synthetic 硬币上成立。这是路线图的第一项。

老实说还没有的：

- **coding-tasks 的真值部分自评**：agent 自己写的测试和隐藏测试一起计数（`solved` 不受影响）。
- **延迟真值没有消费者**，`live` tier（mSPRT）没做。
- Landlock 只在 Linux 上生效；macOS 上 proposer 进程未受限。

<br>

## 路线图

按"什么会让 gate 值得信任"、再"什么会让它值得采用"排序。

### 现在

- [ ] 真实 pack 上的正面对照——靠重跑或 Harbor 派生的题集让 n × R 够到 SESOI——第一次签字晋升一个真实 skill
- [ ] 修 `coding-tasks` 的自评真值：只跑恢复的隐藏测试
- [ ] `pnpm bench`：本页的数字和图从已提交的 fixture 重新生成，进 CI
- [ ] `PROTOCOL.md` v1，发布 JSON schema，pack / gate / proposer 的合规检查

### 接下来

- [ ] 第二个真实 pack 和第三条 loop（Codex），让抽象被不止一侧检验
- [ ] 已发表的优化器作为 proposer——GEPA、RSIHub 的 recipe——互为正面对照
- [ ] 保留规则作为校准过的 gate 规则（HCL 的 harness-level forgetting），与 SESOI 检验并列
- [ ] 一个 skill 和 `llms.txt`，让 agent 能从 Claude Code、Codex 或 dsh 操作 samsara；`ops/install.sh` 和 `doctor`
- [ ] 开 Discussions、加 topics、发 `v0.1.0-rc`；dsh 离开 rc 后上 npm

### 之后

- [ ] 一个真值迟到的 pack——git：一周后的 merge、revert、CI——驱动 settlement 和活的 champion
- [ ] `live` tier：真实流量上的交错分配 + anytime-valid 检验
- [ ] optimizer 配置作为慢时标 surface——递归真正的入口
- [ ] 带采纳与 settlement 标签的轨迹，作为训练导出

<br>

## 包与文档

<sub>`kernel`（唯一的 dsh 导入者）· `pack` `book` · `loops` `loops-dsh` `loops-claude-code` `environments` · `workdir` `submit` `sandbox` `scope` · `gate` `gate-catalog` `ledger` `lifecycle` · `champion` `signoff` · `proposers` `proposer-sdk`（+ `sdk/py`）· `runner` `ui` `workbench` · `examples/`</sub>

| | |
|:---|:---|
| [`philosophy.md`](docs/design/philosophy.md) | 为什么三个不动点在回路之外，以及哪些话刻意不说 |
| [`architecture.md`](docs/design/architecture.md) | seam、surface、坐标与可比性、ledger 模型、生命周期、E1–E8 / S1–S8 |
| [`workbench.md`](docs/design/workbench.md) | 两个 profile、operator agent、工具、命令、同意/批准之分 |
| [`gate.md`](docs/design/gate.md) · [`loops.md`](docs/design/loops.md) · [`proposers.md`](docs/design/proposers.md) · [`packs.md`](docs/design/packs.md) | 各条缝的细节 |
| [`gate-catalog`](packages/gate-catalog/README.md) | 十三条接受准则、出处、各自声称什么 |
| [`dsh-plugin-notes.md`](docs/dsh-plugin-notes.md) | 在 dsh 上写插件：心智模型、坑、模式 |

<br>

## 参与与许可

[`CONTRIBUTING.md`](CONTRIBUTING.md)——什么合适、怎么搭环境、房规、以及作为全部协议的 DCO 签字。
[`SECURITY.md`](SECURITY.md) · [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md) · [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

MIT——见 [`LICENSE`](LICENSE)。
