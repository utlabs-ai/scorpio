// The chart fragment's wrapper (docs/api/messages.md, Cards). Tokens follow the room page's (room-tokens.css, docs/design.md §2):
// fg, muted and the lines are the page's --fg, --muted and --line; the series are its --chart-1 … --chart-6.
// The frame cannot read the page's variables, so the values are written out here.
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", "Hiragino Sans GB", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif';
const theme = (fg: string, muted: string, line: string, series: string[]) => ({
  "--sc-fg": fg, "--sc-muted": muted, "--sc-border": line, "--sc-grid": line, "--sc-bg": "transparent",
  ...Object.fromEntries(series.map((colour, i) => [`--sc-s${i + 1}`, colour])), "--sc-font": FONT, "--sc-font-size": "16px",
});
export const CARD_THEMES = {
  light: theme("#131927", "#5c6374", "rgba(19, 25, 39, 0.09)", ["#344da2", "#c27400", "#00936a", "#7a52c7", "#2098b2", "#b73a80"]),
  dark: theme("#e9edf5", "#9ca5b8", "rgba(150, 170, 220, 0.13)", ["#80a0f9", "#e58d1a", "#21c08e", "#af8cff", "#0dc1d0", "#cc6da4"]),
};
const js = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c");
export function cardWrapper(fragment: string, parentOrigin: string, theme: "light" | "dark"): string {
  const vars = Object.entries(CARD_THEMES[theme]).map(([k, v]) => `${k}:${v}`).join(";");
  // color-scheme follows the page's: a frame whose scheme differs from its page's is painted opaque (white in a dark page).
  // Installed before the fragment: an error in its scripts suppresses ready. Only the actual parent on our origin
  // can send theme/ping, and every message goes to that origin, never '*'. load follows the fragment's scripts.
  const bridge = `<script>(function(){var P=${js(parentOrigin)},W=parent,T=${js(CARD_THEMES)},failed=false;` +
    `addEventListener("error",function(){failed=true},true);addEventListener("unhandledrejection",function(){failed=true});` +
    `function size(){W.postMessage({type:"scorpio:size",height:Math.ceil(Math.max(document.documentElement.scrollHeight,document.body?document.body.scrollHeight:0))},P)}` +
    `addEventListener("message",function(e){if(e.source!==W||e.origin!==P||!e.data)return;var d=e.data;` +
    `if(d.type==="scorpio:ping")W.postMessage({type:"scorpio:pong",n:d.n},P);` +
    `if(d.type==="scorpio:theme"&&(d.theme==="light"||d.theme==="dark")){var r=document.documentElement.style;r.colorScheme=d.theme;Object.keys(T[d.theme]).forEach(function(k){r.setProperty(k,T[d.theme][k])});size()}});` +
    `addEventListener("load",function(){new ResizeObserver(size).observe(document.body);size();if(!failed)W.postMessage({type:"scorpio:ready"},P)})})();</script>`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>:root{color-scheme:${theme};${vars}}html,body{margin:0;background:var(--sc-bg);color:var(--sc-fg);font-family:var(--sc-font);font-size:var(--sc-font-size)}</style>${bridge}</head><body>${fragment}</body></html>`;
}
