# Deployment shape and adopted practices

Decided 2026-08-23 after surveying current practice in durable execution,
sandboxing, OpenTelemetry GenAI conventions, agentic-RL rollout systems,
SQLite replication and lock-file-based environment pinning.

## Shape: the host runs on a server, the laptop is a client holding the signing key

```
laptop (control-plane client)                  server (host = control plane + data plane)
  samsara --host <name> propose|status|pull      ledger (sqlite on local disk; replicated off-box)
  offline analysis on the read-only mirror       champion · gate · book · signoff (public key only)
  sign-off private key (only here)               worker pool (dsh in-process loops; hot resize)
  git pull ← champion kept rows                  UI /samsara behind the ingress
  host registry in the user's config dir         LLM gateway (model keys only here)
```

Rules: (1) one ledger writer, on the host; the laptop reads a mirror. (2) Sign-off
is a nonce signed with the laptop's private key, delivered over any channel; the
host holds only the public key (E2: the signature is the proof, not the endpoint).
(3) Champion state syncs through git: promote commits the profile's patch layer on
the host. (4) One bundle, two profiles (`host` for local development, one for the
server).

## Adopted practices (implementation items)

1. **Durable steps (journal + idempotency key).** Each attempt pipeline step (`materialize`, `loop`, `submit`, `truth`, `score`, `record`) writes a marker `<attemptDir>/.steps/<step>.json` when it completes; the step key is `attemptId:step`. `--resume` on a run directory re-enters the pipeline and skips completed steps (the loop is never re-run if its `finished` marker exists; truth/score re-run only if their markers are missing). Ledger rows are written from the markers, so rows lost on SIGINT are recovered by `--resume`. No workflow engine.
2. **Filesystem isolation for sandboxes (E9).** On Linux, pack `data` commands, loop subprocesses and the proposer run under landlock through dsh's `node-addon-landlock-run` with read access limited to the workdir, the pack's `skill/` and `loader/` (read-only), the runtime venvs, and the fixture cache entry for that task; the pack's `tasks/`, `data/` (truth), `fixtures/.meta`, `bin/truth` and `bin/score` are not readable. On macOS the policy is recorded but not enforced (`sandbox: 'none'` in `facts`). The proposer work directory gets the same treatment.
3. **Environment fingerprint from lock files.** `env_sha` = sha256 over: `pnpm-lock.yaml` sha, each pack's runtime lock (python venv `requirements` hash / package-lock), `claude --version` when the Claude Code loop is enabled, node version, dsh pin, container image digest when present (`$SAMSARA_IMAGE_DIGEST`), and the sorted env var *names* allowlist — never values.
4. **OTel GenAI vocabulary on loop events.** `LoopEvent` carries the OpenTelemetry GenAI semantic-convention names alongside ours: `started`→`invoke_agent` span, `assistant`→`chat` with `gen_ai.usage.input_tokens/output_tokens`, `tool_call/tool_result`→`execute_tool` with `gen_ai.tool.name`, `finished`→`gen_ai.response.finish_reasons`; attempts add `samsara.challenger_id`, `samsara.tier`, `samsara.facts_sha`. `samsara export --format otlp-json` writes spans for a run so any OTel backend can ingest them; dsh's `session-telemetry-otel` remains the in-process path.
5. **Ledger replication** (later): host-local sqlite in WAL mode, streamed to object storage; `samsara pull` restores a read-only mirror on the laptop. Never put a WAL-mode sqlite file on NFS, and never let a second process touch the host's database.
6. **Content-addressed workdir bases** (later, at high concurrency): materialized bases keyed by `(task, skill_sha)`, attempts derived by hard-link/overlay.

Sources: durable execution ([Zylos](https://zylos.ai/research/2026-04-24-durable-execution-agent-runtimes/), [Inngest](https://www.inngest.com/blog/durable-execution-key-to-harnessing-ai-agents)); sandboxes ([Northflank](https://northflank.com/blog/e2b-vs-modal), [LogRocket](https://blog.logrocket.com/comparing-ai-agent-sandbox-platforms-e2b-modal-daytona-and-more/)); OTel GenAI ([OpenTelemetry](https://opentelemetry.io/blog/2026/genai-observability/), [conventions](https://github.com/open-telemetry/semantic-conventions-genai/blob/main/docs/gen-ai/gen-ai-agent-spans.md)); rollout systems ([Jiachen Liu](https://amberljc.github.io/blog/2025-09-05-agentic-rl-systems.html), [rStar2](https://arxiv.org/html/2508.20722), [SkyRL-Agent](https://arxiv.org/pdf/2511.16108), [Polar](https://arxiv.org/pdf/2605.24220)); replication ([Litestream](https://litestream.io/how-it-works/)); environments ([devbox](https://betterstack.com/community/guides/linux/devbox-reproducible/)); local-first control ([harness-remote](https://github.com/giuliastro/harness-remote)).
