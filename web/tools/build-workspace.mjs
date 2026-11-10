import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { createHash } from 'node:crypto'
import { sanitizerPlugin, sanitizerSources } from './sanitizer.mjs'
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const out = path.join(web, 'public/static/workspace-assets')
const packageOf = async name => JSON.parse(await fs.readFile(path.join(web, 'node_modules', name, 'package.json'), 'utf8'))
const monacoPackage = await packageOf('monaco-editor'), sanitizerPackage = await packageOf('dompurify')
if (monacoPackage.version !== '0.57.0' || sanitizerPackage.version !== '3.4.17') throw new Error('Unexpected workspace renderer dependency versions')
const sanitizer = sanitizerPlugin(web)
await fs.rm(out, { recursive: true, force: true }); await fs.mkdir(out, { recursive: true })
const sources = (meta, required = false) => sanitizerSources(meta, web, required)
const provenance = { workers: {} }, workerUrls = {}
for (const [name, entry] of Object.entries({ 'editor.worker': 'monaco-editor/editor/editor.worker.js', 'json.worker': 'monaco-editor/language/json/json.worker.js' })) {
  const worker = await build({ stdin: { contents: `import '${entry}';`, resolveDir: web }, bundle: true, minify: true, format: 'esm', outfile: path.join(out, `${name}.js`), write: false, target: 'es2022', plugins: [sanitizer], metafile: true })
  const bytes = worker.outputFiles[0].contents, hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16), file = `${name}-${hash}.js`
  await fs.writeFile(path.join(out, file), bytes); workerUrls[name] = `/static/workspace-assets/${file}`
  provenance.workers[name] = sources(worker.metafile)
}
const wire = { name: 'workspace-wire-source', setup(builder) {
  builder.onResolve({ filter: /workspace-assets\/wire\.js$/ }, () => ({ path: path.join(web, '../cli/src/workspace-protocol.mjs') }))
} }
const result = await build({ entryPoints: { view: path.join(web, 'public/static/workspace-view.js') }, bundle: true, splitting: true, minify: true, format: 'esm',
  outdir: out, chunkNames: 'chunks/[name]-[hash]', assetNames: '[name]-[hash]', target: 'es2022', loader: { '.ttf': 'file' }, plugins: [sanitizer, wire], metafile: true,
  define: { __WORKSPACE_EDITOR_WORKER__: JSON.stringify(workerUrls['editor.worker']), __WORKSPACE_JSON_WORKER__: JSON.stringify(workerUrls['json.worker']) } })
provenance.renderer = sources(result.metafile, true)
await fs.copyFile(path.join(web, 'node_modules/monaco-editor/LICENSE'), path.join(out, 'MONACO-LICENSE.txt'))
await fs.copyFile(path.join(web, 'node_modules/monaco-editor/ThirdPartyNotices.txt'), path.join(out, 'ThirdPartyNotices.txt'))
await fs.copyFile(path.join(web, 'node_modules/dompurify/LICENSE'), path.join(out, 'DOMPURIFY-LICENSE.txt'))
await fs.copyFile(path.join(web, 'node_modules/dompurify/LICENSE-MPL'), path.join(out, 'DOMPURIFY-LICENSE-MPL.txt'))
await fs.writeFile(path.join(out, 'DISTRIBUTION-NOTICES.txt'), `Monaco ${monacoPackage.version} (MIT) is distributed with DOMPurify ${sanitizerPackage.version} (Apache-2.0 OR MPL-2.0) replacing its vendored sanitizer at build time. Original ThirdPartyNotices.txt is retained for attribution; the bundled sanitizer version is the replacement named here.\n`)
const assets = await fs.readdir(out, { recursive: true })
await fs.writeFile(path.join(out, 'manifest.json'), JSON.stringify({ monacoVersion: monacoPackage.version, dompurifyVersion: sanitizerPackage.version, workerUrls, provenance, files: assets.filter(f => !f.endsWith('/')), outputs: Object.keys(result.metafile.outputs).map(f => path.relative(out, path.resolve(f))) }, null, 2) + '\n')
console.log(`Built workspace renderer and workers (${assets.length} assets)`) 
