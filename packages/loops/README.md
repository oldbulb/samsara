
## The null loop (`null.ts`, row `loops-null`)

Finishes at once, calls no model. Its row takes `config: { submit: <object> }` to leave that value as every attempt's submission (`<workdir>/<submitTool>.json`, the @oldbulb/samsara-submit convention); the default `null` submits nothing, so attempts are `valid: false` and smoke drops them on validity. A pack whose truth needs a submission but does not read the answer runs the whole challenger path through it.

## OTel GenAI mapping (`otel.ts`)

`LoopEvent` is the seam and stays as it is; `toSpans(meta, events)` maps one attempt's events to OpenTelemetry GenAI semantic-convention spans (gen-ai-agent-spans.md) and `toResourceSpans` wraps them as OTLP/JSON `resourceSpans`. `samsara export --run <dir> --format otlp-json --out file.json` applies it to every `attempts/<attemptId>/events.jsonl` under a run directory (one trace per attempt; `loop` and `facts_sha` come from the sibling `attempts.jsonl`, `--challenger-id/--tier/--model/--provider` from the command line). Ids derive from the attempt id, so the export is reproducible.

| LoopEvent | Span | `gen_ai.operation.name` | Attributes | Timing |
|---|---|---|---|---|
| `started` … `finished` | root `invoke_agent <loop>` (CLIENT) | `invoke_agent` | `gen_ai.agent.name` (= loop, else `native.kind`), `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens/output_tokens` (finished.usage), `gen_ai.response.finish_reasons` = [stopReason], `error.type` = stopReason when status ≠ COMPLETED (or `unfinished`), `samsara.status/turns/tool_calls` | `started.at` → `finished.at` |
| `assistant` | child `chat <model>` (CLIENT) | `chat` | `gen_ai.usage.input_tokens/output_tokens` (event usage), `samsara.turn`, `samsara.text_bytes` | previous event's `at` → `assistant.at` |
| `tool_call` + `tool_result` (paired by `callId`) | child `execute_tool <name>` (INTERNAL) | `execute_tool` | `gen_ai.tool.name`, `gen_ai.tool.call.id`, `samsara.args_bytes`, `samsara.result_bytes`, `error.type` = `tool_error` when `isError` | `tool_call.at` → `tool_result.at` (or `+durationMs`; zero-length if no result) |
| `envelope`, `output` | — (only bound chat timing) | | | |

Every span also carries `samsara.attempt_id`, `samsara.challenger_id`, `samsara.tier`, `samsara.facts_sha`, `samsara.loop` when known. Status: OK for a COMPLETED root / non-error tool, ERROR otherwise. Span kinds follow OTLP (`1` INTERNAL, `3` CLIENT); timestamps are unix nanoseconds as strings.
