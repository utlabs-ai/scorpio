import { createWorkspaceClient } from './workspace-client.js';
import { createDirectoryNavigation, directoryPreference, childDirectory } from './workspace-navigation.js';

const boot = JSON.parse(document.getElementById('workspace-data').dataset.json), t = boot.strings;
const el = id => document.getElementById(id), tree = el('wv-tree'), changes = el('wv-changes');
let computer = boot.computer, client, selection = null, documentData = null, editor = null, version = 0, readAt = null, stale = false, revoked = false, connected = false, instanceId = null;
let connectionVersion = 0, directory = null, currentPath = null, defaultWorkspace = false, directoryError = null, navigating = false, gitStatus = 'idle', gitHasContent = false;
const navigation = createDirectoryNavigation({ t, onNavigate: path => navigate(path), canNavigate: () => canRead() });
const directories = new Map(), changeFiles = new Map();
let selectedTreeRow = null, selectedChangeRow = null;
function highlight() {
  selectedTreeRow?.removeAttribute('aria-selected'); selectedChangeRow?.removeAttribute('aria-selected');
  selectedTreeRow = selectedChangeRow = null;
  if (!selection) return;
  const selector = `button[data-path="${CSS.escape(selection.path)}"]`;
  selectedTreeRow = tree.querySelector(selector); selectedChangeRow = changes.querySelector(selector);
  selectedTreeRow?.setAttribute('aria-selected', 'true'); selectedChangeRow?.setAttribute('aria-selected', 'true');
}
function closeDirectory(path) {
  for (const [key, item] of directories) if (key === path || key.startsWith(`${path}/`)) { item.expanded = false; item.container.remove(); directories.delete(key); }
}
const format = (s, vars) => s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
const time = value => new Date(value).toLocaleTimeString(boot.lang, { hour: '2-digit', minute: '2-digit', hour12: false });
const size = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const theme = () => document.documentElement.dataset.scorpioEffectiveTheme === 'dark' ? 'dark' : 'light';
function parentMessage(type, extra = {}) { if (boot.embed && instanceId) parent.postMessage({ version: 1, type, instanceId, ...extra }, location.origin); }
function note(node, text) { const p = document.createElement('p'); p.className = 'wv-list-note'; p.textContent = text; node.replaceChildren(p); }
function empty(text) { el('wv-empty').textContent = text; el('wv-empty').hidden = !text; }
function dispose() { editor?.dispose(); editor = null; el('wv-editor').replaceChildren(); }
function canRead() { return !revoked && connected && computer.online && computer.workspaceProtocol === 1 && computer.directoryNavigation === 1 && client?.ready; }
function pageState() {
  const root = directories.get('');
  const state = revoked ? 'revoked' : !computer.online && !readAt ? 'offline' : computer.online && connected && computer.directoryNavigation !== 1 ? 'unsupported' : directoryError ? 'directory-error' : navigating ? 'loading' : root?.nextCursor === null && !root.entries.length && !root.truncated && !selection && gitStatus !== 'loading' && !gitHasContent ? 'empty' : '';
  document.body.classList.toggle('wv-full-state', !!state);
  document.body.dataset.wvState = state;
  if (!state) { if (!selection) empty(t.choose); return; }
  empty(state === 'revoked' ? t.revoked : state === 'empty' ? defaultWorkspace ? t.empty : t.directoryEmpty : state === 'directory-error' ? errorText(directoryError) : state === 'loading' ? t.loading : state === 'unsupported' ? t.unsupported : format(t.offlineFirst, { computer: computer.name }));
  if (state === 'offline') {
    const icon = document.createElement('span'); icon.className = 'wv-offline-icon'; icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = '<svg viewBox="0 0 32 32"><path d="M5 7h22v16H5zM12 27h8M16 23v4M3 3l26 26"/></svg>';
    el('wv-empty').prepend(icon);
  }
  el('wv-banner').hidden = true;
}
function banner() {
  document.body.classList.toggle('wv-offline', !computer.online);
  el('wv-online').textContent = computer.online ? t.online : t.offline;
  el('wv-refresh').disabled = !canRead(); navigation.availability();
  const change = selection && changeFiles.get(selection.path), afterExists = documentData?.file?.exists ?? documentData?.after?.exists ?? change?.afterExists;
  el('wv-file').disabled = !canRead() || afterExists === false; el('wv-diff').disabled = !canRead();
  let text = '';
  if (!computer.online) text = format(readAt ? t.offlineRead : t.offlineFirst, { computer: computer.name, time: readAt ? time(readAt) : '' });
  else if (!connected) text = t.reconnecting;
  else if ((computer.workspaceProtocol !== 1 || computer.directoryNavigation !== 1)) text = t.unsupported;
  else if (stale && readAt) text = format(t.stale, { time: time(readAt) });
  el('wv-banner').textContent = text; el('wv-banner').hidden = !text;
  pageState();
}
function errorText(error) {
  return ({ workspace_directory_missing: t.directoryMissing, workspace_directory_denied: t.directoryDenied, workspace_not_directory: t.notDirectory, workspace_unsupported: t.unsupported, workspace_link: t.linked, workspace_binary: format(t.binary, { size: size(error.details?.bytes || 0) }),
    workspace_too_large: format(t.tooLarge, { size: size(error.details?.bytes || 0) }), workspace_encoding: t.encoding,
    workspace_line_limit: t.lineLimit, workspace_directory_changed: t.directoryChanged, workspace_git_unavailable: t.gitUnavailable,
    workspace_busy: t.busy, workspace_rate_limited: t.busy })[error.code] || t.failed;
}
function clearContent() { gitStatus = 'idle'; gitHasContent = false; changes.dataset.status = 'idle'; dispose(); documentData = null; selection = null; selectedTreeRow = selectedChangeRow = null; readAt = null; stale = false; directories.clear(); changeFiles.clear(); tree.replaceChildren(); changes.replaceChildren(); el('wv-path').textContent = ''; el('wv-read-at').textContent = ''; el('wv-document-top').hidden = true; el('wv-diff-headings').hidden = true; empty(t.choose); }
function directoryFailure(error) {
  if (!['workspace_directory_missing', 'workspace_directory_denied', 'workspace_not_directory', 'workspace_directory_changed'].includes(error.code)) return false;
  version++; client.cancelAll(); clearContent(); directory = null; navigating = false; directoryError = error; banner(); return true;
}
function clearAll() { version++; connectionVersion++; client?.stop(); clearContent(); directory = currentPath = null; defaultWorkspace = false; directoryError = null; navigating = false; navigation.clear(); }
function revoke() { if (revoked) return; clearAll(); revoked = true; document.body.classList.add('wv-revoked'); pageState(); parentMessage('revoked'); }
function setup() {
  const current = ++connectionVersion;
  let initiallyLoaded = !computer.online;
  function initial() {
    if (!initiallyLoaded && computer.online && computer.workspaceProtocol === 1 && computer.directoryNavigation === 1 && connected) { initiallyLoaded = true; initialize(); }
  }
  connected = false; el('wv-computer-label').textContent = computer.name; banner();
  client = createWorkspaceClient({ topicId: boot.topic.id, computerId: computer.computerId,
    onState(state) { if (current !== connectionVersion) return; connected = state === 'ready'; if (!connected) { initiallyLoaded = true; if (readAt) stale = true; } banner(); },
    onReady(value) {
      if (current !== connectionVersion) return;
      computer = value; connected = true; el('wv-computer-label').textContent = value.name; parentMessage('computer', { computerId: computer.computerId }); banner();
      if (!value.online) initiallyLoaded = true;
      // Only the first connection reads the root; reconnects keep completed snapshots until manual refresh.
      initial();
    },
    onStatus(value) { if (current !== connectionVersion) return; const wasOnline = computer.online; computer = { ...computer, ...value }; el('wv-computer-label').textContent = computer.name; if (!computer.online) initiallyLoaded = true; if (!computer.online || !wasOnline) stale = !!readAt; banner(); initial(); hosts(); },
    onRevoked: revoke,
  });
  client.start(); hosts();
}
function fileIcon(folder = false) {
  const symbol = document.createElement('span'); symbol.className = 'wv-tree-symbol';
  symbol.innerHTML = folder ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 5V3h5l2 2h7v9H1Z"/></svg>' : '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 1h6l3 3v11H4Z M10 1v4h3"/></svg>';
  return symbol;
}
async function loadDirectory(path, container, cursor = null) {
  if (!canRead() || !directory?.id) return;
  const current = version;
  let item = directories.get(path);
  if (!item) { item = { path, container, entries: [], expanded: true }; directories.set(path, item); }
  try {
    const result = await client.request({ op: 'list', path, cursor, directory });
    if (current !== version || !item.expanded) return;
    const data = result.value;
    const otherRows = [...directories.values()].filter(d => d !== item).reduce((n, d) => n + d.entries.length, 0);
    const combined = cursor ? [...item.entries, ...data.entries] : data.entries, available = Math.max(0, 10000 - otherRows);
    item.entries = combined.slice(0, available); item.nextCursor = combined.length > available ? null : data.nextCursor;
    item.truncated = data.truncated || combined.length > available;
    drawDirectory(item);
    if (path === '') banner();
    if (data.truncated || combined.length > available) { const p = document.createElement('p'); p.className = 'wv-list-note'; p.textContent = t.truncated; container.append(p); }
    return true;
  } catch (error) { if (current === version && error.code !== 'workspace_cancelled' && !directoryFailure(error)) note(container, errorText(error)); }
}
function drawDirectory(item) {
  const names = new Set(item.entries.filter(entry => entry.kind === 'directory').map(entry => item.path ? `${item.path}/${entry.name}` : entry.name));
  for (const key of [...directories.keys()]) if (key && key.slice(0, Math.max(0, key.lastIndexOf('/'))) === item.path && !names.has(key)) closeDirectory(key);
  const fragment = document.createDocumentFragment();
  for (const entry of item.entries) {
    const path = item.path ? `${item.path}/${entry.name}` : entry.name;
    const button = document.createElement(entry.kind === 'directory' ? 'div' : 'button'); if (entry.kind !== 'directory') button.type = 'button'; button.className = `wv-tree-row${entry.kind === 'link' ? ' wv-link-row' : ''}`; button.dataset.path = path; button.dataset.kind = entry.kind; button.setAttribute('role', 'treeitem');
    if (entry.kind === 'directory') { const arrow = document.createElement('button'); arrow.type = 'button'; arrow.className = 'wv-tree-symbol wv-tree-arrow'; arrow.textContent = '›'; arrow.setAttribute('aria-label', entry.name); button.append(arrow); button.setAttribute('aria-expanded', 'false'); }
    else { const spacer = document.createElement('span'); spacer.className = 'wv-tree-symbol'; button.append(spacer); }
    button.append(fileIcon(entry.kind === 'directory'));
    const label = document.createElement(entry.kind === 'directory' ? 'button' : 'span'); if (entry.kind === 'directory') label.type = 'button'; label.className = 'wv-tree-label'; label.textContent = entry.name; button.append(label);
    if (entry.kind === 'link') { const small = document.createElement('small'); small.textContent = t.link; button.append(small); }
    if (selection?.path === path) button.setAttribute('aria-selected', 'true');
    fragment.append(button);
    const old = directories.get(path);
    if (entry.kind === 'directory' && old?.expanded) { button.setAttribute('aria-expanded', 'true'); button.firstElementChild.textContent = '⌄'; fragment.append(old.container); }
  }
  if (item.nextCursor) { const more = document.createElement('button'); more.type = 'button'; more.className = 'wv-more'; more.dataset.more = item.path; more.textContent = t.more; fragment.append(more); }
  item.container.replaceChildren(fragment);
  if (!item.entries.length && !item.nextCursor && !item.truncated) note(item.container, t.directoryEmpty);
  highlight();
}
tree.addEventListener('click', event => {
  const more = event.target.closest('[data-more]');
  if (more) { const item = directories.get(more.dataset.more); if (item && item.entries.length < 10000) loadDirectory(item.path, item.container, item.nextCursor); else more.textContent = t.truncated; return; }
  const row = event.target.closest('[data-path]'); if (!row || !canRead()) return;
  const path = row.dataset.path;
  if (row.dataset.kind === 'directory') {
    if (!event.target.closest('.wv-tree-arrow')) { if (directory?.id) navigate(childDirectory(directory.path, path)); return; }
    const old = directories.get(path);
    if (old?.expanded) { closeDirectory(path); row.setAttribute('aria-expanded', 'false'); row.firstElementChild.textContent = '›'; return; }
    if (row.nextElementSibling?.dataset.limitNote) row.nextElementSibling.remove();
    if (directories.size >= 64) { const p = document.createElement('p'); p.className = 'wv-list-note'; p.dataset.limitNote = 'true'; p.textContent = t.truncated; row.after(p); return; }
    const container = document.createElement('div'); container.className = 'wv-tree-children'; container.setAttribute('role', 'group'); row.after(container); row.setAttribute('aria-expanded', 'true'); row.firstElementChild.textContent = '⌄'; loadDirectory(path, container);
  } else select({ path, mode: 'file', kind: row.dataset.kind });
});
async function loadChanges() {
  const current = version;
  let complete = false;
  gitStatus = 'loading'; changes.dataset.status = 'loading'; note(changes, t.loading); banner();
  try {
    if (!directory?.id) return;
    const result = await client.request({ op: 'changes', directory });
    if (current !== version) return;
    changeFiles.clear(); changes.replaceChildren();
    const data = result.value; complete = true;
    gitHasContent = data.repositories.some(repo => repo.changes.length) || !!data.unavailable.length || data.discoveryTruncated || data.changesTruncated;
    if (!data.repositories.length && !data.unavailable.length && !data.discoveryTruncated) { note(changes, t.noRepository); return true; }
    for (const repository of data.repositories) {
      const title = document.createElement('div'); title.className = 'wv-repo-row'; title.append(fileIcon(true), document.createTextNode(repository.repo || currentPath?.split('/').at(-1) || '/')); changes.append(title);
      for (const change of repository.changes) {
        const path = repository.repo ? `${repository.repo}/${change.path}` : change.path;
        changeFiles.set(path, { ...change, repo: repository.repo });
        const button = document.createElement('button'); button.type = 'button'; button.className = 'wv-change-row'; button.dataset.path = path;
        const kind = document.createElement('span'); kind.className = 'wv-change-code'; kind.dataset.kind = change.kind; kind.textContent = change.kind === 'added' ? 'A' : change.kind === 'deleted' ? 'D' : 'M';
        const name = document.createElement('span'); name.className = 'wv-tree-label'; name.textContent = change.path.split('/').at(-1);
        const parent = document.createElement('small'); parent.textContent = change.path.split('/').slice(0, -1).join('/'); button.append(kind, name, parent); changes.append(button);
      }
    }
    if (data.unavailable.length || data.discoveryTruncated || data.changesTruncated) { const p = document.createElement('p'); p.className = 'wv-list-note wv-git-partial'; p.textContent = data.unavailable.length ? t.gitUnavailable : t.gitPartial; changes.prepend(p); }
    highlight(); selectionControls();
    return true;
  } catch (error) { if (current === version && error.code !== 'workspace_cancelled' && !directoryFailure(error)) { gitHasContent = true; note(changes, errorText(error)); } }
  finally { if (current === version) { gitStatus = complete ? 'complete' : 'error'; changes.dataset.status = gitStatus; banner(); } }
}
changes.addEventListener('click', event => { const row = event.target.closest('[data-path]'); if (row) select({ path: row.dataset.path, mode: 'diff' }); });
async function render(data) {
  dispose();
  const selected = selection;
  const versionAtRender = version, renderId = selection?.id;
  const { renderWorkspace } = await import('../../workspace/monaco.js');
  if (versionAtRender !== version || selection?.id !== renderId) return;
  const mode = selected.mode;
  const side = mode === 'diff' && !data.before.exists ? 'after' : mode === 'diff' && !data.after.exists ? 'before' : '';
  el('wv-editor').dataset.side = side; el('wv-diff-headings').dataset.side = side;
  editor = renderWorkspace(el('wv-editor'), data, selected.path, mode, theme()); empty('');
  el('wv-diff-headings').hidden = mode !== 'diff';
  el('wv-diff-headings').children[0].hidden = mode === 'diff' && !data.before.exists;
  el('wv-diff-headings').children[1].hidden = mode === 'diff' && !data.after.exists;
}
function selectionControls() {
  if (!selection) return;
  const change = changeFiles.get(selection.path);
  if (change) { selection.repo = change.repo; selection.changePath = change.path; }
  el('wv-file').parentElement.hidden = !change && selection.mode !== 'diff';
  el('wv-diff').hidden = !change && selection.mode !== 'diff'; el('wv-file').disabled = change?.afterExists === false;
  el('wv-file').setAttribute('aria-pressed', String(selection.mode === 'file')); el('wv-diff').setAttribute('aria-pressed', String(selection.mode === 'diff'));
}
async function select(next, same = false) {
  if (!canRead() || !directory?.id) return;
  const old = same ? documentData : null;
  client.cancelDocuments();
  selection = { ...next, id: crypto.randomUUID() }; const id = selection.id, current = version;
  if (!same) { dispose(); documentData = null; readAt = null; stale = false; el('wv-diff-headings').hidden = true; empty(t.loading); banner(); } else { stale = !!readAt; banner(); }
  el('wv-document-top').hidden = false;
  const parts = selection.path.split('/'), name = document.createElement('strong'); name.textContent = parts.pop();
  const parent = document.createElement('span'); parent.className = 'wv-path-parent'; parent.textContent = parts.length ? `${parts.join(' / ')} / ` : '';
  el('wv-path').replaceChildren(parent, name);
  selectionControls();
  highlight();
  try {
    const operation = selection.mode === 'diff' ? { op: 'diff', repo: selection.repo, path: selection.changePath } : { op: 'read', path: selection.path };
    const data = await client.request({ ...operation, directory });
    if (current !== version || selection?.id !== id) return;
    for (const key of ['file', 'before', 'after']) if (data[key]) delete data[key].bytes;
    documentData = data; readAt = data.readAt; stale = false; banner(); await render(data); return true;
  } catch (error) {
    if (current !== version || selection?.id !== id || error.code === 'workspace_cancelled') return;
    if (directoryFailure(error)) return;
    if (same && old) { documentData = old; stale = true; banner(); } else { dispose(); empty(errorText(error)); banner(); }
  }
}
async function initialize() {
  if (!canRead()) return;
  const current = version;
  try {
    const result = await client.request({ op: 'locations' });
    if (current !== version) return;
    navigation.locations(result.value);
    await navigate(directoryPreference(boot.viewerAccount, computer.computerId) || result.value.defaultPath);
  } catch (error) { if (current === version && error.code !== 'workspace_cancelled') { directoryError = error; banner(); } }
}
async function navigate(path, bound = null, restore = null) {
  if (!canRead()) return;
  const current = ++version;
  client.cancelAll(); clearContent(); directory = null; directoryError = null; defaultWorkspace = false; navigating = true;
  currentPath = path; navigation.path(path); banner();
  try {
    const result = await client.request({ op: 'list', path: '', cursor: null, directory: bound || { path } });
    if (current !== version) return;
    directory = result.meta.directory; defaultWorkspace = result.meta.defaultWorkspace; currentPath = directory.path; navigating = false;
    const data = result.value, item = { path: '', container: tree, entries: data.entries, nextCursor: data.nextCursor, truncated: data.truncated, expanded: true };
    directories.set('', item); drawDirectory(item); navigation.path(currentPath);
    if (data.truncated) { const p = document.createElement('p'); p.className = 'wv-list-note'; p.textContent = t.truncated; tree.append(p); }
    gitStatus = directory.id ? 'loading' : 'idle';
    if (directory.id) { directoryPreference(boot.viewerAccount, computer.computerId, directory.path); readAt = result.readAt; }
    banner();
    if (directory.id) {
      const results = [await loadChanges()];
      if (current !== version) return;
      for (const path of restore?.expanded || []) {
        const row = [...tree.querySelectorAll('[data-kind="directory"]')].find(row => row.dataset.path === path);
        if (!row || directories.size >= 64) continue;
        const container = document.createElement('div'); container.className = 'wv-tree-children'; container.setAttribute('role', 'group'); row.after(container); row.setAttribute('aria-expanded', 'true'); row.firstElementChild.textContent = '⌄'; results.push(await loadDirectory(path, container));
        if (current !== version) return;
      }
      if (restore?.selection) results.push(await select(restore.selection));
      if (restore && current === version && results.every(Boolean)) el('wv-read-at').textContent = format(t.refreshed, { time: time(Date.now()) });
    }
    return true;
  } catch (error) {
    if (current !== version || error.code === 'workspace_cancelled') return;
    clearContent(); directory = null; navigating = false; directoryError = error; banner();
  }
}
async function refresh() {
  if (!canRead()) return;
  if (!currentPath) return initialize();
  const restore = { selection: selection && { ...selection }, expanded: [...directories.values()].filter(d => d.path && d.expanded).map(d => d.path).sort((a, b) => a.split('/').length - b.split('/').length).slice(0, 63) };
  await navigate(currentPath, directory?.id ? { ...directory } : null, restore);
}
el('wv-refresh').addEventListener('click', () => refresh());
el('wv-file').addEventListener('click', () => selection && select({ ...selection, mode: 'file' }));
el('wv-diff').addEventListener('click', () => selection && select({ ...selection, mode: 'diff' }));
async function hosts() {
  try {
    const response = await fetch(`/r/${boot.topic.id}/workspace/hosts`, { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) return;
    const data = await response.json(), menu = el('wv-computers'); menu.replaceChildren();
    el('wv-computer').disabled = data.computers.length <= 1; el('wv-computer').dataset.many = String(data.computers.length > 1);
    for (const value of data.computers) {
      const button = document.createElement('button'); button.type = 'button'; button.dataset.computer = value.computerId; button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(value.computerId === computer.computerId));
      const dot = document.createElement('span'); dot.className = 'wv-status-dot'; dot.dataset.online = String(value.online); dot.setAttribute('aria-hidden', 'true');
      const name = document.createElement('span'); name.className = 'wv-computer-name'; name.textContent = value.name; const state = document.createElement('small'); state.textContent = value.online ? t.online : t.offline;
      const check = document.createElement('span'); check.className = 'wv-computer-check'; check.textContent = value.computerId === computer.computerId ? '✓' : ''; check.setAttribute('aria-hidden', 'true');
      button.append(dot, name, state, check); menu.append(button);
      button.addEventListener('click', () => { if (computer.computerId === value.computerId) { menu.hidden = true; return; } clearAll(); computer = value; history.replaceState(null, '', `/r/${boot.topic.id}/workspace?computer=${encodeURIComponent(value.computerId)}${boot.embed ? '&embed=1' : ''}`); menu.hidden = true; setup(); });
    }
  } catch {}
}
el('wv-computer').addEventListener('click', () => { el('wv-computers').hidden = !el('wv-computers').hidden; el('wv-computer').setAttribute('aria-expanded', String(!el('wv-computers').hidden)); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && boot.embed) { event.preventDefault(); event.stopImmediatePropagation(); parentMessage('close'); } }, true);
window.addEventListener('message', event => {
  if (!boot.embed || event.origin !== location.origin || event.source !== parent || event.data?.version !== 1 || event.data.type !== 'init' || typeof event.data.instanceId !== 'string') return;
  if (instanceId && instanceId !== event.data.instanceId) return;
  instanceId = event.data.instanceId;
  if (event.data.theme === 'light' || event.data.theme === 'dark') { document.documentElement.dataset.scorpioEffectiveTheme = event.data.theme; editor?.theme(event.data.theme); }
  parentMessage('computer', { computerId: computer.computerId });
});
window.addEventListener('pagehide', () => { clearAll(); });
document.addEventListener('scorpio-theme', () => editor?.theme(theme()));
setup();
