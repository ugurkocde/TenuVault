# TenuVault Docs

Source for [docs.tenuvault.com](https://docs.tenuvault.com), built with [Astro](https://astro.build) and [Starlight](https://starlight.astro.build).

## Run locally

```sh
cd docs-site
npm ci
npm run dev      # dev server at http://localhost:4321
npm run build    # static build into dist/, fails on broken internal links
npm run preview  # serve the built site
```

## Where things live

* Pages: `src/content/docs/`. The file path is the URL, so `backups/coverage.md` is served at `/backups/coverage/` and `index.md` files serve their folder.
* Sidebar, site settings and plugins: `astro.config.mjs`. Add new pages to the sidebar there.
* Branding: `src/styles/custom.css`, `src/assets/logo.svg`, `public/favicon.svg`.
* Header links (Download, Pricing): `src/components/HeaderLinks.astro`.
* Redirects from the old GitBook URLs: `vercel.json`.

Link between pages with absolute paths and a trailing slash, for example `/security/encryption/#the-recovery-key`. The build checks every internal link and heading anchor.

## Deployment

Vercel deploys the site on every push to `main` that changes `docs-site/` (project root directory `docs-site`, framework Astro). Redirects in `vercel.json` only apply on Vercel, not in `npm run preview`.
