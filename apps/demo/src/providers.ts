import { withWebLLMContextWindow } from '@dudko.dev/agent-web'
import type { WebLLMModelFactory } from '@dudko.dev/agent-web-react'

/**
 * Build a local WebLLM model. The two WebLLM packages are imported HERE, with literal
 * specifiers, so the bundler can resolve them: the core's own `await import('@browser-ai/web-llm')`
 * is a bare, `@vite-ignore`d specifier that a bundle can't resolve — it surfaces at runtime as
 * `webLLM is not a function`.
 *
 * They are imported lazily: WebLLM is megabytes of JavaScript, and a visitor who uses a cloud
 * model (or only reads the page) should not download it. The chunk is fetched the first time a
 * local WebLLM model is built.
 */
export const createLocalModel: WebLLMModelFactory = async (modelId, options) => {
  const [{ webLLM }, { prebuiltAppConfig }] = await Promise.all([
    import('@browser-ai/web-llm'),
    import('@mlc-ai/web-llm'),
  ])
  // WebLLM loads its models with a 4096-token window; load with the model's
  // own (see models.ts). It goes in engineConfig.appConfig — @browser-ai/web-llm
  // ignores its top-level `appConfig` setting.
  const { contextWindowTokens, ...rest } = options ?? {}
  const settings = contextWindowTokens
    ? {
        ...rest,
        engineConfig: {
          ...(rest.engineConfig as object | undefined),
          appConfig: withWebLLMContextWindow(prebuiltAppConfig, modelId, contextWindowTokens),
        },
      }
    : rest
  return webLLM(modelId, settings as never) as never
}
