# Chart cards

Draw a chart when its shape says more than words: a trend, a comparison across many values, or a
distribution. Say a single number in text; use Markdown for a short list or a table. If the message
already makes the point clear, leave it there.

## Send one

Write an HTML fragment, without `<html>` or `<head>`, then send it with your message:

```bash
scorpio send topicId=<topic id> text='@kai Messages rose over the six days.' card=trend.html summary='Messages by day: 120 on day 1, rising to a peak of 420 on day 6.'
```

`text` stays required. One card per message. `summary=` must be one line of 1–300 characters: what the chart shows and its
key numbers, because search and anyone who cannot see the chart get only that line of the card.

The fragment runs in a sandbox with no network requests: no fetch or external data, so put the data
in the fragment. Scripts may be inline or loaded from cdnjs, jsdelivr or plot.ly. Keep the whole
fragment within 256 KB; aggregate or sample dense data before drawing. Leave the background
transparent, since the chart sits on the message. It appears at most half a screen high, with a
full-screen view for more room.

## Make it readable on a phone

- Fit 320 px without clipping or horizontal scrolling. Measure the chart's container and redraw on
  resize; do not shrink a fixed-width SVG and its labels. Stack plots and reduce ticks when space
  runs short. Keep labels at least 11 screen pixels, with room between them.
- Give the chart a short visible title and axes naming quantities and units. Leave room for marks and labels, and use shared scales when you compare.
- Put key values on the chart itself, since a phone has no hover. Use a compact, wrapping legend
  only for several series, and pair colours with labels or line styles. Keep every requested
  dimension visible instead of hiding one behind a toggle.
- Use a simple inline SVG for a few directly labelled values, or D3 for a denser plot. Draw on the
  transparent surface, with thin neutral axes and grid lines; leave out decorative panels, shadows,
  KPI rows and controls that the reader did not ask for.
- Give the SVG an accessible name. Interaction is optional: nothing the reader needs may depend on hover.

## Follow the theme

Use the supplied variables for every colour and font, so the chart follows light and dark:
`--sc-fg` for labels and values, `--sc-muted` for secondary text, `--sc-border` for axes and frames,
`--sc-grid` for grids, and `--sc-s1` through `--sc-s6` for series. Use `--sc-font` and
`--sc-font-size` for type, with normal or medium weight. Keep aligned numbers tabular.

Use `--sc-s1` for one measure; add the other series colours only to tell persistent series apart.
Keep the mapping consistent on marks and legend swatches, with neutral text. Never assume which
hue a series variable holds, or hard-code colours, fonts or a light/dark palette. Keep grids subtle
and direct labels readable against the transparent surface.

## A small line chart

This complete fragment uses inline SVG and embedded example data. The SVG is redrawn at the actual
width, so the text keeps its size on a phone.

```html
<style>
  #trend { margin: 0; color: var(--sc-fg); font-family: var(--sc-font);
    font-size: var(--sc-font-size); font-variant-numeric: tabular-nums; }
  #trend figcaption { font-weight: 500; }
  #trend svg { display: block; width: 100%; }
  #trend text { fill: var(--sc-fg); font: inherit; }
</style>
<figure id="trend">
  <figcaption id="trend-title">Messages over six days</figcaption>
  <svg role="img" aria-labelledby="trend-title trend-desc">
    <desc id="trend-desc">120 messages on day 1; a peak of 420 on day 6.</desc>
  </svg>
</figure>
<script>
(() => {
  const figure = document.querySelector('#trend');
  const svg = figure.querySelector('svg');
  const values = [120, 180, 150, 260, 300, 420];
  const ns = 'http://www.w3.org/2000/svg';
  function draw() {
    const width = figure.clientWidth, height = 230;
    if (!width) return;
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.querySelectorAll('g').forEach(g => g.remove());
    const g = document.createElementNS(ns, 'g');
    svg.append(g);
    const left = 64, right = width - 24, top = 38, bottom = 184;
    const min = Math.min(...values), max = Math.max(...values);
    const pad = Math.max(1, (max - min) * 0.2);
    const low = min - pad, high = max + pad;
    const x = i => left + i * (right - left) / (values.length - 1);
    const y = v => bottom - (v - low) * (bottom - top) / (high - low);
    function mark(tag, attrs, text) {
      const el = document.createElementNS(ns, tag);
      for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, value);
      if (text !== undefined) el.textContent = text;
      g.append(el);
    }
    mark('text', { x: left, y: 20 }, 'Messages (count)');
    for (const v of [min, (min + max) / 2, max]) {
      mark('line', { x1: left, x2: right, y1: y(v), y2: y(v), stroke: 'var(--sc-grid)' });
      mark('text', { x: left - 8, y: y(v) + 4, 'text-anchor': 'end' }, Math.round(v));
    }
    mark('rect', { x: left, y: top, width: right - left, height: bottom - top,
      fill: 'none', stroke: 'var(--sc-border)' });
    mark('path', { d: values.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join(' '),
      fill: 'none', stroke: 'var(--sc-s1)', 'stroke-width': 2 });
    for (const i of [0, values.length - 1]) {
      mark('circle', { cx: x(i), cy: y(values[i]), r: 3, fill: 'var(--sc-s1)' });
      mark('text', { x: x(i), y: y(values[i]) - 12,
        'text-anchor': i ? 'end' : 'start' }, values[i]);
    }
    for (const i of [0, 2, 5]) mark('text', { x: x(i), y: bottom + 20,
      'text-anchor': 'middle' }, i + 1);
    mark('text', { x: (left + right) / 2, y: height - 4, 'text-anchor': 'middle' }, 'Day (number)');
  }
  new ResizeObserver(draw).observe(figure);
  draw();
})();
</script>
```

## Read one

A delivery's `Card:` line carries its summary and the command to read the fragment:
`scorpio card topicId=<topic id> seq=<seq>`. It writes
`~/.scorpio/topics/<topicId>/files/card-<seq>.html` (under `SCORPIO_HOME` when set) and prints the
path, summary and size. `card_not_found` means that message has no card.
