# ops — install and deployment notes

## dsh CLI install

- `npm i -g @deepseek-ai/dsh@0.1.1-rc.2` (flat layout). `pnpm add -g` produces an isolated layout in which the loader cannot resolve sibling packages.
- The CLI ships `dsh-storage`, `dsh-storage-domain` and `dsh-storage-json` but **not** `dsh-storage-sqlite`. The ledger uses sqlite (E6: single writer, WAL, backup API), so install it *into the dsh installation* — not into the profile, where a second copy of `dsh-storage`/`cordis` would shadow the CLI's own:

  ```sh
  cd "$(npm root -g)/@deepseek-ai/dsh" && npm i @deepseek-ai/dsh-storage-sqlite@0.1.1-rc.2
  ```

  Upstream candidate: ship `dsh-storage-sqlite` in the CLI's dependencies (tracked for the post-P4 PR list).

## Host profile

- `profiles/host` is symlinked to `~/.dsh/profiles/host`; after a fresh clone run `dsh plugin --profile host install` (links `packages/bundle` and the `@oldbulb/samsara-*` packages; `profiles/host/node_modules` is gitignored).
- Credentials: a named reference, resolved per request through `ctx.credentials` — `~/.dsh/.credentials.yaml`
  under `refs.`, or plain environment. Never in the repo. `apiKeyEnv` (on the LLM row) and `credentialRef`
  (on the loop, proposer and runner rows) name the same reference.
- The ledger lives at `<cwd>/data/ledger/samsara_ledger.sqlite` (cwd-relative because bundle rows are `!!js`-free); run `dsh --profile host run ...` from the repo root or pin an absolute `path` in `profiles/host/cordis.patch.yml`.

## Running attempts

```sh
dsh --profile host run --pack packs/coding-tasks --loop null|dsh|claude-code --set smoke --limit 2 --out <dir>
```

`null` never calls a model. `dsh` and `claude-code` call the model through the configured gateway; keep real runs to smoke/holdin subsets and record fixtures (`tests/replay/record.overlay.yml`) afterwards so tests stay offline.
- dsh launcher: a one-shot app that calls appExit within ~3 s of boot races the post-boot patch-file watchers (hmr registerConfig) and the process never drains; samsara-runner works around it with an unref'd forced exit. Upstream candidate: open watchers before publishing app args, or make appExit close them.
- dsh CLI should ship dsh-storage-sqlite (see above).
- runner SIGINT: a few ledger writes can be lost when the ledger domain is disposed concurrently ('ledger domain is not open'); attempts.jsonl is complete and importable. Fix = flush the writer queue before the runner's disposer releases, or order disposal.
