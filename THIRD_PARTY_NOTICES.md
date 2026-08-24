# Third-party notices

samsara itself is MIT licensed (see [LICENSE](LICENSE)). It ships and depends on
work by others, disclosed here. Regenerate the dependency side with:

```sh
pnpm licenses list --prod          # add --json for the machine-readable form
```

## The harness it plugs into

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`@deepseek-ai/dsh-*`,
`@deepseek-ai/cordis*`) — MIT. These are **peer** dependencies: the harness
installation provides them, and samsara never bundles a second copy.

## Runtime dependencies

103 distinct packages resolve for a production install, under these licenses:

| License | Packages |
|---|---|
| MIT | 89 |
| ISC | 8 — `inherits`, `isexe`, `once`, `setprototypeof`, `which`, `wrappy`, `yaml`, `zod-to-json-schema` |
| BSD-3-Clause | 3 — `@deepseek-ai/node-addon-landlock-run`, `fast-uri`, `qs` |
| BSD-2-Clause | 1 — `json-schema-typed` |
| **Proprietary** | 2 — see below |

### Not open source: the Claude Agent SDK

`@anthropic-ai/claude-agent-sdk` and its platform binary
`@anthropic-ai/claude-agent-sdk-darwin-arm64` carry
"© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements
outlined here: https://code.claude.com/docs/en/legal-and-compliance".

They are pulled in by `@oldbulb/samsara-loops-claude-code`, the loop provider that
runs an attempt through Claude Code. Installing that package means accepting
Anthropic's terms for it. Everything else — the framework, the gate, the ledger,
the dsh loop provider — is free of it; a deployment that does not want the
dependency can leave that loop's row out of its profile patch.

## Task fixtures in `packs/coding-tasks`

`packs/coding-tasks/fixtures/**` are exercise directories taken verbatim from the
[Aider polyglot benchmark](https://github.com/Aider-AI/polyglot-benchmark), whose
content comes from [Exercism](https://exercism.org)'s Python and JavaScript
tracks — MIT. Each exercise keeps the upstream `LICENSE` file it shipped with.
Nothing in `fixtures/` is our work; `tools/import_polyglot.py` regenerates the
directory from an upstream checkout.

The JavaScript runtime install (`packs/coding-tasks/runtime/js`) pulls jest, babel
and `@exercism/babel-preset-javascript`, all MIT.

## The visual system

The `/samsara` page and the landing page follow the token vocabulary of an
internal design system; the tokens they use are reproduced in
`docs/design/ui-style.md`, which is the whole source of truth for them. Fonts are
referenced by name only and fall back to the system stack.
