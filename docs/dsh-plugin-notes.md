# 在 dsh 上写插件：一份实战工程记录

> 面向已有 TS/Node 经验、没碰过 cordis/dsh 的工程师。不是 API 文档（dsh 自带），是我们从 0 到一个 18 包 bundle 跑起来路上踩的坑、验证过的模式、和事情该按什么顺序做。
>
> 样本：samsara（本仓库），46 个 commit，18 个包，~9500 行 TS，40 个测试文件 / 273 个离线测试全绿（`pnpm test`，2026-08-24 复跑）。dsh 钉 `b150a551` = npm `@deepseek-ai/dsh@0.1.1-rc.2`，源码检出在 `../deepseek-harness`。
>
> 引用约定：`packages/...` 是 samsara 本仓库；`vendor/...`、`apps/...`、`packages/core/...` 等带 dsh 目录特征的路径是 dsh 检出。行号对应上述 pin。标 **UNVERIFIED** 的是没能在源码里坐实的。

---

## 结论先行（如果只读十行）

1. **插件 = patch 文件里的一行。** 你的心智模型不该是"我 import 了一个库"，而是"我往一棵配置树里插了一行 `{id, name, config, inject}`"。替换实现 = 改那一行的 `name`；关掉 = `disabled: true`。整个设计的可替换性来自这里，不需要自造插件机制。
2. **dsh 只从一个包进来。** 我们用 `packages/kernel`（94 行）做唯一入口，其余 17 个包不出现任何 `@deepseek-ai/*` 路径。re-pin 是一个文件的事——这是回报最高的一条纪律。
3. **一半的坑在"装"和"启动"，不在代码里。** CLI 装法、profile 的 `pnpm-workspace.yaml`、跟 `dsh-web-app` 抢命令行、启动退出竞态——这几条加起来吃掉的时间比写 loop provider 还多。
4. **`ctx.effect` 是唯一的资源纪律。** 路由、注册、定时器、storage domain、子进程句柄，全部包进 `ctx.effect`，否则 dispose 之后它们还活着。
5. **先把无 key 回放测试跑通，再谈别的。** `dsh-llm-replay` + 一次真实录制 = 一条完整的端到端回归，CI 里不花一分钱。

---

## A. 心智模型

### A.1 cordis：Context / Service / Fiber / effect

dsh 的内核是 vendored 的 cordis（`vendor/cordis/`），重新以 `@deepseek-ai/cordis*` 发布，就是为了让外部插件能 peer-depend 它。四个词：

| 词 | 是什么 | 关键事实 |
|---|---|---|
| **Context** | 依赖注入的句柄。`ctx.tools`、`ctx.agents`、`ctx.webServer` 都是它上面的属性 | 属性访问走 Proxy；没在 `inject` 里声明就取，抛 `cannot get property "<x>" without inject`（`vendor/cordis/src/reflect.ts:144`） |
| **Service** | 占用一个 `ctx.<key>` 的类 | `class X extends Service { constructor(ctx) { super(ctx, 'x') } }` → 全树可见 `ctx.x` |
| **Fiber** | 一个已加载插件实例的运行时句柄 | 子 scope 就是父 fiber 上的一个 effect（`vendor/cordis/src/fiber.ts:265`）。`fiber.dispose()` 递归卸载子插件并 **await 到静默** |
| **effect** | 副作用登记 | `ctx.effect(() => { …; return disposer }, 'label')`；卸载时 **逆序** 执行。多个异步 disposer **并发**跑——有顺序依赖的清理必须写在同一个 disposer 里 |

**"系统状态 = 已启用插件集合"这条不变量是真的，前提是每一个副作用都过 `ctx.effect`。** 这不是风格建议，是可处置性的全部来源。

一个反直觉但重要的细节：`inject` 守卫只在**插件 fiber 内部**生效。在裸 `new Context()` 上（fiber 没有 runtime）读服务会走 `ctx.reflect.get(prop, false)` 直接返回（`reflect.ts:155`）——所以测试里 `context.webServer.port` 能直接读，生产插件里同样写法会炸。

### A.2 dsh：loader / entry / patch / profile / bundle

dsh 在 cordis 上加了一层"配置即系统"的装配：

```
空 root
  ← bundle A 的 cordis.patch.yml          （dsh.profile.bundles 顺序）
  ← bundle B 的 cordis.patch.yml
  ← <profile>/cordis.patch.yml            （你的部署事实）
  ← $DSH_HOME/cordis.patch.yml            （机器级）
  ← --patch <file> 覆盖层                  （一次性：测试、录制）
  = 一个 EntryOptions[]，loader 逐行 mount
```

- **entry**：`{id, name, config, inject?, disabled?}`。`name` 是模块说明符，loader 去 import 它；`id` 是稳定身份，没有 `id` 的行每次读都拿到随机 id，任何配置编辑都被当成"删了再加"。
- **patch**：`PatchOptions[]`，两种形态——`{id, ...overrides}` 定点改一行，`{insert: [...]}` 追加若干行（`{id, insert}` 可以插进某个 group）。
- **bundle**：一个 npm 包，`package.json` 里写 `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`。它是**可复用的一层**。
- **profile**：`$DSH_HOME/profiles/<name>/` 目录，`package.json` 里 `dsh.profile.bundles` 列出要叠哪些 bundle，外加自己的 `cordis.patch.yml`。它是**一台机器上的一次具体部署**。

> **一句话**：bundle 是"这套能力长什么样"（进版本控制、可发布、可被别人叠）；profile 是"这台机器怎么跑它"（网关地址、模型、路径、端口）。同一个 bundle 配 `host` / `pod` 两个 profile，是我们的实际用法。

`dsh --profile X --dump-config` 渲染的就是这棵合成树——它是启动态的唯一真相。

### A.3 "插件 = 一行 patch" 对设计的影响

我们的 `CLAUDE.md` 把这条写成了纪律："替换策略 = 改一行 `cordis.patch.yml`，不自造插件机制"。落到代码上：

- 每一个需要被替换/注入的边界都做成 cordis service（`ctx.loops`、`ctx.gate`、`ctx.book`、`ctx.ledger`…），Definition + Provider + Consumer 一起发布；
- 纯函数（统计、哈希、校验）**不**做成 service，就是普通导出；
- 于是"换一个统计门"= 把 `gate-default` 那行的 `name` 换掉；"多一条 loop"= 加一行 `{id: loops-codex, name: @oldbulb/samsara-loops-codex, inject: [loops]}`。

`packages/bundle/cordis.patch.yml` 就是这个思路的完整样本：19 行 insert，从 storage 到 UI 到 runner，每行一个概念。

---

## B. 我们踩过的坑

以下每条都是真的撞过、并且能在仓库或 dsh 源码里找到出处的。格式：**症状 → 根因 → 解法**。

### B1. Service 类的行必须有 `export default`，否则报 `invalid plugin`

**症状**　`packages/ledger` 只 `export class Ledger extends Service`，把它写进 patch 行，启动时报
`invalid plugin, expect function or object with an "apply" method, received object`。

**根因**　loader import 到模块命名空间后调 `unwrapExports`：

```ts
// vendor/loader/src/index.ts:192
unwrapExports(exports: any) {
  if (isNullable(exports)) return exports
  exports = exports.default ?? exports          // ← 只认 default
  if (!exports.__esModule) return exports
  return exports.default ?? exports
}
```

没有 `default` 时它把**整个命名空间对象**交给 registry，registry 只接受三种形态——函数、类、带 `apply` 方法的对象（`vendor/cordis/src/registry.ts:222-229`），命名空间对象既不是函数也没有 `apply`，于是 `registry.ts:319` 抛错。

**解法**　两条路，二选一：

- Service 类的模块：文件末尾加 `export default TheClass`。我们 6 个 service 包都这么写，并且都留了同一句注释：
  `// The loader mounts this module as the `ledger` row: a Service class is a plugin.`
  （`packages/ledger/src/index.ts:297`、`gate:74`、`loops:176`、`scope:204`、`champion:306`、`signoff:235`）
- 函数式插件：`export const name` + `export const inject` + `export function apply(ctx, config)`，**不需要** default——命名空间对象带 `apply`，registry 认。`packages/ui/src/index.ts`、`packages/runner/src/index.ts`、`packages/loops-dsh/src/index.ts` 走这条。

> 顺带：dsh 自己的 `dsh-llm-replay` README 明确写了 "Named exports only, no default export — loader `unwrapExports` would collapse the module"，是同一枚硬币的反面：**工具库**故意不给 default，免得被误当插件挂载。

### B2. schemastery 嵌套 `Schema.object` 的字段不能 `.required()`

**症状**　`loops-dsh` 的可选价格表写成

```ts
Schema.object({ pricePerMtok: Schema.object({ input: Schema.number().required(), output: Schema.number().required() }) })
```

profile 里**不写** `pricePerMtok` 时，整行配置校验失败：`$.pricePerMtok.input missing required value`，插件根本不启动。

**根因**　`Schema.object(...)` 构造时把自己的默认值设成 `{}`（`vendor/schemastery/src/index.ts:852-853`）。字段缺省 → resolve 用默认值 `{}` 填进去（`:475-483`）→ 再拿 `{}` 去校验内部字段 → 内部 `.required()` 命中 `missing required value`（`:475`）。也就是说 **"可选的嵌套对象 + 必填的内部字段" 在 schemastery 里表达不出来**。

实测（3.18.1）：

```
nested-required, field absent  → THROWS: $.price.input missing required value
nested-optional, field absent  → {"price":{}}
top-level required absent      → THROWS: $.top missing required value      ← 顶层 required 正常，符合预期
```

**解法**　嵌套字段一律不 `.required()`，把"到底给全了没有"的判断放进代码。`packages/loops-dsh/src/index.ts:42-57`：

```ts
export const Config: Schema<Config> = Schema.object({
  // Nested objects default to {} under schemastery, so the fields stay optional
  // here and the table counts only when both prices are present (see priceTable).
  pricePerMtok: Schema.object({ input: Schema.number(), output: Schema.number(), cacheRead: Schema.number() }),
}) as unknown as Schema<Config>

function priceTable(config: Config): PriceTable | undefined {
  const t = config.pricePerMtok
  if (t === undefined || typeof t.input !== 'number' || typeof t.output !== 'number') return undefined
  return t
}
```

顶层字段的 `.required()` 是安全且推荐的（`packages/champion/src/index.ts:73-74`、`packages/signoff/src/index.ts:43-44` 都在用）。

### B3. 用到的服务必须 `inject`；可选依赖用 `ctx.get(name)`

**症状**　runner 的 `serve` 子命令想打印实际端口，直接写 `ctx.webServer` → 运行时抛
`cannot get property "webServer" without inject`。而把 `webServer` 加进 runner 的 `inject` 又不对：没挂 UI 的部署里 runner 就永远 PENDING 起不来。

**根因**　`vendor/cordis/src/reflect.ts:144` 的 Proxy get 陷阱。`inject` 的语义是"没有它我就不启动"（插件停在 PENDING），不是"我想用它"。

**解法**　分清两类依赖：

- **硬依赖** → `export const inject = ['loops', 'agents', 'sessions']`（`packages/loops-dsh/src/index.ts:36`）。
- **软依赖** → `ctx.get('webServer')`，返回 `undefined` 就降级。commit `fa0f702` 就是这个修复：

```ts
// packages/runner/src/index.ts:143
const web = (ctx as unknown as { get(name: string): { port?: number; host?: string } | undefined }).get('webServer')
const url = web?.port ? `http://${web.host ?? '127.0.0.1'}:${web.port}/samsara` : 'no web server mounted'
```

runner 里还有一个更好读的包装（`packages/runner/src/index.ts:81-85`），把"这行没挂"变成一句人话错误：

```ts
function need<K extends ...>(ctx: Context, key: K): Context[K] {
  const v = ctx.get(key) as Context[K] | undefined
  if (v === undefined) throw new Error(`ctx.${key} is not mounted (is its row enabled in the profile, and did it start?)`)
  return v
}
```

另外：`ctx.webServer` 这种由别的包声明的 Context 属性，**类型**也要显式引进来——`import type {} from '@deepseek-ai/dsh-host-webserver'` 这个空类型 import 携带 declaration merge（dsh 自己在 `frontend-static/src/index.ts`、`hmr/src/index.ts:16` 用同一个 idiom）。我们统一在 kernel 里 `import '@deepseek-ai/dsh-host-webserver'` 完成这件事（`packages/kernel/src/index.ts:90`）。

### B4. 不要和 `dsh-web-app` 共存——它会吃掉你的命令行并让进程退出

**症状**　profile 里同时列 `dsh-base` + `dsh-web-app` + 自己的 bundle，然后跑
`dsh --profile mine run --pack ... --loop null`，进程直接退出，说 unknown option。

**根因**　这是我们找到的最尖锐的一条约束。`provideCmdline` 发布**一份不可变的 argv 快照**（`packages/boot/cmdline/src/index.ts:67-71`），**每个** inject 了 `cmdlineArgs` 的 app 插件都用自己的 commander program 去 parse **同一份完整快照**（`parseCmdline`，`:98-119`）。而 `dsh-web-app` 的 `webCommand()`（`packages/bundle/web-app/src/startup.ts:46-60`）既没有 positional argument，也没有 `.allowUnknownOption()`。于是：

- 你的 `run` 子命令 → web-startup 的 parse 认为是未知参数 → `program.error` → CommanderError → `exit(error.exitCode)`（`cmdline/src/index.ts:110-118`）→ **整个进程退出**。
- `--help` → 谁先激活谁打印自己的 help，另一个永远跑不到。

**解法**　我们的 bundle **自己插 `dsh-host-webserver` 行**，绝不引入 `dsh-web-app`。`packages/bundle/cordis.patch.yml`：

```yaml
    # Web carrier: the bundle inserts the webserver row itself (never
    # dsh-web-app, whose web-startup row would reject the runner's argv; see
    # B4 below), under its own id so a profile that loads dsh-web-app's
    # `webserver` row can disable this one. Loopback only.
    - id: samsara-webserver
      name: '@deepseek-ai/dsh-host-webserver'
      config:
        host: 127.0.0.1
        port: 0
```

profile 的 bundles 就两层：`['@deepseek-ai/dsh-base', '@oldbulb/samsara']`。代价是没有 dsh 自带的聊天 UI——我们不需要（见 C5）。

如果你**必须**共存：那就别做 cmdline 解析，配置全部从自己那行的 YAML `config` 读，只 `inject: ['webServer']` 挂路由（named route 比 SPA fallback 先匹配）。

### B5. CLI 用 `npm i -g`，不要 `pnpm add -g`

**症状**　`pnpm add -g @deepseek-ai/dsh@0.1.1-rc.2` 装完，`dsh --profile host` 启动时 loader 解析不到兄弟包，行 mount 失败。

**根因**　dsh 启动时会跑 `healProfilesModuleFallback(INSTALL_ANCHOR)`（`apps/cli/src/profile-boot.ts:99`）：从 CLI 安装目录的 `package.json` 出发，BFS 遍历 `dependencies` **和** `peerDependencies`，把每一个能解析到的包 symlink 进 `$DSH_HOME/profiles/node_modules`（`packages/boot/app-boot/src/profile.ts:223-255`）。这个 fallback 目录就是所有 profile 共享的模块可见面。pnpm 的 isolated 全局布局下这个 BFS 解析不全（**UNVERIFIED**：具体是 peer 还是 store 层级的问题我们没深挖），flat 布局下正常。

**解法**　

```sh
npm i -g @deepseek-ai/dsh@0.1.1-rc.2
```

`ops/README.md` 第一条就是它，README 的开工清单第 P0 项也记了这句。

### B6. 额外的 dsh 包要装进 **dsh 安装目录**，不是 profile

**症状**　ledger 要用 sqlite backend，但 CLI 只带 `dsh-storage` / `dsh-storage-domain` / `dsh-storage-json`，**不带** `dsh-storage-sqlite`。往 profile 里 `dsh plugin --profile host add @deepseek-ai/dsh-storage-sqlite` 之后，行能起来了，但 storage 的服务身份对不上——profile 里多出来的第二份 `cordis` / `dsh-storage` 把 CLI 自己那份遮蔽了。

**根因**　loader 的 `ctx.baseUrl` 锚在 **profile 目录**（`app-boot/src/index.ts:769`，`profile-boot.ts:92` 的注释写明"anchor `baseUrl` at the profile directory"）。Node 的 nearest-wins 解析下，`<profile>/node_modules` 比 healed fallback `$DSH_HOME/profiles/node_modules`（父目录）**更近**。于是同一个包出现两份实例，`instanceof` / service 身份全断。

**解法**　装进 dsh 自己的安装目录：

```sh
cd "$(npm root -g)/@deepseek-ai/dsh" && npm i @deepseek-ai/dsh-storage-sqlite@0.1.1-rc.2
```

（`ops/README.md` "dsh CLI install"。这也是我们给上游的候选之一，见 E1。）

### B7. profile 目录需要**自己的** `pnpm-workspace.yaml`

**症状**　`profiles/host` symlink 到 `~/.dsh/profiles/host`，跑 `dsh plugin --profile host install` 之后，`profiles/host/package.json` 里的 `dsh.profile.bundles` 被**静默摘掉了** `samsara` 这一层——不报错，只是 UI/runner/loops 全没了。

**根因**　两件事叠加：

1. pnpm ≥ 10 会向上搜索 `pnpm-workspace.yaml`。symlink 解析到真实路径 `<repo>/profiles/host` 之后，它找到的是**仓库根**的 workspace 定义，于是按仓库 workspace 的规则装，profile 自己的 `node_modules` 没按预期落地。
2. `dsh plugin` 装完会 **reconcile**：对每个 dependency 调 `exportsPatch()`，解析不到就 `return false`（"pnpm reported success yet the package is unresolvable — treat as plain"，`apps/cli/src/plugin.ts:36-45`），然后 removal 循环把这个"不是 bundle"的 dependency 从 `dsh.profile.bundles` 里 splice 掉（`plugin.ts:74-85`）。**解析失败和"这个包不是 bundle"走同一条路径**，所以表现是安静地少一层。

**解法**　给 profile 目录一个自己的 workspace 文件，切断向上搜索：

```yaml
# profiles/host/pnpm-workspace.yaml
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false
```

`nodeLinker: hoisted` 顺带也解决了 B6 那类"两份 cordis"的问题。装完一定要验：

```sh
dsh --profile host --dump-config | grep samsara     # 该有 samsara 的行
```

### B8. 启动器的退出竞态：一次性命令跑完不退出

**症状**　`dsh --profile host run --loop null --limit 1` 逻辑跑完、summary 打印完，进程挂着不退。只在**很快**结束的命令上出现（大约 3 秒内），慢的 run 反而正常。

**根因**　`runProfile` 在 `boot()` **返回之后**无条件挂两个 patch 文件 watcher（`apps/cli/src/profile-boot.ts:262-295`）：没有 hmr 就现场 `loader.create` 一个 `cordis-plugin-timer` + `cordis-plugin-hmr`，再跑两次 `watchUserPatches`（`app-boot/src/index.ts:232-270` → `hmr.registerConfig`）。守卫条件是 `!signalShutdown.signal.aborted && ctx.fiber.state === ACTIVE`——但 `appExit` 走的是 `shutdown.shutdown(code)`，**不会** abort `signalShutdown`。于是一个在 boot 后立刻 `appExit` 的一次性 app，可能在 fiber 状态还是 ACTIVE 时被判定"活着"，watcher 于是在树已经开始销毁之后才打开，永远吊着 event loop。

dsh 自己知道有这个窗口——`watchUserPatches` 里专门 catch 了 `INACTIVE_EFFECT` 返回 no-op disposer（`app-boot/src/index.ts:262-266`）——但那只覆盖 effect 注册已经失败的情形，覆盖不了 watcher 成功打开的那一半。

**解法**　我们在 runner 里加了一个 unref 的兜底强退（`packages/runner/src/index.ts:237-250`）：

```ts
/** Grace after the tree disposed before a stray handle is no longer allowed to keep the process alive. */
export const DRAIN_GRACE_MS = 3000

ctx.effect(() => () => {
  if (exitCode === undefined) return
  setTimeout(() => process.exit(exitCode), DRAIN_GRACE_MS).unref()
}, 'samsara-runner.drain')
```

语义是"我这个插件都被销毁了，属于我的东西一个不剩；再等 3 秒还没排空，就是别人的句柄，强退"。`unref()` 保证这个 timer 自己不会成为最后一个句柄。已记为上游候选（E2）。

### B9. patch 替换的是**整个 config 对象**，不是深合并

**症状**　bundle 里给 `proposer-claude-p` 设了 `config: { command: claude }`，profile 里补一个 `config: { model: ..., baseUrl: ... }`，结果 `command` 没了。

**根因**　`applyEntryPatches` 对非 insert 的 patch 就是逐 key 顶层赋值：

```ts
// vendor/include/src/index.ts:121-124
for (const [key, value] of Object.entries(overrides)) {
  if (key === 'id') continue
  target[key] = value          // ← config 整个被换掉
}
```

dsh 的 app-boot README 也写死了这一点（"replaces the whole `config` of the row — no deep merge"）。

**解法**　**部署事实写在 profile 层，并且把该行的 config 完整重述一遍**。我们在 bundle 里就把这条写成注释了：

```yaml
    # `claude -p` as proposer … model/baseUrl/credentialRef are deployment facts
    # and live in the profile's own patch layer (like loops-claude-code); a
    # patch replaces the whole config, so the profile restates `command` too.
```

推论：bundle 行里只放**领域中性的默认值**和占位（`baseUrl: ''`、`credentialRef: ''`），凡是跟机器有关的都留给 profile。

顺带两个同源的静默失败，值得一起知道：

- patch 的 `id` 打错字 → **只是一条 warning**，不是错误（`vendor/include/src/index.ts:111-113`：`warn('patch: entry %C not found', id)`）。
- patch 带了 `name` 但和目标行的 `name` 不一致 → 整条 patch 被跳过，同样只 warn（`:116-119`）。

这两条 warning 在 `renderConfigDump` 的默认 warn sink 里会写到 stderr（`app-boot/src/index.ts:383`），所以 **`--dump-config` 是唯一能看见它们的地方**——见 C6。

### B10. 固定端口会让并发的一次性命令互撞

**症状**　bundle 里 webserver 写死 `port: 3099`。同时跑两条 `dsh --profile host run ...`（我们做 32 并发批跑时），第二条起不来，端口占用。

**根因**　每条一次性命令都是一个完整的 host 进程，都会 mount webserver 行。

**解法**　默认 `port: 0`（OS 分配），要固定端口的场景（`serve`）在 profile 层单独 pin。commit `e83826f`：

```yaml
        port: 0   # OS-assigned so one-shot commands never collide; pin a port in the profile patch for `serve`
```

配套：`serve` 从 `ctx.webServer.port` 读实际绑定的端口打印出来（`packages/runner/src/index.ts:143-145`）。`port: 0 ⇒ ctx.webServer.port` 可读，这是 webserver 明确支持的（`packages/host/webserver/src/index.ts:58-64`）。

### B11. 测试里 unix socket 不要绑在仓库路径下

**症状**　replay 测试跑起来，signoff 行 bind `data/signoff.sock` 失败。

**根因**　仓库内路径在某些沙箱（包括我们跑 agent 的环境）下不允许 bind unix socket。

**解法**　测试的 overlay 把 socket 指到测试自己的 tmp 目录（commit `2b76cc9`，`tests/replay/replay.overlay.yml`）：

```yaml
# - signoff: the consent socket lives under the test's tmp dir (binding inside the
#   repo is refused by some sandboxes); no key is needed for a replayed run.
- id: signoff
  config:
    socketPath: '{{sessions}}/signoff.sock'
    publicKeyPath: '{{sessions}}/signoff.pub'
```

一般化的教训：**凡是"路径"类配置，都要能被 `--patch` 覆盖层重定向到 tmp**。session 持久化目录、ledger 路径、skill store 我们都留了这个口子。

### B12. macOS 的 `/private` 前缀：录制的 fixture 要把两种写法都 tokenize

**症状**　回放测试在 macOS 上失败——录制时 session header 里的 `cwd` 是逻辑路径 `/tmp/...`，而工具调用参数里带的是 realpath `/private/tmp/...`（或者反过来），只替换一种就漏。

**根因**　macOS 上 `/tmp` 是 `/private/tmp` 的 symlink，dsh 不同代码路径拿到的 spelling 不一样。

**解法**　投影器把**两种 spelling 都收集起来、按长度倒序替换**（`tests/replay/project-fixture.ts:30-35`）：

```ts
/** The recorded cwd plus its /private-prefixed and -stripped spellings, longest first. */
export function cwdSpellings(cwd: string): string[] {
  const set = new Set<string>([cwd])
  if (cwd.startsWith('/private/')) set.add(cwd.slice('/private'.length))
  else set.add('/private' + cwd)
  return [...set].sort((a, b) => b.length - a.length)
}
```

commit `39ab90c` 的一半工作量就是这个。

### B13. `ctx.subprocess.spawn` 不会自动挂到调用方的 fiber 上

**症状**（我们靠 S1 调研提前避开了，没有真撞）　插件 dispose 之后，它 spawn 的子进程还活着。

**根因**　`subprocess-local` 里只有 **一个** `ctx.effect`，挂在**服务自己**的 fiber 上（`packages/subprocess/subprocess-local/src/index.ts:49`）。子进程树的所有权归 subprocess 服务或（走 `ctx.jobs` 时）owner Agent，**不归 spawn 它的那个插件**。

**解法**　自己包一层 effect。这条被我们写进硬约束 E4："subprocesses in a scope go through `ctx.subprocess.spawn` wrapped in the provider's own `ctx.effect`; `ctx.jobs` is not used inside scopes."

### B14. usage 语义按网关而异：`inputTokens` 可能已含 cache read

**症状**　`loops-dsh` 算出来的 attempt 成本是**负数**。

**根因**　价格表算式假设 `inputTokens` 是"总输入"、`cacheReadTokens` 是其中的一部分，于是 `inputTokens - cacheRead`。而网关在全命中缓存时把两者报成同一个数甚至 cacheRead 更大。

**解法**　夹一下（commit `c1d17c7`，`packages/loops-dsh/src/limits.ts:53-58`）：

```ts
Math.max(usage.inputTokens - cacheRead, 0) * price.input + cacheRead * cacheReadPrice + usage.outputTokens * price.output
```

一般化：dsh 的 `TokenUsage`（`packages/llm/llm/src/types.ts:135`）**没有 cost 字段**，成本永远是你自己按价格表算或者从 loop 自报里拿。我们在 `finished.cost.source` 上记了是 `price-table` / `self-reported` / `proxy` / `unknown`——这个来源标签比数字本身更重要。

### B15. SIGINT 时部分 ledger 写会丢

**症状**（**已知未修**）　Ctrl-C 中断并行批跑，少数 ledger 行没落盘，报 `ledger domain is not open`。

**根因**　dsh 的 SIGINT handler 销毁整棵树；ledger 的 domain close effect（`packages/ledger/src/index.ts:102-107`）和 runner 的在途写并发跑——前面说过，**多个异步 disposer 是并发的，不是有序的**。domain 先关了，后面的 `table.put` 就抛 NOT_OPEN。

**缓解**　`attempts.jsonl` 是完整的、可导入的；`run --resume` 从 `.steps/` 的持久化 marker 重建 ledger 行（commit `1bec701`，fixture `d5b31cd`：16 并发被 SIGINT 打断后 resume，10 保留 6 重跑）。

**正确修法**（未做）　flush writer queue 之后再让 runner 的 disposer 释放，或者显式给 disposal 排序——按 cordis 的语义，就是把两件事写进**同一个** disposer。记在 `ops/README.md`。

---

## C. 验证过的模式

### C1. kernel 单入口

`packages/kernel/src/index.ts`，94 行，是**唯一** import `@deepseek-ai/*` 路径的文件。CLAUDE.md 里的纪律第 6 条："dsh 只经 `packages/kernel` 进入……重新 pin 是一个文件的事。"

它做三件事：

1. **值和类型的 re-export**——`Context`、`Service`、`Schema`、`composeEntries`/`loadProfile`/`renderConfigDump`、loader 的 `Entry`/`EntryTree`/`Group`、include 的 `PatchOptions`。
2. **副作用 import**——`import '@deepseek-ai/dsh-agent'` 这类空 import 把 Context augmentation 装进来（`ctx.agents`、`ctx.tools`、`ctx.sessions`、`ctx.subprocess`、`ctx.credentials`、`ctx.storageDomain`、`ctx.webServer`…），下游包写 `ctx.tools.register(...)` 才能过类型。
3. **一个显式的 pin 常量**——`export const DSH_PIN = '0.1.1-rc.2'`，被 `loops-dsh` 直接用作 `harnessFacts.version.loop`，于是**用的哪个 dsh 会进 `facts_sha`，进而进 ledger**。

实际需要 re-export 的面（可以当清单抄）：

| 类别 | 符号 |
|---|---|
| cordis 运行时 | `Context`, `Service`, `Plugin`, `Fiber`, `Inject` |
| 配置 | `Schema`（schemastery 默认导出） |
| profile 合成 | `composeEntries`, `loadProfile`, `renderConfigDump`, `readProfileManifest`, `resolveProfileDir`, `PROFILE_PATCH_FILENAME` + `Profile`/`ProfileLayer`/`ConfigDumpLayer` |
| loader / include | `Loader`(default), `Group`, `Include`(default), `EntryOptions`, `Entry`, `EntryTree`, `PatchOptions` |
| agent | `Agent`, `AgentHandle`, `AgentOptions`, `CreateAgentOptions`, `AgentSetup` |
| tools | `ToolDefinition`, `ToolRunContext`, `ToolRestriction`, `ToolExecution`, `PreToolDecision`, `ToolArgsError` |
| session / llm | `Session`, `SessionEvent`, `SessionId`, `createUserMessage`, `ContentBlock`, `Message`, `TokenUsage` |
| subprocess | `SubprocessSpawnSpec`, `SubprocessHandle`, `SubprocessOutcome`, `scrubbedParentEnv` |
| 凭据 / 命令行 | `CredentialRef`, `ResolvedCredential`, `parseCmdline`, `Command`(commander) |
| storage | `Storage`, `StorageBackend`, `defineDomain`, `domainTable`, `Domain`, `KvTable`, `DomainSpec`, `JsonStorageBackend`, `z`(zod) |
| web | `HttpServer`(default), `WebRoute`, `WebServer` |

注意 **两套 schema 语言并存**：插件 `Config` 用 schemastery，storage domain 的行 schema 用 zod（`defineDomain` 要的是 `ZodType`）。kernel 把两个都导出来，下游不用各自装。

CI 里配一条泄漏 grep（"packages/ 里不得出现 `@deepseek-ai/`，kernel 除外"）就能把这条纪律钉死。

### C2. in-process child agent 的完整配方（loops-dsh）

模板是 dsh 自己的 `packages/subagent/subagent-in-process-driver/src/index.ts`。要点是：**`setup` 是唯一的组装窗口，它只组装、不驱动**（`packages/core/agent/src/index.ts:69-71`）。在 `setup(agentCtx)` 里注册的一切都发生在 `session/created` / `agent/created` / 第一次 prompt 组装**之前**，抛异常则整个创建回滚，两个 id 都不发布。

我们的实现（`packages/loops-dsh/src/index.ts:105-160`），顺序是**有意义**的：

```ts
const handle: AgentHandle = await hostCtx.agents.create({
  sessionId,
  meta: { cwd: spec.workdir },                       // 必须绝对路径
  agentOptions: { provider: spec.route.provider, model: spec.route.model },
  signal: spec.signal,
  setup(agentCtx: Context) {
    // 1. preset join first (order is load-bearing, s5 §B.4), then per-attempt registrations.
    agentCtx.get('agentPresets')?.composeFrom?.(agentCtx, hostCtx)
    if (spec.tools.allow.length > 0) agentCtx.tools.restrict({ allow: spec.tools.allow })
    agentCtx.tools.register(createSubmitTool({ ...spec.tools.submitTool, workdir: spec.workdir }))
    agentCtx.systemPrompt.section({ name: 'samsara:skill',  order: 150, text: skill })
    agentCtx.systemPrompt.section({ name: 'samsara:submit', order: 190, text: submitInstruction(...) })
    if (spec.tools.deny.length > 0) {
      agentCtx.tools.guard((exec) => { … })            // 单调：只能 deny 或弃权
    }
    // 2. observation: the committed session log → LoopEvents.
    agentCtx.on('session/event', (_session, event) => { … })   // scope-filtered：只收这个 agent 的
    // 3. limits: steps (maxTurns) and wall clock (maxDurationMs).
    agentCtx.on('agent/pre-step', (_p, next) => limits.preStep() === 'reject' ? {kind:'reject'} : next())
    agentCtx.effect(() => { const t = setTimeout(…); return () => clearTimeout(t) }, 'loops-dsh.maxDuration')
  },
})
```

驱动只有三行（一个 turn）：

```ts
handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: spec.prompt }], source: { kind: 'user' } }))
await handle.agent.whenIdle()                 // 整体静默，不是 turn 结束
await hostCtx.sessions.flush(handle.agent.session)
```

**收尾必须 `handle.dispose()`，并且和 result 一起 allSettled**（`packages/loops-dsh/src/index.ts:180-190`）：

```ts
const settled = await Promise.allSettled([handle.dispose(), result])
events.close()
if (settled[0].status === 'rejected') throw settled[0].reason
```

几条容易忽略的 API 事实：

- `tools.restrict()` **必须在 scoped context 上调**，在普通 ctx 上直接抛（"a context-global restriction would mask every agent"，`packages/core/tools/src/index.ts:1071-1098`）。空 filter 抛，未知工具名抛（会把已知名单打出来），`run_code` 不能被点名。restriction 沿链 **求交**；scoped 注册的工具（你的 submit 工具）不受影响。
- `tools.register()` 的 `output: { schema, render }` 是**必填**，缺了 register 直接 `TypeError`（`:1037-1044`）。
- `tools.guard()` 在整个 `tools/pre-execute` waterfall **之后**跑，而且是**单调的**——只能拒绝或弃权，没有任何 guard 能强制放行（`:1110-1116`）。"这一轮结束了，之后什么都别做"用它。要做条件放行/询问，用 `tools/pre-execute` waterfall（返回 `allow` / `deny` / `ask`）。
- submit 工具的经典形状（两阶段提交 + `exec.concludeTurn()`）直接抄 dsh 的 `subagent-in-process-driver/src/structured.ts:49-141`：`execute` 里 stage 到一个以 `exec` 身份为 key 的 WeakMap，等 `tools/result` 报告 `!isError` 再 commit。`exec` 在一次 pipeline 里唯一，即便适配器的 callId 重复也不会串。

### C3. 子进程 loop（Claude Agent SDK）：spawn 覆盖 + 环境墓碑

Claude Agent SDK 允许你接管进程创建：把 `spawnClaudeCodeProcess` 换成走 dsh 的 subprocess seam，就能拿到树级的 SIGTERM→grace→SIGKILL 和"服务销毁时杀光整棵树"。dsh 自己的 `subagent-claude-code` 是模板，我们的 `packages/loops-claude-code/src/process.ts` 是同构实现。

**关键技巧：环境墓碑。** subprocess seam 的 `env` 语义是"merge 到 `scrubbedParentEnv()` 之上"，而 SDK 递给你的是一份**完整的**子进程 env（它已经按自己的意图删过东西）。直接传过去，被 scrub 掉的那些名字会因为 merge 而复活。所以要给 SDK 删掉的每个名字补一个 `undefined` 墓碑：

```ts
// packages/loops-claude-code/src/process.ts:17-24
export function sdkEnvironmentOverlay(env: SpawnOptions['env']): NodeJS.ProcessEnv {
  const overlay: NodeJS.ProcessEnv = { ...env }
  for (const name of Object.keys(scrubbedParentEnv())) {
    if (!(name in env)) overlay[name] = undefined      // undefined = tombstone
  }
  return overlay
}
```

**`scrubbedParentEnv()` 会吃掉你的凭据。** 它删掉所有匹配 `/KEY|PASSWORD|SECRET|TOKEN/i` 的名字和所有 `DSH_*`（`packages/subprocess/subprocess/src/index.ts:44,60-66`）。也就是说 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY` **必须显式注入**，靠环境继承是拿不到的。这条正好和我们的硬约束 E5（凭据显式注入）对齐——被迫做对的事。

我们的 per-attempt env（`packages/loops-claude-code/src/env.ts:20-33`）把凭据、路由、以及 HOME/TMPDIR/CLAUDE_CONFIG_DIR **全部指向该 attempt 的 tmpdir**：

```ts
ANTHROPIC_AUTH_TOKEN: credentialValue,     // 显式，来自 ctx.credentials.resolve()
ANTHROPIC_MODEL / ANTHROPIC_SMALL_FAST_MODEL: spec.route.model,
ANTHROPIC_BASE_URL: spec.route.baseUrl,    // 非凭据，可继承，但我们仍显式给
CLAUDE_CONFIG_DIR: <tmpdir>/claude-config,
HOME: spec.tmpdir, TMPDIR: spec.tmpdir,    // 每 attempt 隔离（E6）
DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
```

`spawn` 规格本身也全是显式的——seam 不给任何默认值（`SubprocessSpawnSpec` 要 `argv`/`cwd`/`stdio`/`graceMs` 全填）：

```ts
// packages/loops-claude-code/src/process.ts:26-37
return { argv: [options.command, ...options.args], cwd: options.cwd,
         stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
         graceMs, signal: options.signal, env: sdkEnvironmentOverlay(options.env) }
```

拆卸顺序照抄 dsh：`query.close()` → `child.terminate()` → `await child.waitForExit()` → `await child.done`。

> 一条重要的**能力边界**：dsh 自带的 `subagent-claude-code` / `subagent-codex` provider 只保留**最终文本**（`consumeClaudeQuery` 只留 `message.type === 'result'`），没有 usage、没有 tool 轨迹、没有 transcript。想要完整轨迹（我们要，因为轨迹要进训练导出）就必须自己写 provider，把每条 `SDKMessage` 都收下来。这是我们没有直接复用 dsh subagent seam、而是自建 `ctx.loops` seam 的主要原因之一。

### C4. 无 key 回放测试

**这是投入产出比最高的一件事。** dsh 的 `dsh-llm-replay` 把一份持久化的 session log 当作 mock 模型：它只读 `assistant/chunk` 事件（按 `(turn, step)` 分组 = 一次 `stream()` 调用）和 header，回放时重建连续的合成信封。**它不负责录制**——录制就是"真跑一次，把 `.jsonl` 收起来"。

我们的三段式：

1. **录制**：一个 `--patch` 覆盖层只改一行（session 持久化改成未压缩、落到固定目录），然后正常跑一次真实的 attempt。`tests/replay/record.overlay.yml` 全文就 4 行 config。
2. **投影**：`node tests/replay/project-fixture.ts <scenario>/session.jsonl` → `session.replay.jsonl`。做的事：header 的 `cwd` 换成 `{{cwd}}`；body 行删掉存储信封（`seq`/`time`/`seq0`/`time0`）；每个字符串叶子里的 cwd 换成 token（两种 spelling，见 B12）。**其他一律原样保留**，所以 fixture 就是录音本身。
3. **回放**：测试渲染一份 `replay.overlay.yml`（把三个 `{{…}}` 换成绝对路径），然后 `execFile` 真的 `dsh --profile host --patch <overlay> run ...`。

overlay 里四条，每条都有理由（`tests/replay/replay.overlay.yml` 的注释就是文档）：

```yaml
- id: llm-pi-ai            # disabled + baseURL 指向 127.0.0.1:9（不可路由）——逃逸的模型调用一定失败而不是偷偷联网
  disabled: true
- id: session-title-llm    # disabled——它用 agent 自己的 sessionId 发流，会在 agent 第一步之前把第一条录音吃掉
  disabled: true
- id: signoff              # socket 放 tmp（见 B11）
- id: session-persistence-jsonl   # raw jsonl 落到测试 tmp，测试能读回来，也不脏用户的 $DSH_HOME
- insert: [{ id: llm-replay, name: '{{llmReplay}}', config: { file: '{{fixture}}' } }]   # 按绝对路径挂
```

两个细节值得抄：

- **`{{fromRequest:<regex>}}`**：脚本里的字符串可以在 stream 时对着实时请求做正则替换。我们用它把 attempt 的真实 workdir 绑进 fixture：`'{{fromRequest:session workspace: "([^"]+)"}}'`——每次跑 workdir 都不一样，但录音仍然对得上。
- **测试宁可 skip 不可 fail**：没有 `dsh` 在 PATH、找不到 `dsh-llm-replay`、或者**录音里的 submit 工具名和 pack 现在注册的对不上**（skill 改名了），一律 `ctx.skip` 并打印重录命令。回放是盲的：录音里的 `submit_<old>` 会打到一个不存在的工具上，脚本提前一步耗尽，报出来的错会完全指向错误的方向。

断言不只看结果，还**核对录音被完整消费**：

```ts
expect(finishes(replayed)).toBe(finishes(rows(fixture)))                 // finish chunk 数一致
expect(recordedToolCalls(readFileSync(log!, 'utf8'))).toEqual(recordedToolCalls(fixture))
expect(row.toolCalls).toBe(recordedToolCalls(fixture).length)
```

### C5. UI 用 prefix 路由 + 内联 HTML，不碰 React client plugin / typert

**结论：如果你只要一个只读页面，别走 dsh 的 client-plugin 平面。**

代价对比（依据对 dsh web 路由与 client-plugin 平面的源码调研）：走 typert / `dsh.client` 意味着你的包必须导出 `./typert` 和 `./remote` 两个入口、生成器要校验 `files` 才肯出码、客户端组合还得把你的包加进 `@deepseek-ai/dsh-api-remotes`、而且 `ctx.remote` 那一整套只存在于浏览器 bundle 里，"Client Remote 拒绝挂载缺少 strict codec 的 SRC descriptor"——真正的 build 是必须的。

我们要的是"champion / 最近 settlement / 各 tier 的 challenger / 待签字"四块只读信息。于是：

```ts
// packages/ui/src/index.ts:20, 92-95
export const inject = ['webServer', 'ledger', 'champion', 'signoff']
…
ctx.effect(
  () => ctx.webServer.register({ kind: 'prefix', path: basePath.replace(/\/+$/, '') || '/', handler }),
  `samsara-ui: ${basePath} route`,
)
```

一条 `kind: 'prefix', path: '/samsara'` 就覆盖了 `/samsara`、`/samsara/`、`/samsara/api/...`（query string 在匹配前被剥掉）。匹配顺序是固定的：**exact 表 → 最长前缀 → fallback 座位 → 404**，注册顺序不带任何语义。

要点：

- **handler 是 node:http 签名**（`(req, res)`），不是 fetch。没有任何 helper，`res.writeHead(200, {'content-type': …}); res.end(body)` 自己写。
- **方法门禁是你的事**——carrier 把所有 method 都派给匹配到的路由。我们自己在 handler 第一行判 `req.method !== 'GET'` → 405。
- **不要抢 `registerFallback`**——只有一个 owner，第二次注册直接抛，会让你那行激活失败。
- **必须 `ctx.effect` 包住 register**，否则路由泄漏，下一次 mount 报 `duplicate prefix route "/samsara"`。
- **没有 CORS、没有 auth**——整个 `packages/host` 和 `client/connection` 里零个 `Access-Control-*` header，姿态是"loopback + trusted host"。我们的 signoff 因此**不走 HTTP**（硬约束 E2），页面只显示"你该在终端敲哪条命令"。

配置从**自己那行的 YAML** 读（`basePath`、`refreshMs`），绝不从命令行读——理由见 B4。

### C6. storage domain：开域 + `ctx.effect` 关域

`ctx.storageDomain` 的规范用法（dsh 自己的 `message-feedback` 是模板，我们的 ledger 同构）：

```ts
// packages/ledger/src/index.ts:101-107
protected async [Service.init](): Promise<void> {
  const domain = await this.ctx.storageDomain.open(ledgerDomainSpec)
  this.ctx.effect(() => async () => {
    this.domain = undefined
    await domain.close()
  }, 'ledger.domainClose')
  this.domain = domain
}
```

要知道的语义：

- **读是同步的**（从内存里的权威状态），**写是每个 domain 一条串行链**：先落到后端持久化，再更新内存，再发 `domain/changed`（进程内事件，不跨进程）。
- **单开**：同一个 spec 开第二次直接 `DomainError('already-open')`。
- **没有 migration**：`version` 不匹配就 `version-mismatch` 拒绝打开，转换是你自己的事（pre-release stance）。
- 行 schema 是 **zod**，插件 `Config` 是 **schemastery**——两套并存，别搞混。
- 整个 domain 是**全量载入内存**的。适合控制平面记录（我们放 challengers / attempts / scores / compares / consents / settlements 六张表），不适合放 trajectory 和大表——那些放文件 + 在 domain 里存指针和 sha。

后端在 patch 里选：

```yaml
- id: samsara-storage-domain   # the bundle's own id (with `samsara-storage`); a profile loading dsh-web-app disables both
  name: '@deepseek-ai/dsh-storage-domain'
  inject: [storage]
  config:
    backend: sqlite
    routes: { samsara_ledger: sqlite }
```

（sqlite backend 要先按 B6 装进 dsh 安装目录。）

### C7. 用 `--dump-config` 做启动态断言

`renderConfigDump` 渲染的就是会被 boot 的那棵树，而且**默认把 patch warning 写到 stderr**（`app-boot/src/index.ts:379-404`）。三个用法：

1. **人工冒烟**：`dsh --profile host --dump-config | grep samsara`——装完 bundle 的第一件事（README 开工清单第 12 项、ops/README）。B7 那个"bundle 被静默摘掉"就是靠它发现的。
2. **热应用验证（我们的硬约束 E7）**：promote 写完 profile 的 patch 文件之后，**不信文件 watcher**，而是用 kernel 的 `loadProfile` + `renderConfigDump` 在同样的层上重新合成一遍，逐行核对每一条 kept row 是否真的出现在 dump 里、内容是否逐字节一致（`packages/champion/src/index.ts:278-286` + `state.ts:218-247`）。
3. **看见静默的 patch warning**——B9 里那两条（id 不存在、name 不匹配）只有在这里才会露头。

### C8. 挑战者 = 内存里的 `cordis:group`，不是文件

这一条是我们的场景特有的，但机制值得知道：跑一个"候选配置"时**绝不能**改 profile 文件（会污染真实部署、也没法并发）。正确做法是用 loader 的编程接口往**内存树**里建一个 group：

```ts
// packages/scope/src/index.ts:114-135
loader.builtins.group ??= Group
await loader.create({ id: groupId, name: 'cordis:group', group: true, config: entries, ...isolate }, null)
const entry = loader.resolve(groupId)
fiber = entry.fiber
remove = () => loader.remove(groupId)
```

`null` 作为 parent 表示"建进内存的 root tree"，不经过文件 backed 的 Include，所以 **profile 文件的 sha 一个字节都不变**（这是我们 E1 的测试断言：100 次 open/dispose 之后文件 sha 不变、registry 大小复原、零残留进程）。`cordis:group` 让整个候选作为**一个单元**装卸；`isolate: {serviceName: label}` 还能给它一个私有的服务 realm。

另外注意：`cordis:group` 和父级**共享 tree store**，子 entry 的 id 是平的，所以我们给每行加了 group 前缀避免和 champion 的行撞车。

### C9. 测试分层：纯函数 / 裸 Context+真 Loader / 真 CLI 子进程

40 个测试文件里三种形态，成本递增：

| 层 | 怎么搭 | 例子 |
|---|---|---|
| **纯函数** | 直接 import，没有 Context | gate 的统计、diff scan、env sha、OTel 映射、page 渲染 |
| **裸 Context + 真 Loader** | `new Context()` → `ctx.plugin(Loader)` → `loader.internal.import` 换成一张内存模块表 → 用真的 YAML 组合 | `packages/ui/tests/route.test.ts`（真的 `dsh-host-webserver` 在 `port: 0` 上起来，fake 掉 ledger/champion/signoff，全部断言打真 HTTP）；`packages/scope/tests/scopes.test.ts`（真 Loader + 一个 noop 插件文件） |
| **真 CLI 子进程** | `execFile('dsh', ['--profile','host','--patch',overlay,…])` | `tests/replay/dsh-beer-song.replay.test.ts` |

中间那层的搭法值得抄一遍（`packages/ui/tests/route.test.ts:61-79`）：

```ts
context = new Context()
context.baseUrl = pathToFileURL(root).href + '/'
await context.plugin(Loader)
context.loader.builtins.include = Include
const modules = new Map<string, unknown>([
  ['@deepseek-ai/dsh-host-webserver', HttpServer],
  ['fake-ledger', FakeLedger], …
  ['@oldbulb/samsara-ui', Ui],
])
context.loader.internal = { version: 'v2', async import(spec) {
  if (!modules.has(spec)) throw new Error(`unexpected Loader import: ${spec}`)
  return modules.get(spec)
} } as ...
await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
await context.loader.await()
```

两个附加断言很值：

```ts
const unloaded = [...loaded.loader.entries()].filter(e => e.fiber === undefined && !e.disabled).map(e => e.options.name)
expect(unloaded).toEqual([])                        // 没有一行悄悄没起来
// …dispose 之后再打一次，确认路由真的释放了
```

第三层因为要冷启 tsx，timeout 记得放到 60~180s。

### C10. 等 loader 装完再干活

一次性 app 插件里，兄弟行是**并发** mount 的。想让所有 loop provider 都注册完再 `start()`，必须显式等：

```ts
// packages/runner/src/index.ts:180-181
// Loader siblings mount concurrently; wait for the whole tree so every loop
// provider has registered before the first start().
await ctx.get('loader')?.await()
```

dsh 自己的 headless bundle 第一行就是这个（`packages/bundle/headless/src/index.ts:99`）。

### C11. 命令行：解析行和干活行拆开

模板是 dsh 的 `dsh-headless/startup`。**一个行负责解析 argv 并 `ctx.provide` 一个普通 cordis service，另一个行 `inject` 它**：

```ts
// packages/runner/src/startup.ts:292-296
export function apply(ctx: Context): void {
  const program = runProgram((values) => { ctx.provide(SAMSARA_RUN_SERVICE, values) })
  parseCmdline(ctx, program)
}
```

```ts
// packages/runner/src/index.ts:28
export const inject = [SAMSARA_RUN_SERVICE, 'loops', 'agentDefaultModel', 'ledger']
```

好处很实在：`--help` 或者用法错误时 action 根本不跑，服务不发布，干活的那行永远 PENDING，什么都不会发生。`parseCmdline` 会把 help / version / 解析错误 / action 里的 `program.error()` 统一变成 CommanderError 并调 `appExit`（`packages/boot/cmdline/src/index.ts:98-119`）。

### C12. 人类命令 `/samsara …`：consent 只从这里发生

模板是 dsh 的 `command-goal`（`packages/goal/command-goal/src/index.ts`）。`ctx.commands.register({ name, description, input?: { hint }, handler })`（`packages/interaction/commands/src/index.ts:270`）注册一条**全局**命令；web UI 把 `/samsara approve …` 这行文本派给 handler，返回值渲染成一张卡片，**不进模型历史**；`command/run` / `command/done` 是持久化的 session event。

我们的实现（`packages/workbench/src/commands.ts:397-403`）：

```ts
ctx.commands.register({
  name: 'samsara',
  description: 'the samsara workbench: status, predict, approve, demote, gate, reveal, budget, stop, reconcile',
  input: { hint: 'status | predict … | approve <id> | …' },
  handler: (invocation) => execute(ctx, invocation),
})
```

要知道的 API 事实：

- `CommandInvocation = { commandId, agent, rawInput, attachments, signal }`（`commands/src/index.ts:34-45`）——**没有 ctx、没有 session**。handler 闭包住注册插件的 ctx，所以 `export const inject = ['commands', 'lifecycle', 'ledger', 'signoff', 'champion', 'jobs']` 才是它能用哪些服务的声明。
- `rawInput` 是原始文本，**自己解析**。我们的 `tokenize` 把双引号里的一段当一个词（hypothesis、reason），`split` 只认白名单里的 `--key value`，其他一律 `UsageError` 变成 error 卡片——handler **从不 throw**（`commands.ts:369-394`）。
- 命令只有两个作用域：全局，或挂在某个 `agent.ctx` 之下的每 agent 变体（同名冲突的报错文本直接说了这一点，`commands/src/index.ts:94-95`）。没有 workspace / session 作用域。
- handler 想让模型知道刚发生了什么，得**自己**说：`invocation.agent.followup(createUserMessage(…))`（`commands.ts:233-235`）。registry 不会替你转告。

**为什么 consent 放在命令而不是工具**：一条命令是 UI 认证的人类动作，不是 key 签过的。所以 `/samsara approve <id>` 仍然走 `ctx.signoff.request(subject, action)` + `onConfirm` 等 socket 上的签名（`commands.ts:214-230`），web session 不被当成证明；handler 里**没有签名材料**（E2）。agent 这边则根本没有任何工具能打开一个 sign-off——这是 approval（"可以花这 $x 吗"，工具在 `execute` 里问）与 consent（"这个 challenger 是 champion 吗"，人敲命令并签字）的分野，`docs/design/workbench.md` § The consent / approval split。

### C13. 工具挂在 preset 里 + 执行器留在 host 行

`ctx.tools.register` 默认是**全局**的。要让 `samsara_*` 只对 operator agent 可见，不是在注册时过滤，而是**把注册它们的插件挂进 preset 的 `agent.cordis.yml`**（`dsh-agent-presets` 的 `COMPOSITION_FILE`，`packages/preset/agent-presets/src/discovery.ts:26`）：preset 的组合按 agent 挂载，里面注册的工具只属于那个 session。

`packages/workbench/presets/samsara-operator/agent.cordis.yml`：

```yaml
- id: workbench
  name: cordis:group
  group: true
  isolate:
    samsaraWorkbench: true
  config:
    - id: workbench-tools
      name: '@oldbulb/samsara-workbench/tools'
      inject: [lifecycle, ledger, jobs, approval]
```

两条硬规则，都是撞出来的形状：

1. **preset 里的 service 行必须放进带 `isolate` realm 的 group**，否则它发布进 root realm，第二个 session 挂同一个 preset 时撞车，`dsh-agent-presets` 在 mount 时拒绝（`agent-presets/src/index.ts:421-432` 解释了 realm 的可见性）。
2. **preset 行不能拥有 host 要读的服务。** `ctx.lifecycle` 要一个 `ctx.executor`（跑 attempt 的 `runSet`）；CLI profile 里它由 `samsara-runner` 行提供，workbench profile 把那行 `disabled` 了（B4）。如果让 preset 里的 tools 行来 `ctx.provide('executor', …)`，它会随**第一个**挂它的 session 一起 dispose，后面的 session 全部拿不到。所以执行器是 host 平面的一行（`packages/workbench/src/executor.ts`，16 行，只做 `ctx.provide('executor', { runSet })`），`cordis.patch.yml` 里 `workbench-executor` 先于一切 session 存在。判据：**一个 host 行 `inject` 的服务，必须由 host 行提供**——injection 在任何 session 存在之前就解析完了，没有 agent 可以按 key 取（dsh 自己的注释，`agent-presets/src/index.ts:427-429`）。

工具本身：`defineTool` 的 `output: { schema, render, presentationMeta }` 必填；我们所有工具共用一个 `OUTPUT`，把结果里的 `link` 放到文本第一行和 `presentationMeta`（`tools.ts:186-199`）——因为 markdown sanitizer 会剥掉相对 URL，链接必须是 `http://<host>:<port>/samsara/…` 的绝对形式，从 `ctx.webServer.host/port` 拼。每个工具的注册包在 `ctx.effect` 里（`tools.ts:873`）。

**花钱的工具在 `execute` 里问人**（`tools.ts:395-404`）：先在 ledger 上查 experiment 预算、超了直接 `BUDGET_EXCEEDED` 不问任何人；再 `await deps.approval.request({ agent, toolName, callId: exec.callId, reason, signal: exec.signal })`，四种结果里只有 `'allowed-once'` 是放行（`packages/interaction/user-approval/src/index.ts:82, 253-257`）；`reason` 是纯文本，所以报价就写在里面：`<what> ≈ $<usd> (<n> attempts)`。dsh 会在 session log 里写 `approval/asked` / `approval/decided` 一对审计事件（`user-approval/src/index.ts:44-55`），notebook 把它们镜像成两行。注意 approval 只能从**活着的 root agent 的一个开着的 turn** 里发起——subagent 拿不到。

### C14. 长任务作为 operator agent 拥有的 job

一次 campaign 会跑几十分钟，超出一个 turn。dsh 的 `ctx.jobs.start({ kind, label, owner, run })`（`packages/jobs/jobs/src/index.ts:82`）是为此设计的：`run()` 同步返回 `{ cancel, done, readOutput }`，模型端有 `job_list / job_output / job_kill`（preset 里挂 `dsh-tool-jobs`），完成时唤醒 owner。

我们的 `startJob`（`tools.ts:436-468`）：

```ts
id = deps.jobs.start({
  kind, label, owner: agent,
  run: () => {
    const ac = new AbortController()
    const done = run(ac.signal, log, onRound).then(
      (detail) => ({ status: 'completed', detail }),
      (e) => ({ status: ac.signal.aborted ? 'killed' : 'failed', detail: messageOf(e) }),
    ).then(settle)
    return { cancel: (reason) => { ac.abort(reason ?? 'killed') }, done, readOutput: () => { … } }
  },
})
jobTags.set(id, tag)
```

要点：

- **owner 是精确的那个 `Agent` 对象**；每一次 `get/read/wait/kill` 都要带 owner，session fence 不匹配就抛（`jobs/src/index.ts:47-57, 96-120`）。所以 `samsara_campaign_stop` 用 `deps.jobs.kill(id, agent, reason)`，别人 session 的 job 抓不到（`NOT_OWNER`）。
- **job 不给你 abort signal，自己建 `AbortController`**，并且**不要把 `exec.signal` 传下去**——那是工具调用这一 turn 的信号，turn 结束它就 abort，job 会被误杀。`ac.signal` 要接进 job 里 spawn 的每一个子进程（B13/E4：子进程树归 subprocess 服务，不归 job）。
- **进度是拉的**：`readOutput` 返回自上次读取以来的行并清空；我们把 campaign 的事件行（`formatEvent`）塞进去。UI 只显示 label + 状态。
- **完成通知走 jobs 服务，不走工具结果**：唤醒是 `followup`（idle）或 `inject`（busy），有 `maxConsecutiveWakes` 预算。它不是 `samsara_*` 的返回值，所以 notebook 要**自己**补一行 `job/done`（`tools.ts:413-434`）把完成通知和 ledger 绑起来——否则"campaign 报了 promote"这句话在记录里没有出处。
- **nothing survives restart**。job 在内存里；durable 的是 ledger 上的 round 行。所以有 `jobTags`（`packages/workbench/src/jobs.ts`）：job 跑着的时候记它挂在哪个 experiment、开了哪些 round，`/samsara stop <round-id>` 靠它找 job，`/samsara reconcile <round-id>` 靠它拒绝关掉一个本进程正在驱动的 round。重启后 tag 没了，round 行有没有人在驱动 ledger 说不出来——这就是 reconcile 是人敲的命令、不是启动副作用的原因（`packages/workbench/src/startup.ts`）。
- campaign **在 job 里永远不自己取 consent**：碰到 `pending consent` 就暂停返回，完成通知里写明该请人敲 `/samsara approve <id>` 还是 `/samsara reveal <id>`（`tools.ts:325-331`）；`autoHoldout: false` 写死（`tools.ts:523`）。

### C15. SSE 走 `ctx.webServer` 的 prefix 路由，不碰 host frame

dsh 的 `MuxFrame` / `HostFrame` 联合是**闭合**的，插件加不了新的帧类型；`host/remote-event` 的白名单是一个 const 数组。想把一轮的实时进度推到页面，只有两条路：`ctx.jobs` 的 `session/jobs` 帧（只有 label + 状态），或者**自己的路由**。我们选后者，而且不用 `registerUpgrade`（WebSocket），用最朴素的 `text/event-stream`——C5 的 prefix 路由已经覆盖了 `/samsara/rounds/<id>/events`，handler 是 node:http 签名，SSE 就是 `res.write` 几行文本。

`packages/ui/src/sse.ts:43-65`：

```ts
res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' })
res.write(`retry: ${String(opts.refreshMs)}\n\n`)
const off = lifecycle?.on('lifecycle/event', (event) => {
  if (roundOf(event) === opts.roundId) res.write(formatEvent(event))
})
const timer = setInterval(() => { res.write(`: ${new Date().toISOString()}\n\n`) }, opts.refreshMs)
const close = () => { clearInterval(timer); off?.(); if (!res.writableEnded) res.end() }
req.on('close', close)
res.on('close', close)
```

三条经验：

- **事件源是我们自己的 service**（`ctx.lifecycle` 的 `on('lifecycle/event', …)`，`packages/lifecycle/src/index.ts:179-195`），不是 session log——一轮的进度发生在 host 平面（runner / campaign），没有 session 事件对应。UI 用 `ctx.get('lifecycle')` 按请求取（软依赖，B3），没挂时只发心跳。
- **上线前先过滤**：`wireEvent` 把 judged compare 的 `per_task` 剥掉再 `JSON.stringify`（`sse.ts:30-36`）——loopback 无 auth，同机的 proposer 能连上（S7），所以 SSE 和页面用**同一个** viewer 纪律。
- **心跳 + 双向 close**：`retry:` 让浏览器自己重连；每 `refreshMs` 一条注释行让代理不掐连接；`req` 和 `res` 的 `close` 都要挂，否则客户端走了 listener 还留在 lifecycle 上。页面没有 SSE 也是完整的——JS 只在两次刷新之间挪一下状态和计数，这样 `curl` 和测试拿到的 HTML 就是全部。

---

## D. 工程节奏

### D.1 实际的分步与可观测门

设计文档里的 P0–P6 和实际执行的 M0–M5+P6 基本对齐。每一步都配一个**可观测门**——这是这套节奏能跑起来的核心，不是形式主义。

| 步 | 建什么 | 门（做完必须能观察到的） |
|---|---|---|
| **M0 / P0** | workspace、kernel shim、schema、host profile 接上网关 | `dsh --profile host --dump-config` 里有你的路由；一次 headless completion 成功 |
| **M1 / P1** | pack loader + book + gate-default，**纯 TS，不碰 dsh 运行时** | truth/score stdout 过契约校验；3 次 rerun 得噪声底；null 兄弟的 false-keep < α·K；纯噪声任务集零晋升；阳性对照能晋升 |
| **M2 / P2** | kernel + scope + workdir + submit + loops-dsh + loops-claude-code + runner；bundle 接进 profile | 20/20 valid submit；dispose 后零进程、registry 复原、profile 文件 sha 不变；两条 loop 各 8/8；**回放测试绿** |
| **M3 / P3** | gate seam + ledger on storageDomain（先 json 后 sqlite） | 重启后 ledger 一致；无 consent 的 promote 被拒 |
| **M4** | scope 的 diff scan、signoff（Ed25519 over unix socket）、champion（profile writer + 热应用校验） | consent 只认 socket；热应用 sha 校验通过 |
| **M5** | proposer 适配器（`claude -p` / human）、`round` 子命令 | 真实跑通一轮 propose→challenge |
| **P6** | UI 路由、跨 harness 认证表 | 两条 loop 两行；facts 不同拒绝 A/B；UI 首屏四块信息 |
| **后续** | `--parallel N`、durable steps + `--resume`、landlock、env lock、OTel 导出 | 32 并发 32/32；SIGINT 后 resume 保留已完成的 |

### D.2 哪些能并行，哪些必须串行

**必须串行（有真依赖）：**

- kernel → 其他所有需要 dsh 运行时的包。kernel 不定下来，`ctx.tools` 之类根本过不了类型。
- loops seam（`@oldbulb/samsara-loops` 的类型 + registry）→ 任何 provider。**先把 seam 的类型写死、写一个 null provider 打通端到端，再写第一个真 provider**——我们 `d4f393c` 一个 commit 里 seam + null + 两个真 provider 一起落，事后看 null provider 是当天最值钱的东西：它让 runner / ledger / 打分链路可以在零模型成本下反复跑。
- bundle patch 行 → profile 安装 → `--dump-config` 冒烟。这三步顺序错了会浪费很多时间在错误的地方 debug。
- 录制 fixture → 回放测试。fixture 必须来自一次真实运行。

**可以并行（我们实际就是分开做的）：**

- **纯 TS 的东西完全不依赖 dsh**：pack loader、book、gate 的统计、diff scan、env sha、打分契约。M1 整个里程碑一行 dsh 代码都没有，可以和 M0 的环境搭建并行。这是刻意的分层——设计文档里写死了 "P1: `pack` + `book` + `gate-default` as pure TS，no dsh runtime"。
- 两条 loop provider 之间互不依赖（一个 in-process、一个子进程）。
- UI / export / certify 这些消费者，只要 ledger 的读接口定了就能各自推进。

**一个反模式**：不要在 seam 还在变的时候同时写两个 provider。我们是 dsh provider 先跑通、claude-code 跟着抄，seam 的形状在第一个 provider 上就定住了。

### D.3 测试策略

- **默认离线**。273 个测试全部不碰网络。真实模型调用只在两个地方发生：录制 fixture，和明确的 e2e 手动验证。
- **fixture 是一等公民**。`tests/fixtures/runs/` 下面存着真实跑出来的 attempts.jsonl（8/8 的 smoke、32/32 的并发、16 并发被 SIGINT 打断后 resume 的、第一轮真实 `claude -p` 的提案和 skill）。它们让下游逻辑（gate、summary、export、resume）可以在**真实数据形状**上测，而不是编造的。
- **测试要么真、要么明确假**。`packages/ui/tests/route.test.ts` 用**真的** webserver 和**假的** ledger/champion/signoff，边界画得很清楚，没有半真半假的中间态。
- **环境不满足就 skip，附带重建命令**。回放测试的三个 skip 分支每个都打印怎么修。
- **门是断言，不是文档**。"dispose 后 profile sha 不变"这种约束写成测试，不写成 README 里的一句话。

### D.4 关于速度

46 个 commit 集中在两天（2026-08-22 到 08-23）。这个速度不是靠少写测试换来的——是靠**先做完整的源码调研**换来的：动手之前先把三块读到 file:line 级并写成了笔记——cordis/loader/profile/storage/session 的内部机制、agents/tools/subprocess/llm-replay/storage-domain 的 API 参考、web 路由与 bundle 组合规则。本文 B 节里能立刻给出根因的坑，多半是因为那些笔记里已经写着答案；真正现场撞的（B7 的 workspace、B8 的退出竞态、B12 的 `/private`、B14 的负成本）都是调研覆盖不到的运行时行为。

**这条经验可以直接抄**：在一个 pre-release、明确说"不做兼容 shim"的内核上盖房子之前，先花时间把你要用的那几个 seam 的源码读到 file:line 级别并写下来。

---

## E. 给 dsh 的反馈（上游候选清单）

按"价值 / 代价"排。前两条已记在 `ops/README.md`。

### E1. CLI 应该自带 `dsh-storage-sqlite`

- **现状**：CLI 的依赖里有 `dsh-storage`、`dsh-storage-domain`、`dsh-storage-json`，没有 `dsh-storage-sqlite`。
- **为什么疼**：任何要单写者 + WAL + backup API 的控制平面记录都得用 sqlite。用户唯一正确的装法是 `cd "$(npm root -g)/@deepseek-ai/dsh" && npm i @deepseek-ai/dsh-storage-sqlite` —— 往自己 profile 里装是**错的**（B6），而错法不会报错，只会诡异。
- **价值**：高。消掉一整类"两份 cordis"故障。
- **代价**：低。CLI 的 `dependencies` 加一个包（`healProfilesModuleFallback` 的 BFS 会自动把它 symlink 进 profiles fallback）。json 后端已经在里面了，多一个不改变任何架构。

### E2. 启动器的退出竞态：watcher 应该在发布 app 参数之前打开，或者 `appExit` 关掉它们

- **现状**：`runProfile` 在 `boot()` 返回后无条件开 hmr + 两个 patch watcher（`apps/cli/src/profile-boot.ts:262-295`）。守卫只看 `signalShutdown.signal.aborted` 和 `ctx.fiber.state === ACTIVE`，而 `appExit` 走 `shutdown.shutdown()` 不 abort `signalShutdown`。
- **为什么疼**：任何 boot 后 ~3 秒内完成的一次性命令都可能不排空。每个写一次性 app 的人都得自己发明一个 unref 强退（我们的 `DRAIN_GRACE_MS`）。
- **两个修法**：(a) 在 `provideCmdline` **之前**开 watcher（顺序换一下）；(b) 让 `appExit` 也 abort `signalShutdown`，或者让 shutdown 路径显式关掉 watcher。
- **价值**：高，影响所有一次性 app（`dsh-headless` 只是碰巧慢到不触发）。
- **代价**：低到中。是启动顺序的调整，需要一个覆盖"boot 后立刻 appExit"的回归测试。

### E3. 进程沙箱只接受 mode，不接受路径白名单

- **现状**：`SandboxMode` 是 `'read-only' | 'workspace-write' | 'danger-full-access'`；per-call 的 `SandboxExecutionPolicy` 是 `{mode, workspaceRoot, sessionId?}`（`docs/subsystems/sandbox.md`）。没有"额外可读根"的表达。
- **为什么疼**：我们要的策略是"**只**能写 attempt workdir；**只**能读 pack 的 `skill/` 和 `loader/`、runtime venv、这一条任务的 fixture 缓存；**绝不能**读 `tasks/`、`data/`（真值）、`bin/truth`、`bin/score`"。这在 `workspace-write` 里表达不出来——它要么给你整棵 workspace，要么什么都不给。结果是 in-process agent 的 bash 工具没法按我们的策略收敛，`loops-dsh` 只能把 `HarnessFacts.sandbox` 记成 `'none'` 并在注释里写明为什么（`packages/loops-dsh/src/index.ts:67-72`）。我们只好在框架侧另建 `@oldbulb/samsara-sandbox`，Linux 上直接调 `node-addon-landlock-run` 给**子进程**做 allow-list——但那覆盖不到 in-process 的 bash。
- **提议**：给 `SandboxExecutionPolicy` 加一个可选的 `extraReadOnlyRoots` / `extraWritableRoots`（Landlock ruleset 本来就是 allow-list，backend 侧几乎是直通；Seatbelt 和 Windows ACL 需要各自映射）。
- **价值**：高，对任何"跑不可信 agent 去解题、同时手里握着答案"的评测系统都是刚需。
- **代价**：中。要动 seam 的类型 + 三个 backend 的映射，还要定义"backend 表达不了额外根时怎么办"（大概是 `partial` enforcement 或者 fail-closed）。

### E4. schemastery：嵌套必填的坑该有个说法

- **现状**：`Schema.object()` 自带默认值 `{}`（`vendor/schemastery/src/index.ts:852-853`），所以"可选的嵌套对象 + 必填的内部字段"表达不出来，缺省时报的是 `$.x.y missing required value`——错误信息指向内部字段，完全掩盖了真正的原因（外层被默认成了 `{}`）。
- **提议**（价值递增，代价也递增）：(a) 文档里明说；(b) 错误信息里带上"（外层 `x` 缺省，已按 `{}` 处理）"；(c) 提供 `.optional()` 之类的显式修饰，缺省时**不**填默认值。
- **价值**：中。踩一次浪费半小时，但每个写插件 Config 的人都会踩。
- **代价**：(a) 极低，(b) 低，(c) 中且可能影响既有行为。

### E5. "Service 类的行必须 `export default`" 应该进文档

- **现状**：`unwrapExports` 只认 `default`（`vendor/loader/src/index.ts:192-199`），失败时的报错是 `invalid plugin, expect function or object with an "apply" method, received object`——**它不会告诉你缺的是 default export**。dsh 的插件编写约定（`docs/cordis-primer.md`、`packages/README.md`）讲的是 `name`/`inject`/`Config`/`apply` 这套函数式形态，Service 类作为一行挂载的写法没有明确写出来。
- **提议**（价值递增）：(a) 在插件编写文档里加一句"Service 类要 `export default`"；(b) 在 `registry.ts:319` 的错误信息里加一句提示——检测到 `typeof plugin === 'object'` 且命名空间里有 `Service` 子类却没有 `default` 时，直接点破。
- **价值**：中高。这是新人写第一个 service 包时的第一个坑，而错误信息把人往完全错误的方向带。
- **代价**：(a) 几乎零；(b) 低。

### E6. 顺手记下的几条（价值中等，未展开）

- **patch 的静默失败**：`id` 打错、`name` 不匹配都只 warn（`vendor/include/src/index.ts:111-119`）。`--dump-config` 能看见，但普通 boot 路径下这些 warning 的可见性值得提升——一个"这个 patch 谁也没命中"的启动期告警很便宜。
- **`dsh plugin` 的解析失败等价于"不是 bundle"**：`exportsPatch` 解析不到就返回 false（`apps/cli/src/plugin.ts:36-45`），于是 reconcile 会把 bundle 静默从层列表里摘掉。区分"解析失败"和"确实不是 bundle"，前者应该 warn。
- **profile 目录该自带 `pnpm-workspace.yaml`**：`initProfile` 生成 profile 时顺手写一个最小的（`packages: [.]`），能直接消掉 B7。dsh 已经在 git 依赖的 `allowBuilds` 提示里提到这个文件（`plugin.ts:150-153`），说明它本来就该存在。
- **subagent 适配器只留最终文本**：`subagent-claude-code` / `subagent-codex` 丢掉 usage、tool 轨迹、transcript（README 自己列在 Known Limitations 里）。想拿它们做可训练的执行器就得自己写 provider。这是"已知局限"而非 bug，但如果 dsh 想让外部 harness 成为一等执行器，这个 seam 需要能透出消息流。

### E7. session event 应该有一个 out-of-repo kind 的注册面

- **现状**：`KNOWN_SESSION_EVENT_TYPES` 是仓库生成的闭集（`packages/core/session/src/known-event-types.ts:19`）；持久化读路径拒绝解释含有集外类型的 log（除非事件带 `ignorable`），resume 直接 `SessionFormatUnsupportedError`。源码注释自己写着："Downstream (out-of-repo) plugin events are outside this list by construction; a registration surface for them is deferred until such a consumer exists"（`:14-17`）。
- **为什么疼**：我们就是那个 consumer。预注册（`/samsara predict`）和 consent 本质上是**对话里发生的事**，最自然的记录位置是 session log；现在只能落成 ledger 行、用 `session_id` + `command_id` 反向关联（`docs/design/workbench.md` § The notebook）。`append()` 也不能设 `ignorable`，所以连"写进去但允许旧 harness 跳过"这条路也没有。
- **提议**：`ctx.sessions.registerEventType(name, { ignorable?: boolean })` 之类的注册面，或者至少让插件能在 `append()` 时标 `ignorable`。前者要动持久化读路径的校验，后者是一个字段。
- **价值**：中高。任何想把领域事件（不只是我们）放进对话记录的插件都会撞上。
- **代价**：低（`ignorable`）到中（注册面 + 生成脚本的例外）。

### E8. jobs 需要一个用户侧的 kill 入口

- **现状**：`ctx.jobs.kill(id, caller, reason)` 有 owner fence（`packages/jobs/jobs/src/index.ts:112-120`）；模型侧有 `job_kill`（`dsh-tool-jobs`）；UI 侧 `client/ui-jobs` 只渲染列表和状态点（`packages/client/ui-jobs/src/client/JobListAction.tsx:88-120`），没有任何按钮能发 kill。
- **为什么疼**：花钱的长任务是 agent 起的，但**想停下来的是人**。现在人只能让 agent 去调 `job_kill`（要一个模型 turn，agent 还可能不听），或者像我们一样自己写一条 `/samsara stop <job-id|round-id>` 命令绕过去（`packages/workbench/src/commands.ts`）。一个"我的 job 我能停"的 UI 入口，是任何会花钱的 job 的基本安全件。
- **提议**：`client-ui-jobs` 的每一行加一个 stop 按钮，走一条 `jobs.kill(sessionId, jobId)` 的 typert remote（owner 就是这个 session 的 agent，fence 天然满足）。
- **价值**：中高。对所有"job 会花钱或占资源"的插件通用。
- **代价**：低。host 侧 API 已经在，缺的是一条 remote 和一个按钮。

---

## 附录：速查表

**新起一个 dsh 插件包，检查清单**

1. `package.json`：`@deepseek-ai/cordis` 同时进 `peerDependencies` 和 `devDependencies`（同一 range）；`@deepseek-ai/schemastery` 是运行时 `dependency`。
2. 形态二选一：函数式（`export const name` / `inject` / `Config` / `apply`）或 Service 类（**加 `export default`**）。
3. `Config` 用 schemastery；嵌套对象的内部字段**不要** `.required()`。
4. 硬依赖进 `inject`，软依赖用 `ctx.get(name)`。
5. 别人包声明的 `ctx.*` 属性，记得 `import type {} from '<那个包>'`（或者集中在你的 kernel 里）。
6. 每一个副作用（路由注册、registry 注册、定时器、domain、子进程句柄）都包 `ctx.effect(() => …, 'label')`。
7. 有顺序依赖的清理写进**同一个** disposer（异步 disposer 之间是并发的）。
8. 加一行进 bundle 的 `cordis.patch.yml`，`id` 稳定，config 里只放领域中性的默认值。
9. `dsh plugin --profile <p> install` → `dsh --profile <p> --dump-config | grep <你的 id>`。

**常见报错 → 去看哪一条**

| 报错 / 症状 | 看 |
|---|---|
| `invalid plugin, expect function or object with an "apply" method` | B1 |
| `$.x.y missing required value`（而你根本没写 `x`） | B2 |
| `cannot get property "x" without inject` | B3 |
| 自己的子命令被拒、进程直接退出 | B4 |
| loader 解析不到兄弟包 | B5 |
| 服务身份对不上 / 两份 cordis | B6 |
| bundle 从 `dsh.profile.bundles` 里静默消失 | B7 |
| 一次性命令跑完不退出 | B8 |
| patch 之后别的 config 字段没了 / patch 完全没生效 | B9 |
| 并发跑批端口占用 | B10 |
| 测试里 socket bind 失败 | B11 |
| 回放测试在 macOS 上路径对不上 | B12 |
| dispose 后子进程还在 | B13 |
| 成本算出负数 | B14 |
| `ledger domain is not open` | B15 |

**关键源码位置（dsh @ b150a551）**

| 主题 | 位置 |
|---|---|
| 插件形态 / `invalid plugin` | `vendor/cordis/src/registry.ts:95-131, 222-229, 319` |
| `unwrapExports` | `vendor/loader/src/index.ts:192-199` |
| inject 守卫 | `vendor/cordis/src/reflect.ts:135-165` |
| `ctx.effect` / fiber 生命周期 | `vendor/cordis/src/fiber.ts:265, 403-418` |
| patch 应用（整 config 替换、warn） | `vendor/include/src/index.ts:58-127` |
| schemastery 默认值 / required | `vendor/schemastery/src/index.ts:469-483, 752-763, 852-853` |
| profile 加载 / bundle 解析 | `packages/boot/app-boot/src/profile.ts:223-255, 344-403` |
| 合成与 dump | `packages/boot/app-boot/src/index.ts:232-270, 379-404`；`profile.ts:413-420` |
| 启动器（cmdline、退出、watcher） | `apps/cli/src/profile-boot.ts:207-300`；`packages/boot/cmdline/src/index.ts:67-119` |
| `dsh plugin` reconcile | `apps/cli/src/plugin.ts:36-92, 115-153` |
| agent 创建 / setup 窗口 | `packages/core/agent/src/index.ts:69-71, 80-133, 172-175, 405-415` |
| in-process 子 agent 驱动（模板） | `packages/subagent/subagent-in-process-driver/src/index.ts:102-232` |
| 工具 register / restrict / guard | `packages/core/tools/src/index.ts:1037-1063, 1071-1098, 1110-1116` |
| 结构化输出工具（模板） | `packages/subagent/subagent-in-process-driver/src/structured.ts:49-141` |
| subprocess seam / env scrub | `packages/subprocess/subprocess/src/index.ts:44, 60-66, 102-140` |
| Claude SDK spawn 覆盖（模板） | `packages/subagent/subagent-claude-code/src/{run,process}.ts` |
| webserver 路由 | `packages/host/webserver/src/index.ts:38-56, 108-145, 256-266` |
| `dsh-web-app` 的 cmdline | `packages/bundle/web-app/src/startup.ts:46-80` |
| storage domain | `packages/storage/storage-domain/src/{spec,index,domain}.ts` |
| llm-replay | `packages/test-support/llm-replay/README.md` |
| 沙箱 mode 契约 | `docs/subsystems/sandbox.md` |

**本仓库的对应实现**

| 主题 | 位置 |
|---|---|
| 单入口 kernel | `packages/kernel/src/index.ts` |
| Service 形态插件 | `packages/loops/src/index.ts`（`export default` 在 :176） |
| in-process child agent | `packages/loops-dsh/src/index.ts:96-195` |
| 子进程 loop + 环境墓碑 | `packages/loops-claude-code/src/{index,env,process}.ts` |
| prefix 路由 UI | `packages/ui/src/index.ts` |
| 内存 scope（`cordis:group`） | `packages/scope/src/index.ts:96-190` |
| storage domain 开/关 | `packages/ledger/src/index.ts:101-107` |
| 命令行拆行 | `packages/runner/src/{startup,index}.ts` |
| 人类命令 + consent | `packages/workbench/src/commands.ts` |
| preset 内工具 + host 执行器行 | `packages/workbench/src/{tools,executor}.ts`、`packages/workbench/presets/samsara-operator/agent.cordis.yml` |
| operator 拥有的 job | `packages/workbench/src/{tools,jobs,startup}.ts` |
| SSE 路由 | `packages/ui/src/sse.ts` |
| bundle / profile 实际写法 | `packages/bundle/cordis.patch.yml`、`profiles/host/{cordis.patch.yml,pnpm-workspace.yaml}` |
| 第二个 profile（叠在 dsh-web-app 上） | `packages/workbench/cordis.patch.yml`、`profiles/workbench/package.json` |
| 回放测试 | `tests/replay/` |
| 真 Loader 组合测试 | `packages/ui/tests/route.test.ts`、`packages/scope/tests/scopes.test.ts` |
| 安装与运维坑 | `ops/README.md` |
