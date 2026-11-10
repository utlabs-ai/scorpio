# Design guide

This guide covers how Scorpio's web UI looks and behaves: the topic page, the app shell (`/app`, settings, my data) and the public site. Every page shares one set of colour tokens, `web/public/static/room-tokens.css`. Use this guide in two places:

- **Building.** A change that touches the UI follows this guide. It names the parts from §4 that it uses, and it says whether it needs a new look.
- **Reviews.** Whoever reviews the shots goes through the checklist in §10 before approving them.

Anything this guide doesn't cover, and any new look, is decided from hi-fi mockups before it is built. Once it is, add the decision to this file.

## 1 · Principles

1. **One family.** The topic page, the app shell and the public site use the same tokens and the same parts. A new page reuses a part from §4 before it invents one.
2. **Quiet by default.** Colour tells you who has to act (§2). Only things that are happening right now move (§7).
3. **What people and agents type is content.** Show it as written. Restyle it (colour, weight) but never rewrite, strip or move it for display: no "→ to whom" line built from the leading @names, and no trimmed quotes.
4. **Every row stands on its own.** Each message shows its avatar and name, even in a burst from the same sender.
5. **Don't over-design.** Use a card only when the thing is an object (a plan, an invite, a file). Not everything is a card. Talk through a sketch before building something big.
6. **Defaults are visible.** A control shows its default as a selected value (「全部」, all four types ticked), never as an empty box (search filters). A control that doesn't apply turns grey; it doesn't disappear.

## 2 · Colour

Feature CSS uses tokens only, never raw hex values. Both themes ship together. Dark rules go under `:root[data-scorpio-effective-theme="dark"]`, and `theme.js` resolves the user's choice against the system setting. The values below are the final ones (the tuned block at the end of room-tokens.css).

| Token | Light | Dark | Use for | Never for |
|---|---|---|---|---|
| `--bg` | `#eef1f7` | `#070b15` | page background (dark carries the star field) | cards |
| `--surface` | `#ffffff` | `#121a2c` | cards, sheets, popovers, list backgrounds | page background |
| `--fg` / `--muted` | `#131927` / `#5c6374` | `#e9edf5` / `#9ca5b8` | text / secondary text, labels, idle states | — |
| `--line` / `--line-strong` | 9 % / 22 % ink | 13 % / 30 % blue-grey | hairlines / outlines of unselected controls, field edges | fills |
| `--hl` | `#e7ebf3` | `#1d2740` | fills: fields, secondary buttons, the `.seg` track, the current row in a list | the selected state of a filter (use the link tint) |
| `--code-bg` | `#edf0f6` | `#1a2338` | code, the composer textarea | — |
| `--action` / `--action-fg` | ink `#131927` / white | light `#e9edf5` / `#070b15` | the one primary button in a view, send, the jump pill | links, selected states |
| `--link` | `#344da2` | `#a7c0f9` | links, `#n` refs, other people's @mentions, selected filters and chips, focus rings, pressed toggles | buttons that start something |
| `--you` / `--you-ink` / `--you-soft` / `--you-tint` / `--you-line` | `#da3b2e` / `#ba2c22` … | `#f2564a` / `#f97165` … | **only things that need the viewer**: @you (red ring, thicker on the left), a task waiting on you, your own message that didn't send, sign in again, the destructive confirm | brand accents, primary buttons, links, errors that fix themselves |
| `--live` / `--live-ink` / `--live-soft` | `#009869` / `#007852` / `#dff7ea` | `#51cf9b` / `#62d8a6` / `#0c2c1f` | an agent working, a person online, read, a finished result | big green banners |
| `--wait` / `--wait-ink` / `--wait-soft` | `#d07b00` / `#995600` / `#fff1d6` | `#f2b458` / `#f8bf6c` / `#34220b` | stuck, waiting on something else, the computer is offline (delivered later), reconnecting | anything that needs the viewer |
| `--mine*` | `#1f2b47` … | `#27375c` … | the viewer's own message bubble | anything else |
| `--bar*` | light: paper (`bar-light.css`) | night sky `#0b101d` + stars | the top bar of every signed-in page | — |
| `--brand-star` | `#da3b2e` | `#f2564a` | the star in the S mark: the one red that isn't "you" | — |
| `--chart-1` … `--chart-6` | `#344da2` / `#c27400` / `#00936a` / `#7a52c7` / `#2098b2` / `#b73a80` | `#80a0f9` / `#e58d1a` / `#21c08e` / `#af8cff` / `#0dc1d0` / `#cc6da4` | chart series, in this order: blue, amber, green, purple, cyan, pink. Chart cards get the same values as `--sc-s1` … `--sc-s6` (`server/src/card-wrapper.ts`), since the card frame can't read the room's tokens | states (use `--live` / `--wait` / `--you`), text, fills behind text |
| `--scrim` | ink 42 % | black 55 % | behind sheets and dialogs | — |

How each status reads on screen:

| Who | Green | Amber | Red | Grey |
|---|---|---|---|---|
| Agent | working | stuck | waiting on you | idle or offline |
| Person | online | — | — | not online |
| Task | doing, done | waiting on another task | waiting on you | to do |
| Message | read | delivered later | not sent, agent gone | sending, sent |

Rules:
- **Red is only for "you".** If a red thing on screen doesn't need the viewer to act, it's wrong. Errors split by who has to act: if the viewer has to act it's red, if it will fix itself it's amber.
- **Blue means "selected" or "you can follow this".** A selected filter or chip uses a link tint: `color-mix(in srgb, var(--link) 15%, transparent)` with `--link` text and a `--link` 45 % edge. Mixing a token toward transparent like this is the only allowed way to derive a colour. A new hex value means a new token, which is a design decision, not a build one.
- **One primary (ink) button per view.** Everything else is a secondary button, a link or a chip.
- **Never paint the feed or a panel solid in dark.** It hides the star field.
- **Contrast.** Text is at least 4.5:1 on its background and status marks at least 3:1, in both themes.
- **Charts use `--chart-*`, never the status colours.** Series take them in order: a series keeps its colour when a filter hides others, and a seventh series is folded into 「其他」 or the chart is split. Two or more series always get a legend, so colour is never the only cue. There is no red in the set, because red means "you". Checked for both themes: neighbouring series stay apart under red-green colour blindness (OKLab ΔE ≥ 8) and each series is at least 3:1 on `--surface`.

## 3 · Type, shape, size

- **Fonts.** `--font` is the system UI stack with PingFang SC / Noto Sans CJK SC; `--mono` is for code and commands. Don't load web fonts on the topic page.
- **Sizes on the topic page:**
  - message text: 15.5px, line-height 1.58
  - list rows and names: 15.5px 650
  - segmented control: 14.5px 650
  - chips and meta: 13px 650
  - row labels: 12.5px 650 `--muted`
  - group headings: 11.5–12px 750 `--muted`
- **Inputs.** Any text field you can type into is at least **16px** on phones, or iOS zooms in.
- **Chinese text.** Don't use `text-wrap: balance` on Chinese, because it splits phrases; it's for English only. Keep phrases that must not break in `nowrap` spans. Put a space on each side of a number in Chinese UI words (「近 7 天」).
- **Corners:**
  - buttons, chips, `.seg`, the composer: full pill
  - search field: 13
  - list rows: 10–13
  - cards: 14–20
  - popovers: 14–16
  - dialogs: 16
  - sheets: 24 on the top corners
- **Heights:**
  - top-bar icons: 44 (tap area at least 44)
  - buttons: 40; `.btn.sm`: 30
  - chips and `.seg`: 32
  - search field and composer: 42
  - list rows: 40–48
  - Nothing you can tap inside a panel is smaller than 32.

## 4 · Parts: use these

Pick the part by what the user is doing. Class names are the live ones, under `.ui` on the topic page and `sx-` on the site and the app shell. The `sf-` parts are the search filter parts (chips, field + listbox, date face).

| The user wants to… | Part | Notes |
|---|---|---|
| do the main thing in this view | `.ui .btn.primary` (site: `.sx-btn.sx-primary`) | ink; one per view |
| do something else | `.ui .btn` (fill `--hl`), `.btn.line` (outline), `.btn.sm` (30) | |
| act on something that needs them | `.btn.you` | red; "叫它回来" and the like |
| delete or end something | `.btn.danger` as text, confirmed by `ask()` with `.btn.dangerfill` | never `confirm()` |
| switch between 2–5 views | `.seg` / `.seg.sm` | the selected one is the raised `--surface` pill |
| turn a setting on or off | `.sw` (settings rows), `input.sw` (forms), `.sx-sw` | green when on |
| pick one of a few short values (filters) | `.sf-chip[role=radio][aria-checked]` | link tint when selected |
| pick several values | `.sf-chip.multi[aria-pressed]` with a ✓ | the last one can't be turned off |
| see a control that doesn't apply right now | the same part with `disabled`: outline `--line-strong`, `--muted` text, no tint and no ✓, opacity .45 | grey it, never hide it: things don't vanish without a visible reason (search scope row) |
| pick one of many (people, agents, long lists) | a field button `.sf-pick` + listbox `.sf-list` with a filter box at the top; the `#picker` rows (`.pickrow`, `.hi`) in the composer | avatars from the feed's `avatar()` |
| type to search or filter | `.searchfield` (room), `.sx-searchfield` (app shell) | magnifier, `--hl` fill, round × to clear |
| fill in a command's parameters before sending | the `/spawn` card: `.spf` outlined fields with the name on the top edge, each opening an `.spl` list | only /spawn gets a card; untouched fields say "· default" |
| type a value in a form | `.sx-in` (site pages); the composer and `.topicedit` textareas | |
| pick a date | a face (`.sf-date`, `.sched-face`) over a transparent native `input type=date` that opens with `showPicker()` | only the picker popup is native |
| pick days of the week | seven round toggles (`.sched-days`), outline when off, link tint when on | no ✓ inside a one-letter circle; never the ink fill |
| set a small count ("every [3] days") | the value pill (`.sched-every input`, 38 high, `--hl`) inside the sentence | clamp to the allowed range on change; no spinners |
| choose an action from a menu | `.pop` + `.pi` (room ⋯, avatar menu), `.sx-menu` (app shell), the message menu | a floating popover; a full-width sheet on phones |
| see more without leaving the page | `.sheet` from the bottom on phones; the right side column or a floating sheet (380 / 420) on desktop | `.grab`, `.sh`, `.x` (32) |
| confirm something | `ask()` (`.dialog .box`, bottom sheet on phones) | never `alert` / `confirm` / `prompt` |
| hear that something happened | `toast()`; the connection state goes in `#status` | |
| see a task, a seat, a message state | `.ichip` (task chip), `.ck` (task ring), robots / `.sd` (seats), `.rc` (receipts) | see the table in §2 |
| see who someone is | robot (agent), daemon icon (computer), `.pav` letter (person), clock (scheduled) | every row has one |
| see that there's nothing | `.empty`, `.fl-empty`: one line | |

## 5 · Native controls

The browser's own control face must not show anywhere:

- `select`, checkbox, radio
- the face of `input type=date` / `time` / `number` and its spinners
- range sliders
- the search cancel ×: hide it with `appearance: none` on `::-webkit-search-cancel-button` and draw the round ×
- a visible `input type=file`
- the browser's default focus ring
- `alert` / `confirm` / `prompt`
- the `details` marker

Allowed:
- the system's own popups: the date or time wheel and calendar, the file chooser, the share sheet, the keyboard
- a real `input` or `textarea` as the typing surface inside one of our fields

When an existing part doesn't fit, design a new one first. Don't ship the native face "for now": in v0.18.0 the search filters shipped as a native `select`, checkboxes and date boxes, and had to be redone.

Still to fix (do it when you next touch these):
- the topic settings visibility radios (`label.radio`, room-settings.js)
- the native search × in `.searchfield` and the member filter box
- the schedule form's calendar indicator, which shows at 50 % (the date fields go away with the every-N-days change; the time field keeps it for now)
- there is no global `:focus-visible` rule, so `.ui` buttons show the browser ring. The rule to use: a 2px `--link` ring (inset on filled parts).

## 6 · Layout

- **Phone (≤ 760).**
  - Panels are bottom sheets.
  - The composer has two layers.
  - Long messages fold.
  - The menus become full-width sheets.
  - Side gutters are 14–16.
- **Desktop (≥ 761).**
  - `.ui.desk` is a grid with a 380 side column.
  - The search drawer docks right at 390.
  - Sheets float (380, or 420 for `.up`).
  - Long messages don't fold.
  - `.ui.desk` is on the page at every width, so never use it as a desktop test. Use the media query.
- **`/app` (≥ 1024)** shows the 286 sidebar.
- **Check widths.** Check 360, 390 and 1280, in zh and en, in light and dark. No sideways page scroll at 360: `document.documentElement.scrollWidth` must equal the window width.
- **Things that don't fit wrap whole onto the next line.** Don't truncate a control's label and don't scroll a row of controls sideways. The only exception is `.seg`, which may scroll with its fade.
- Respect safe areas at the bottom on phones.

The desktop workspace viewer uses a 272 px tree inside the topic overlay and a 300 px tree in its standalone page. The overlay starts at 75% of the window, bounded by 880 px and window width minus 120 px; narrower desktop windows use that remaining width without dragging. Only Close and Esc close it. Its first document view is empty until a file is selected; single-sided changes occupy only their existing side. The standalone view omits overlay controls. Viewer code uses Monaco at 13 px / 20 px and the existing mono font token, in both themes.

An empty workspace, an offline computer without completed content, and revoked access share one full-content empty state on `--bg`. Empty/offline states replace the tree and Git columns; first-offline uses a monitor-off icon with its existing status sentence instead of a banner. A completed snapshot that goes offline keeps the content and amber banner. Computer options have a status dot and a separate current-item check. Document paths show muted parent segments separated by spaced slashes and a bold file name. Monaco uses the viewer code tokens in `room-tokens.css`: grey italic comments and line numbers, blue-purple keywords and teal strings, with light and dark palettes from the approved viewer designs.

- Only what is happening moves: sending, an agent working, the 在做 number in the top pill. A state change plays once: add `.fresh` and take it off after about 600 ms.
- One moving robot per agent: the one in the members list. Repeats of it (task rows, chips) use the default still icon (botStill with no state).
- Nothing red blinks.
- Draw motion with CSS and SVG, not GIF.
- Every loop stops under `prefers-reduced-motion`.

## 8 · Words

- UI words are agreed copy in Chinese and English; privacy and legal wording gets a legal review. Don't make up new words in a design or a build.
- Show names as 「昵称（账号名）」; agents by their full name.
- Say 主题 / topic, never 房间.

## 9 · Building it

- **The topic page's CSP is `style-src 'self'`.** No inline styles: set dynamic values through the CSSOM (`el.style.setProperty`).
- **Put new CSS in its own stylesheet, linked last.** `app.css` loads first, and equal-specificity ties go to the later file.
- **`app.css` has global rules that leak.** Every `label` is a grey flex column and every `input` is 100 % wide with a border. Scope your resets (`:where(…)`, or a part class).
- **Prefix new class names.** These are taken: `.row`, `.rc`, `.more`, `.pop`, `.long`, `.meta`, `.bub`, `.mh`, `.pics`. Grep before naming.
- **Keep the selectors other code relies on.** `openMenu` finds `.fm-top, .mh`. The lightbox opens only `.pics a > img`.
- **Hover styles go inside `@media (hover: hover)`.** On touch screens a `:hover` rule sticks after a tap.
- **Mockup CSS can carry layout that exists only for screenshots** (`overflow: hidden` feeds, fixed tops, absolute positions). Port colour, radius, spacing, type and shadow from a mockup, and keep the page's own scrolling, fixed positions and safe areas.

## 10 · Checklist (build and review)

## 7 · Motion

1. Every control is a part from §4, and no native face from §5 shows.
2. Colours are tokens. Red appears only on things that need the viewer. Selected states use the link tint. Focus shows a 2px `--link` ring.
3. Defaults are visible as selected values.
4. Tap areas are at least 32 inside panels and 44 in the top bar. Text inputs on phones are at least 16px.
5. Shots cover 360, 390 and 1280 × zh / en × light / dark, with no sideways scroll, nothing truncated and no overlap. Phone shots come from a browser at phone width; no iOS simulator or device shots.
6. Words are the agreed zh / en copy, and content is shown as typed.
7. The reviewer compares the shots with the approved mockup, pixel by pixel where the mockup is pixel-exact, and checks the states the mockup doesn't show (empty, long names, error, loading).

The View files viewer adds a 50 px directory bar with individually clickable path segments; long paths retain root and the last two segments, with omitted ancestors in a popover. Folder arrows expand in place and folder names enter a new current directory. The directory popover groups topic spawn associations above default workspace/home and shows full agent names as secondary text. Navigation clears the old tree, changes and document together. Missing/denied/non-directory/empty states use the full-content empty treatment while keeping the path bar; only the default workspace uses the original workspace-empty sentence. Partial Git discovery uses the existing amber tokens above the changes. The computer owner and read-only scope remain visible.

A tree with no entries does not hide pending or useful Git results. While Git is loading, has changes, is partial or failed, retain the sidebar and put the folder-empty sentence in the tree area; a deleted-only repository still exposes its deleted-file diff. Full-area empty states require both an empty tree and no useful Git content. Directory shortcuts use a 510 px popover (bounded on narrow viewports), 13 px paths/titles and 12 px agent labels. Breadcrumbs fold only when their measured full width exceeds the available path bar, and re-evaluate when that bar resizes.
