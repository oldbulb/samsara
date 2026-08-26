---
"@oldbulb/samsara-loops": minor
"@oldbulb/samsara-loops-dsh": minor
"@oldbulb/samsara-loops-claude-code": minor
---

The `system_prompt` event becomes `envelope`: what the model was shown in dsh's request-envelope terms — `config` (sha256, provider, model), `system` (sha256, bytes) and `tools` (sha256, names). `HarnessFacts.envelope` declares how faithfully each field is known (`exact` / `proxy` / `absent`) and is part of `facts_sha`, so rows whose envelopes were seen differently are not A/B-comparable: the `dsh` loop reports all three exactly from the first `request/header`, `claude-code` reports proxies. `canonicalJson` is exported. The null loop takes `config: { submit: <object> }` to leave a canned submission behind every attempt, for a pack whose truth needs one but does not read it.
