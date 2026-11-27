// A busy machine, made reproducible: the sandbox engine with a start (its runtime, the host
// functions, the bootstrap) that takes `setupMs` of CPU before the program's first instruction.
// The first evaluation in a fresh context is always the engine's bootstrap, never the program.
import type { ISandboxLib } from '../../src/sandbox-engine.ts'

export const slowStart = (lib: ISandboxLib, setupMs: number): ISandboxLib => ({
  ...lib,
  newQuickJSWASMModuleFromVariant: async (variant) => {
    const mod = await lib.newQuickJSWASMModuleFromVariant(variant)
    const newRuntime = mod.newRuntime.bind(mod)
    mod.newRuntime = () => {
      const rt = newRuntime()
      const newContext = rt.newContext.bind(rt)
      rt.newContext = () => {
        const ctx = newContext()
        const evalCode = ctx.evalCode.bind(ctx)
        let slowed = false
        ctx.evalCode = (...args: unknown[]) => {
          if (!slowed) {
            slowed = true
            const until = Date.now() + setupMs
            while (Date.now() < until) {
              // the CPU is taken by something else
            }
          }
          return evalCode(...args)
        }
        return ctx
      }
      return rt
    }
    return mod
  },
})
