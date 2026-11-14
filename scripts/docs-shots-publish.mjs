/** Convert referenced documentation captures to lossless WebP and update intrinsic dimensions. */
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { createRequire } from 'node:module'
const root = resolve(import.meta.dirname, '..')
const sharp = createRequire(join(root, 'docs-site/package.json'))('sharp')
const docs = join(root, 'docs-site/src/content/docs')
const files = readdirSync(docs, {recursive:true}).filter(name => /\.mdx?$/.test(name))
const pages = files.map(name => ({path:join(docs,name), text:readFileSync(join(docs,name),'utf8')}))
const assets = [...new Set(pages.flatMap(page => [...page.text.matchAll(/src="\/images\/screenshots\/([\w-]+)\.webp"/g)].map(match => match[1])))]
const destination = join(root, 'docs-site/public/images/screenshots')
mkdirSync(destination, {recursive:true})
let bytes = 0
for (const name of assets) {
  const candidates = name === 'welcome' ? ['out/smoke/00-welcome.png'] : ['out/docs-shots','out/docs-baselines','out/docs-approval'].map(dir => `${dir}/${name}.png`)
  const input = candidates.map(path => join(root,path)).find(existsSync)
  if (!input) throw new Error(`Missing capture: ${name}. Run the capture commands in docs-site/SCREENSHOTS.md.`)
  const output = join(destination, `${name}.webp`)
  const metadata = await sharp(input).webp({lossless:true, effort:6}).toFile(output)
  bytes += metadata.size
  for (const page of pages) {
    const pattern = new RegExp(`(src="/images/screenshots/${name}\\.webp"[^>]*?width=")[^"]+(" height=")[^"]+(")`, 'g')
    page.text = page.text.replace(pattern, `$1${metadata.width}$2${metadata.height}$3`)
  }
}
for (const page of pages) if (page.text !== readFileSync(page.path,'utf8')) writeFileSync(page.path,page.text)
console.log(`Published ${assets.length} lossless WebP captures (${(bytes/1024/1024).toFixed(2)} MiB).`)
