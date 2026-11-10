import path from 'node:path'
import { realpathSync } from 'node:fs'

// Monaco vendors a sanitizer separately from its dependency tree; both product and compatibility builds use this map.
export function sanitizerPlugin(web) {
  const replacement = realpathSync(path.join(web, 'node_modules/dompurify/dist/purify.es.mjs'))
  return { name: 'patched-sanitizer', setup(builder) {
    builder.onResolve({ filter: /dompurify\/dompurify\.js$/ }, args => args.importer.includes('/monaco-editor/') ? { path: replacement } : undefined)
  } }
}
export function sanitizerSources(meta, web, required = false) {
  const inputs = Object.keys(meta.inputs)
  if (inputs.some(file => /monaco-editor\/.*\/base\/browser\/dompurify\/dompurify\.js$/.test(file))) throw new Error('Unpatched Monaco sanitizer entered the bundle')
  const patched = inputs.some(file => /(?:^|\/)node_modules\/dompurify\/dist\/purify\.es\.mjs$/.test(file))
  if (required && !patched) throw new Error('Patched Monaco sanitizer was not resolved')
  return { patched, inputs: inputs.map(file => path.relative(web, path.resolve(file))) }
}
