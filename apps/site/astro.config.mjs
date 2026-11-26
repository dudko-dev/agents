import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'
import starlightLlmsTxt from 'starlight-llms-txt'

const SITE = 'https://agent.dudko.dev'
const DESCRIPTION =
  'Planning AI agents in TypeScript for Node and the browser: plan, execute, replan and answer over MCP tools, with React bindings and a live demo.'

// One site: the landing page (src/pages/index.astro), the documentation (Starlight, generated
// from the packages' own Markdown by scripts/sync-docs.mjs) and the demo, which is built by
// apps/demo and copied under /demo/ by scripts/assemble.mjs - with the pipeline editor, a second
// page of that project, under /pipeline/.
export default defineConfig({
  site: SITE,
  trailingSlash: 'always',
  integrations: [
    starlight({
      title: 'dudko.dev agents',
      description: DESCRIPTION,
      logo: { src: './src/assets/mark.svg', alt: '' },
      favicon: '/favicon.svg',
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/dudko-dev/agents' },
        { icon: 'npm', label: 'npm', href: 'https://www.npmjs.com/org/dudko.dev' },
      ],
      editLink: { baseUrl: 'https://github.com/dudko-dev/agents/edit/main/' },
      customCss: ['./src/styles/tokens.css', './src/styles/docs.css'],
      // Dark only: one code theme, so a visitor whose system is light never gets light-theme ink.
      expressiveCode: { themes: ['night-owl'] },
      head: [
        { tag: 'link', attrs: { rel: 'icon', href: '/favicon.ico', sizes: '32x32' } },
        { tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' } },
        { tag: 'link', attrs: { rel: 'manifest', href: '/manifest.webmanifest' } },
        { tag: 'meta', attrs: { property: 'og:image', content: `${SITE}/og.png` } },
        { tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
        { tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
        { tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
      ],
      sidebar: [
        { label: 'Start here', items: [{ label: 'Overview', slug: 'docs' }] },
        { label: 'Node agent', items: [{ label: '@dudko.dev/agent', slug: 'docs/node' }] },
        {
          label: 'Browser agent',
          items: [
            { label: '@dudko.dev/agent-web', slug: 'docs/browser' },
            { label: 'Capabilities', slug: 'docs/browser/capabilities' },
            { label: 'Providers', slug: 'docs/browser/providers' },
            { label: 'Security', slug: 'docs/browser/security' },
            { label: 'Design', slug: 'docs/browser/design' },
          ],
        },
        {
          label: 'React',
          items: [
            { label: '@dudko.dev/agent-web-react', slug: 'docs/react' },
            { label: 'Chat components', slug: 'docs/react/chat' },
            { label: 'Pipeline editor', slug: 'docs/react/pipeline' },
          ],
        },
        { label: 'Live demo', link: '/demo/', attrs: { 'data-astro-reload': '' } },
        { label: 'Pipeline editor (live)', link: '/pipeline/', attrs: { 'data-astro-reload': '' } },
      ],
      plugins: [
        starlightLlmsTxt({
          projectName: 'dudko.dev agents',
          description: DESCRIPTION,
        }),
      ],
    }),
  ],
})
