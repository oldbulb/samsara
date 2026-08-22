// A plugin that records its latest config on a process global; the "champion row" under test.
export const name = 'noop-plugin'
export function apply(ctx, config) {
  globalThis.__samsaraNoopConfigs ??= []
  globalThis.__samsaraNoopConfigs.push(config)
  ctx.effect(() => () => { globalThis.__samsaraNoopConfigs.pop() })
}
