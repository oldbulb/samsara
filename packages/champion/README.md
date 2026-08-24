# @oldbulb/samsara-champion

`ctx.champion`: the served configuration. The champion is an alias to a set of content-addressed refs (`surface:sha`); its on-disk form is a generated section at the end of the host profile's patch layer (`profiles/host/cordis.patch.yml`). Promotion needs two things the loop cannot write, a gate verdict of `promote` and a `consents` row from signoff, and is proven by recomposing the profile exactly as `dsh --profile <name> --dump-config` does and hashing what the kept rows read back as (E7).

## Layout

| module | export | what |
|---|---|---|
| `@oldbulb/samsara-champion` | `Champion` (default export, cordis Service on `ctx.champion`, inject `['ledger', 'signoff']`), `Config`, `ChampionError` | the service |
| `@oldbulb/samsara-champion/state` | `ChampionState`, `KeptPatch`, `stateOf`, `stateSha`, `renderProfilePatch`, `parseProfilePatch`, `verifyHotApply`, `replayCheck` | pure: text/data in, text/data out |
| `@oldbulb/samsara-champion/settlement` | `SettledEvent`, `RescoreEvent`, `planRescore`, `compareRowOf` | pure settlement bookkeeping |

`Config = { profileDir, skillStore }`. `profileDir` must be `<home>/profiles/<name>` (the layout `loadProfile` resolves); `skillStore` holds content-addressed skill snapshots at `<skillStore>/<skill_sha>/`.

## The file

```
<PROFILE_HEADER comment>
<host-owned rows, byte-for-byte as written by hand>

# == samsara champion (generated; do not edit by hand)
# samsara-champion-state: {"kept":[...]}      one canonical-JSON line, the authority
# samsara-champion-sha: <sha256 of that state>
- id: ...                                     the kept rows, keys sorted, no !!js (E3)
# == end samsara champion
```

`parseProfilePatch(renderProfilePatch(state, base))` returns `base` unchanged and a state with the same `stateSha`; rendering the parsed result again is the identity on the text. A hand-written file without a section parses to the empty state. A base of `[]` (the dsh profile template) is dropped so the file stays one YAML array.

## Verbs

- `current()` reads the state from the file (empty when absent).
- `promote(challengerId, consentId)` requires `ledger.challenger(id).verdict.value === 'promote'` (`NOT_PROMOTABLE`) and a consents row with that id, `action: 'promote'`, on that challenger (`NO_CONSENT`). A `skill` challenger's `patch.skill_ref` directory is copied to `<skillStore>/<skill_sha>/` (tmp + rename, skipped when present) and becomes `skill_ref`; any other surface's `patch.cordis` rows are appended. The file is written tmp + rename, then `dump()` recomposes the profile (`loadProfile` + `renderConfigDump` from the kernel) and `verifyHotApply` compares the expected and observed shas over every coordinate the kept rows touch; on mismatch the previous file is restored and `HOT_APPLY_MISMATCH` carries both shas. The ledger row goes `decided` with `verdict.consent_id` set. Idempotent on an already-kept challenger.
- `demote(challengerId, reason)` removes its kept entry, rewrites and re-verifies the file, and sets the row's verdict to `reversed` (`by: 'champion'`, `rule: demote:<reason>`).
- `replayCheck()` compares the file's refs with the refs of its challengers the ledger still records as `decided` + `promote`.
- `onSettlement(event)` (wire to the book's `book/settled`): walks the first-parent lineage of every kept challenger, selects rows whose verdict is `hold` or `promote` and whose attempts touch `event.task_ids`, records the settlement on the ledger (append-only, `triggered_rescoring`), and emits `samsara/rescore` `{settlement_id, challenger_id, attempt_ids, truth_snapshot_id}` per row. Re-running `score` is the runner's job.
- `rescored(challengerId, gateJudgement, {vs_id, tier, truth_snapshot_id})` appends the compare row (`compareRowOf`): for a kept challenger `promote` becomes `confirmed`, anything else `reversed` and triggers `demote`; an unkept row keeps the gate's value.
- `on('samsara/rescore' | 'champion/changed', listener)` returns a disposer.

## Run

```
pnpm vitest run packages/champion/tests
pnpm exec tsc -b packages/champion/tsconfig.json
```

Tests use a temporary `<home>/profiles/p` with no bundles, a fake ledger and an empty `signoff` service; nothing touches the network or a model.
