// Where the two pages of this project live. The demo is served under the Vite base (/demo/); the
// pipeline editor is built by the same project but is served at the site's root, /pipeline/ - in
// production (apps/site copies it there), in `vite preview` and in `vite dev` alike (the
// `pipelinePage` plugin in vite.config.ts answers that address).
export const DEMO_URL = import.meta.env.BASE_URL
export const PIPELINE_URL = '/pipeline/'
