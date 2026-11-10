import { absoluteWorkspacePath } from './workspace-assets/wire.js';

export function directoryPreference(account, computerId, value) {
  const key = `view-files-directory-v1:${account}:${computerId}`;
  try {
    if (value !== undefined) { if (absoluteWorkspacePath(value)) localStorage.setItem(key, value); return; }
    const saved = localStorage.getItem(key);
    if (saved === null) return null;
    if (absoluteWorkspacePath(saved)) return saved;
    localStorage.removeItem(key);
  } catch {}
  return null;
}
export const parentDirectory = path => path === '/' ? '/' : path.slice(0, path.lastIndexOf('/')) || '/';
export const childDirectory = (root, relative) => `${root === '/' ? '' : root}/${relative}`;

export function createDirectoryNavigation({ t, onNavigate, canNavigate }) {
  const el = id => document.getElementById(id), crumbs = el('wv-breadcrumbs'), menu = el('wv-locations'), ancestors = el('wv-ancestors');
  let current = null, locations = null, entries = [], compact = null, measure = null;
  const button = (text, path) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.dataset.directory = path; return b; };
  function close() { menu.hidden = ancestors.hidden = true; el('wv-directory-toggle').setAttribute('aria-expanded', 'false'); el('wv-ellipsis')?.setAttribute('aria-expanded', 'false'); }
  function availability() {
    el('wv-up').disabled = !canNavigate() || !current || current === '/';
    el('wv-root-note').hidden = current !== '/';
    el('wv-directory-toggle').disabled = !canNavigate() || !locations;
    for (const b of crumbs.querySelectorAll('button')) b.disabled = !canNavigate();
  }
  function drawCrumbs(folded) {
    compact = folded; crumbs.dataset.compact = String(folded); crumbs.replaceChildren(measure); ancestors.replaceChildren(); ancestors.hidden = true;
    const visible = folded ? [entries[0], { label: '…' }, ...entries.slice(-2)] : entries;
    for (const [index, entry] of visible.entries()) {
      if (index) { const separator = document.createElement('span'); separator.className = 'wv-crumb-separator'; separator.textContent = '›'; crumbs.append(separator); }
      const b = button(entry.label, entry.path || '');
      if (!entry.path) { delete b.dataset.directory; b.id = 'wv-ellipsis'; b.setAttribute('aria-label', t.ancestors); b.setAttribute('aria-expanded', 'false'); }
      if (entry.path === current) b.setAttribute('aria-current', 'page');
      b.title = entry.path || t.ancestors; crumbs.append(b);
    }
    if (folded) for (const entry of entries.slice(1, -2)) ancestors.append(button(entry.label, entry.path));
    availability();
  }
  function fitCrumbs() {
    if (!measure || !entries.length) return;
    const folded = entries.length > 3 && measure.getBoundingClientRect().width > crumbs.clientWidth;
    if (folded !== compact) drawCrumbs(folded);
  }
  const observer = new ResizeObserver(fitCrumbs); observer.observe(crumbs);
  function path(value) {
    close(); current = value; compact = null; crumbs.replaceChildren(); ancestors.replaceChildren();
    const parts = value ? value.split('/').filter(Boolean) : [];
    entries = [{ label: '/', path: '/' }, ...parts.map((label, i) => ({ label, path: '/' + parts.slice(0, i + 1).join('/') }))];
    measure = document.createElement('span'); measure.className = 'wv-crumb-measure'; measure.setAttribute('aria-hidden', 'true');
    for (const [i, entry] of entries.entries()) {
      if (i) { const separator = document.createElement('span'); separator.className = 'wv-crumb-separator'; separator.textContent = '›'; measure.append(separator); }
      const probe = document.createElement('span'); probe.className = 'wv-crumb-probe'; probe.textContent = entry.label;
      if (entry.path === current) probe.setAttribute('aria-current', 'page'); measure.append(probe);
    }
    crumbs.append(measure); fitCrumbs(); drawLocations();
  }
  function heading(text) { const p = document.createElement('p'); p.className = 'wv-location-heading'; p.textContent = text; menu.append(p); }
  function drawLocations() {
    menu.replaceChildren(); if (!locations) return;
    function item(entry) {
      const b = button('', entry.path); b.className = 'wv-location-item'; b.setAttribute('role', 'option'); b.setAttribute('aria-selected', String(current === entry.path));
      const icon = document.createElement('span'); icon.className = 'wv-location-icon'; icon.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 5V3h5l2 2h7v9H1Z"/></svg>'; icon.setAttribute('aria-hidden', 'true');
      const copy = document.createElement('span'); copy.className = 'wv-location-copy';
      const label = entry.kinds.includes('default') ? t.defaultDirectory : entry.kinds.includes('home') ? t.homeDirectory : '';
      if (label) { const title = document.createElement('strong'); title.textContent = label; copy.append(title); }
      const p = document.createElement('span'); p.className = 'wv-location-path'; p.textContent = entry.path; copy.append(p);
      if (entry.agents?.length) { const names = document.createElement('small'); names.textContent = entry.agents.join('\n'); copy.append(names); }
      const check = document.createElement('span'); check.className = 'wv-location-check'; check.textContent = current === entry.path ? '✓' : '';
      b.append(icon, copy, check); menu.append(b);
    }
    const agents = locations.entries.filter(e => e.kinds.includes('agent') && !e.kinds.includes('default') && !e.kinds.includes('home'));
    heading(t.agentDirectories); agents.forEach(item);
    heading(t.otherDirectories); locations.entries.filter(e => e.kinds.includes('default') || e.kinds.includes('home')).forEach(item);
    if (locations.truncated) { const p = document.createElement('p'); p.className = 'wv-list-note'; p.textContent = t.truncated; menu.append(p); }
  }
  el('wv-directory-toggle').addEventListener('click', () => { const open = menu.hidden; close(); menu.hidden = !open; el('wv-directory-toggle').setAttribute('aria-expanded', String(open)); });
  el('wv-up').addEventListener('click', () => { if (current && current !== '/' && canNavigate()) onNavigate(parentDirectory(current)); });
  el('wv-navigation').addEventListener('click', event => {
    const b = event.target.closest('button[data-directory]');
    if (b && canNavigate()) { close(); onNavigate(b.dataset.directory); }
    else if (event.target.closest('#wv-ellipsis')) { const open = ancestors.hidden; close(); ancestors.hidden = !open; el('wv-ellipsis').setAttribute('aria-expanded', String(open)); }
  });
  document.addEventListener('click', event => { if (!el('wv-navigation').contains(event.target)) close(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && (!menu.hidden || !ancestors.hidden)) { event.preventDefault(); event.stopImmediatePropagation(); close(); el('wv-directory-toggle').focus(); } }, true);
  return { path, availability, locations(value) { locations = value; drawLocations(); availability(); }, clear() { current = locations = measure = null; entries = []; compact = null; close(); crumbs.replaceChildren(); menu.replaceChildren(); availability(); } };
}
