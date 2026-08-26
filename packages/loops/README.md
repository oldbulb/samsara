
## Environments (`AttemptSpec.environment`)

The host opens one environment per attempt on `ctx.environments` (`@oldbulb/samsara-environments`; `local` by default) and hands it to the loop as `AttemptSpec.environment`, with `workdir` naming its workdir. Loops split by where the agent runs:

| kind | loops | what they do with it |
|---|---|---|
| host-side | `null`, `loops-dsh` (in-process dsh), `loops-claude-code` (the SDK as a child of this process) | ignore it; the agent runs on this host in `workdir`, so they need the `local` provider — another provider's workdir is not a path on this host |
| installed | `installed` (row `loops-installed`, below); `loops-harbor` in the design note | run the agent inside it through `exec`, read the transcript and the submit back with `get`; any provider |

`LoopCapabilities.installed` says which kind a provider is (`null`, `loops-dsh`, `loops-claude-code`: `false`); the runner refuses a host-side loop on any provider but `local` before it opens anything (`loop <name> runs on the host; --env <p> needs an installed loop`). `AttemptSpec.localWorkdir` is the host copy of `workdir` (the attempt dir; the same path under `local`): where an installed loop lands what it brings back.

`HarnessFacts.environment` is what actually ran, as the provider reported it (image digest, resources, network); the host sets it per attempt before hashing `facts_sha`, so attempts from different environments never pool.

## The null loop (`null.ts`, row `loops-null`)

Finishes at once, calls no model. Its row takes `config: { submit: <object> }` to leave that value as every attempt's submission (`<workdir>/<submitTool>.json`, the @oldbulb/samsara-submit convention); the default `null` submits nothing, so attempts are `valid: false` and smoke drops them on validity. A pack whose truth needs a submission but does not read the answer runs the whole challenger path through it.

## The installed loop (`installed.ts`, row `loops-installed`)

The agent is in the environment's image (`dsh` headless, `claude`, `codex`, a Harbor task's oracle `solution/solve.sh`); the loop runs it there through `exec` and reads back what it left. Config:

| key | |
|---|---|
| `command: string[]` | the argv, run inside the environment; `{workdir}`, `{skill}` (the skill snapshot, `<workdir>/.agents/skills/<name>`) and `{attempt}` (the attempt token, `<workdir>/.task/token.json`) in any element are filled in per attempt, as paths inside the environment |
| `cwd?` | working directory inside the environment (default: its workdir) |
| `transcript?` | a path inside the environment fetched back as the `transcript-native` artifact |
| `submit?` | a path inside the environment whose content becomes the attempt's submit file `<submitTool>.json` — on the host copy (what the runner validates against the pack contract) and put back into the environment under the same name (what an `in_environment` truth reads) |
| `env?` | environment variables for the command; `AttemptSpec.env` overrides |

One exec is the attempt, with `limits.maxDurationMs` as its timeout: exit 0 → `COMPLETED/completed`, any other exit → `FAILED/error`, a null code (the provider ended it on the timeout) → `TRUNCATED/timeout`, the host's abort or `cancel()` → `ABORTED/aborted`. Events: `started`, one `assistant` (`textBytes` = stdout), `output` when a submit came back, `finished` with usage zero and cost source `unknown` (an installed agent's accounting is its own) and the artifacts `stdout`, `stderr` (under `<localWorkdir>/.installed/`) and the transcript. An agent that left no transcript or submit is not an error. The loop disposes nothing — the runner owns the environment — and a missing `AttemptSpec.environment` is refused before publication. `harnessFacts.version.loop` is `installed@<sha256 of the command>`, `sandbox` is `environment`; capabilities: `installed: true`, `perAttemptEnv: true`, everything else off.

## OTel GenAI mapping (`otel.ts`)

`LoopEvent` is the seam and stays as it is; `toSpans(meta, events)` maps one attempt's events to OpenTelemetry GenAI semantic-convention spans (gen-ai-agent-spans.md) and `toResourceSpans` wraps them as OTLP/JSON `resourceSpans`. `samsara export --run <dir> --format otlp-json --out file.json` applies it to every `attempts/<attemptId>/events.jsonl` under a run directory (one trace per attempt; `loop` and `facts_sha` come from the sibling `attempts.jsonl`, `--challenger-id/--tier/--model/--provider` from the command line). Ids derive from the attempt id, so the export is reproducible.

| LoopEvent | Span | `gen_ai.operation.name` | Attributes | Timing |
|---|---|---|---|---|
| `started` … `finished` | root `invoke_agent <loop>` (CLIENT) | `invoke_agent` | `gen_ai.agent.name` (= loop, else `native.kind`), `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens/output_tokens` (finished.usage), `gen_ai.response.finish_reasons` = [stopReason], `error.type` = stopReason when status ≠ COMPLETED (or `unfinished`), `samsara.status/turns/tool_calls` | `started.at` → `finished.at` |
| `assistant` | child `chat <model>` (CLIENT) | `chat` | `gen_ai.usage.input_tokens/output_tokens` (event usage), `samsara.turn`, `samsara.text_bytes` | previous event's `at` → `assistant.at` |
| `tool_call` + `tool_result` (paired by `callId`) | child `execute_tool <name>` (INTERNAL) | `execute_tool` | `gen_ai.tool.name`, `gen_ai.tool.call.id`, `samsara.args_bytes`, `samsara.result_bytes`, `error.type` = `tool_error` when `isError` | `tool_call.at` → `tool_result.at` (or `+durationMs`; zero-length if no result) |
| `envelope`, `output` | — (only bound chat timing) | | | |

Every span also carries `samsara.attempt_id`, `samsara.challenger_id`, `samsara.tier`, `samsara.facts_sha`, `samsara.loop` when known. Status: OK for a COMPLETED root / non-error tool, ERROR otherwise. Span kinds follow OTLP (`1` INTERNAL, `3` CLIENT); timestamps are unix nanoseconds as strings.
