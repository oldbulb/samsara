# @samsara/proposers

`ctx.proposers`: the registry of proposer adapters, the `Proposal` contract
(`docs/design/proposers.md`) with its JSON schema, and two v1 adapters:
`claude-p` (an external `claude -p` process) and `human` (the operator supplies the patch).

A proposer never sees truth: it receives a directory of files rendered by the ledger
(`ledger.read(view, 'proposer')`) and a scratch work directory, and returns a `Proposal`.
Validation, the diff scan (E8/S5) and the held-out task-id check stay with the host;
`assertTaskIdsWithin(proposal, heldInIds)` is exported for it.

```ts
interface ProposerAdapter {
  name: string; version: string; configSha: string
  propose(input: { viewDir: string; workDir: string; signal: AbortSignal; parent?: string }): Promise<Proposal>
}
```

`parent` comes from the caller (the champion row id); an adapter falls back to a `parent`
written in the draft. `proposer.config_sha` on the returned Proposal is the adapter's `configSha`
and becomes `optimizer_config_sha` on the challenger row.

## Plugins

| module | name | inject | registers |
|---|---|---|---|
| `@samsara/proposers` (default export) | `proposers` | — | the service |
| `@samsara/proposers/plugin-claude-p` | `proposer-claude-p` | `proposers`, `subprocess`, `credentials` | `ClaudePAdapter` |
| `@samsara/proposers/plugin-human` | `proposer-human` | `proposers` | `HumanAdapter` |

## `claude-p`

One proposal = one process:

```
<command> [args…] -p <rendered prompt> --output-format json --max-turns <maxTurns> --permission-mode bypassPermissions
```

spawned through `ctx.subprocess.spawn` inside the plugin's own effect (disposing the scope
terminates the child), `cwd = workDir`, `stdin` ignored, stdout/stderr collected and saved as
`<workDir>/claude-p.stdout.json` / `claude-p.stderr.txt`. The prompt (template
`templates/propose.md`, placeholders `{{viewDir}}`, `{{workDir}}`, `{{schema}}`) asks the model to
read the view, write a full replacement skill to `<workDir>/skill/` and `<workDir>/proposal.json`
(draft schema: `surface`, `patch`, `intent`, `prediction`, optional `parent`), naming only held-in
task ids. The adapter validates the draft, checks `skill_dir` stays inside `workDir` and holds a
`SKILL.md`, stamps `parent` and `proposer`, and returns the Proposal. Exit ≠ 0, timeout
(child terminated) and abort all reject.

Child environment (E5/E6), explicit and nothing else beyond `scrubbedParentEnv()`:

| variable | value |
|---|---|
| `ANTHROPIC_AUTH_TOKEN` | resolved by the plugin from `credentialRef` via `ctx.credentials`; reaches the adapter only as an env map, never logged |
| `ANTHROPIC_BASE_URL` | `baseUrl` (omitted when unset) |
| `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL` | `model` (omitted when unset) |
| `CLAUDE_CONFIG_DIR` | `<workDir>/.claude-config` |
| `HOME`, `TMPDIR` | `workDir` |
| `DISABLE_TELEMETRY`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `1` |

`proposer.version` is parsed from `<command> --version` (probed once per adapter, `unknown` on
failure). `configSha` = sha256 of the canonical resolved config (`command`, `args`, `model`,
`baseUrl`, `maxTurns`, `timeoutMs`, `graceMs`) with the template replaced by its sha256;
`credentialRef` is excluded.

### Pointing it at a gateway

```yaml
- id: proposers
  name: '@samsara/proposers'
- id: proposer-claude-p
  name: '@samsara/proposers/plugin-claude-p'
  config:
    command: claude              # or an absolute path; default 'claude'
    model: <model id the gateway routes>
    baseUrl: https://<gateway host>/<route>   # becomes ANTHROPIC_BASE_URL
    credentialRef: PROPOSER_TOKEN             # name resolved through ctx.credentials → ANTHROPIC_AUTH_TOKEN
    maxTurns: 25                 # default
    timeoutMs: 600000            # default
    # promptTemplate: /path/to/custom.md   # changes configSha
```

Store the token under the ref name with the host's credential plugin (never in the profile and
never in the parent environment: `scrubbedParentEnv()` drops credential-shaped names, so only the
explicit injection above reaches the child). The gateway sees a standard Anthropic-API client with
`Authorization: Bearer <token>`; per-proposal cost attribution works the same way as for loops —
give `baseUrl` a route segment per proposer.

## `human`

```yaml
- id: proposer-human
  name: '@samsara/proposers/plugin-human'
  config:
    skillDir: ./candidates/v2     # relative paths resolve against workDir
    intent: "Add an explicit verification step before submitting."
    prediction: { metric: pass, direction: up, predicted_fixes: [t3], at_risk: [t1] }
    # or, for another surface:  surface: prompt, rows: [ { id: …, config: … } ]
```

## Tests

`pnpm --filter @samsara/proposers test` — schema validation, `HumanAdapter`, `ClaudePAdapter`
against a fake spawn that writes `proposal.json` + `skill/` (argv shape, env contents and
absence of inherited `*_KEY`/secret names, timeout and abort terminate the child, `configSha`
stability), the service and both plugins. No process is started and no network is touched.
