# @samsara/ui

The read-only `/samsara` page and its JSON API, as a host plugin on
`ctx.webServer` (dsh's `@deepseek-ai/dsh-host-webserver`). Binding design:
`docs/design/ui-and-certification.md`.

## Plugin

```
name:    samsara-ui
inject:  [webServer, ledger, champion, signoff]
config:  { basePath: '/samsara', refreshMs: 5000 }   # both optional
```

One `prefix` route is registered through `ctx.effect`, so disabling or
reloading the row removes it. Config comes only from the row: the plugin never
parses the command line (a co-resident `web-startup` row would reject unknown
flags and exit the process).

| request | response |
|---|---|
| `GET <base>` / `<base>/` | `text/html` — the self-contained page |
| `GET <base>/api/summary` | `{champion, lastSettlement, tiers:{smoke,holdin,holdout,live}, pendingSignoffs}` |
| `GET <base>/api/challenger/:id` | `{row, lineage, attempts, scores, compares, consents, prediction_vs_observed}` |
| `GET <base>/api/certify/:skillSha` | `{skill_sha, rows:[{loop, adapter_version, facts_sha, tasks, pass_rate, utilization, cost_mean, verdict, gate_method, revoked, challengers}]}` |
| anything else under the prefix | `404` JSON |
| non-GET | `405` JSON |

Every ledger read is `ctx.ledger.read(view, 'human')`; the page has no way to
ask for another viewer. Sign-off never goes through HTTP (E2): the pending
sign-offs panel shows the `samsara-signoff confirm …` command with the socket
path filled in and `--key` / `--who` left as placeholders. No credential and
no private-key path is ever read or rendered.

## Page

Inline HTML + one `<script>`, no external assets, system font stack, light and
dark via `prefers-color-scheme`. It fetches `/api/summary` every `refreshMs`
and renders the four panels in the design order — Champion, Last settlement,
Challengers by tier (smoke → holdin → holdout → live), Pending sign-offs. With
`?challenger=<id>` the drill-down panel (coordinates, lineage, attempts with
per-task scores, compares, consents, prediction vs observed) is rendered above
them.

## Composition

Add the webserver row and this row to a bundle patch (never mount
`@deepseek-ai/dsh-web-app` for this; see `docs/dsh-plugin-notes.md` B4):

```yaml
- insert:
    - id: webserver
      name: '@deepseek-ai/dsh-host-webserver'
      config: { host: 127.0.0.1, port: 3099 }
    - id: samsara-ui
      name: '@samsara/ui'
      inject: [webServer, ledger, champion, signoff]
      config: { basePath: /samsara, refreshMs: 5000 }
```

Then `dsh --profile host …` and open `http://127.0.0.1:3099/samsara`.

## Build and test

```
pnpm --filter @samsara/ui build
pnpm --filter @samsara/ui test      # vitest, offline
```

`tests/api.test.ts` unit-tests the builders and the handler with a fake
ledger/champion/signoff; `tests/route.test.ts` boots the real webserver on
port 0 through the Loader with the plugin and fake service rows and fetches
the page and the API.

## Notes

- `proposer` in the summary is the row's `optimizer_config_sha` (short): the
  challenger row carries no proposer name@version.
- `cost_ratio` is derived from attempts: mean `cost.usd` of the challenger
  over the mean of the compared row at the compare's tier; `null` when either
  side has no usd cost.
- `utilization` in the certification table is the mean of
  `attempts.skill_utilization.utilization` (number) or `read` (boolean) when
  present, else the string `inline`.
