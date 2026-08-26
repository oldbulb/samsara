// workbench-executor: the attempt executor ctx.lifecycle runs attempts through
// (run / calibrate / campaign / control), on the host plane. The runner row
// provides it on the CLI profile, which the workbench profile disables (B4);
// this row provides the same `runSet` for the life of the host, so it outlives
// every operator session (the tools row mounts per session inside the preset
// and must not own a service the lifecycle reads).

import type { Context } from '@oldbulb/samsara-kernel'
import type {} from '@oldbulb/samsara-lifecycle'
import { runSet } from '@oldbulb/samsara-runner'

export const name = 'workbench-executor'

export function apply(ctx: Context): void {
  ctx.provide('executor', { runSet })
}
