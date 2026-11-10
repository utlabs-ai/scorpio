import * as monaco from 'monaco-editor/editor/editor.api.js'
import 'monaco-editor/languages/definitions/typescript/register.js'
import 'monaco-editor/languages/definitions/javascript/register.js'
import 'monaco-editor/languages/definitions/markdown/register.js'
import 'monaco-editor/languages/definitions/css/register.js'
import 'monaco-editor/languages/definitions/html/register.js'
import 'monaco-editor/languages/definitions/python/register.js'
import 'monaco-editor/languages/definitions/shell/register.js'
import 'monaco-editor/language/json/monaco.contribution.js'
import 'monaco-editor/editor/contrib/find/browser/findController.js'
import 'monaco-editor/editor/contrib/folding/browser/folding.js'

globalThis.MonacoEnvironment = { getWorker(_module, label) {
  return new Worker(new URL(label === 'json' ? __WORKSPACE_JSON_WORKER__ : __WORKSPACE_EDITOR_WORKER__, location.origin), { type: 'module', name: `workspace-${label}` })
} }
const language = file => /\.[cm]?[jt]sx?$/.test(file) ? /\.[cm]?tsx?$/.test(file) ? 'typescript' : 'javascript' : /\.json$/.test(file) ? 'json' : /\.md$/.test(file) ? 'markdown' : /\.css$/.test(file) ? 'css' : /\.html?$/.test(file) ? 'html' : /\.py$/.test(file) ? 'python' : /\.(?:sh|zsh|bash)$/.test(file) ? 'shell' : 'plaintext'
function workspaceTheme(value) {
  const style = getComputedStyle(document.documentElement), color = name => style.getPropertyValue(name).trim()
  const token = (name, colorName, fontStyle = '') => ({ token: name, foreground: color(colorName).slice(1), fontStyle })
  const name = value === 'dark' ? 'workspace-dark' : 'workspace-light'
  monaco.editor.defineTheme(name, { base: value === 'dark' ? 'vs-dark' : 'vs', inherit: true,
    rules: [token('', '--wv-code-fg'), token('comment', '--wv-code-comment', 'italic'), token('comment.doc', '--wv-code-comment', 'italic'),
      token('keyword', '--wv-code-keyword'), token('string', '--wv-code-string'), token('number', '--wv-code-number'), token('regexp', '--wv-code-number'),
      token('type', '--wv-code-type'), token('type.identifier', '--wv-code-type'), token('identifier', '--wv-code-fg'), token('delimiter', '--wv-code-fg')],
    colors: { 'editor.foreground': color('--wv-code-fg'), 'editor.background': color('--surface'), 'editorGutter.background': color('--surface'),
      'editorLineNumber.foreground': color('--wv-code-comment'), 'editorLineNumber.activeForeground': color('--wv-code-comment') } })
  return name
}
export function renderWorkspace(parent, data, file, mode, theme) {
  const options = { readOnly: true, domReadOnly: true, contextmenu: false, links: false, automaticLayout: true, minimap: { enabled: false },
    scrollBeyondLastLine: false, fontSize: 13, lineHeight: 20, fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono').trim(),
    padding: { top: 12, bottom: 12 }, theme: workspaceTheme(theme), folding: true, glyphMargin: false, overviewRulerLanes: 0 }
  const models = []
  const model = (text, side) => {
    const value = monaco.editor.createModel(text, language(file), monaco.Uri.from({ scheme: 'inmemory', authority: 'workspace', path: `/${side}/${file}` }))
    models.push(value); return value
  }
  let editor
  if (mode === 'diff' && data.before.exists && data.after.exists) {
    editor = monaco.editor.createDiffEditor(parent, { ...options, originalEditable: false, renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: false, renderMarginRevertIcon: false, renderOverviewRuler: false })
    editor.setModel({ original: model(data.before.text, 'before'), modified: model(data.after.text, 'after') })
    for (const view of [editor.getOriginalEditor(), editor.getModifiedEditor()]) view.updateOptions({ readOnly: true, domReadOnly: true, links: false })
  } else {
    const side = mode === 'diff' ? data.after.exists ? data.after : data.before : data.file
    editor = monaco.editor.create(parent, { ...options, model: model(side.text, 'file') })
  }
  return { editor, dispose() { editor.dispose(); models.forEach(m => m.dispose()) }, theme(value) { monaco.editor.setTheme(workspaceTheme(value)) } }
}
