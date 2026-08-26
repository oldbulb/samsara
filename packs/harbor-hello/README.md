# harbor-hello

A pack generated from the Harbor task set `hello-world` by
`tools/pack-from-harbor`; regenerate it there rather than editing it here.

- **Task**: a Harbor task — `instruction.md` in the working directory, the
  task's own image (`harbor/<task>/environment/Dockerfile`), its tests as the
  truth. 1 smoke / 1 held-in / 0 held-out
  tasks; `entity_key` = the task name, `stratum` = the task's first keyword
  or the pack name.
- **Skill**: `skill/SKILL.md`, what the installed agent reads — the thing
  being optimized.
- **truth** (`in_environment`, bash + coreutils): copies `harbor/<task>/tests`
  to `/tests`, runs `bash /tests/test.sh` from the task's working directory
  under the task.toml verifier timeout, reads `/logs/verifier/reward.json` or
  `reward.txt`; `truth_sha` = sha256 of the task's `tests/`.
- **score**: `reward` (reality) plus one metric per key of `reward.json`.
- **bin/oracle** (bash): Harbor's oracle — `solution/solve.sh` in the
  environment for the attempt whose token it is given; the pack's self-check.
- **Divergence from Harbor**: the working directory also holds
  `instruction.md` (Harbor hands the instruction to the agent as a string)
  and the framework's `.agents/`, `.claude/`, `.task/` and `.tmp/`; a
  test that inspects the working tree itself (file counts, `git status
  --porcelain`) can disagree with Harbor's verdict. And the whole pack —
  `harbor/<task>/tests`, `harbor/<task>/solution`, `tasks/*.jsonl` — is
  mounted read-only into the environment for the whole attempt, so an agent
  that goes looking can read them (E9); Harbor copies `/tests` in only after
  the agent and `/solution` only for its oracle.

## Running it

The attempts need the task's image, so a provider other than `local` — the
`environments-docker` row enabled in the profile — and an installed loop: the
`loops-installed` row enabled with the oracle as its command (the pack is
mounted read-only into the environment at its own absolute path):

```yaml
- id: environments-docker
  disabled: false
  config: { docker: docker }
- id: loops-installed
  disabled: false
  config:
    command: [bash, /abs/path/to/packs/harbor-hello/bin/oracle, '{attempt}']
```

```sh
# the oracle in the task's image: every attempt must score reward 1
dsh --profile host run --pack packs/harbor-hello --loop installed --env docker --set smoke
# a Harbor job of the same tasks into the ledger, no run (packages/runner/README.md, import harbor)
dsh --profile host import harbor <jobDir> --pack packs/harbor-hello --as champion --metric reward
```
