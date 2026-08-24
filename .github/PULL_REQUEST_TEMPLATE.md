## What this changes

<!-- One paragraph: what behaviour is different now, and why. -->

## Checklist

- [ ] `pnpm build && pnpm test` pass locally (the suite stays offline)
- [ ] `ops/leak-scan.sh` is clean — no domain word in `packages/`
- [ ] New behaviour has a test that fails without the change
- [ ] Side effects go through `ctx.effect`
- [ ] dsh is still imported only through `@oldbulb/samsara-kernel`
- [ ] Commits signed off (`git commit -s`, DCO)

## Anything that needs a decision

<!-- Trade-offs you made, things you were unsure about, follow-ups you left. -->
