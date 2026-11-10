import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { build } from 'esbuild'

const moved = new URL('../src/strings.ts', import.meta.url)
const source = existsSync(moved) ? moved : new URL('../src/pages.ts', import.meta.url)
const built = await build({ entryPoints: [source.pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent' })
const { strings, ROOM_STRINGS } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

const paths = (value, prefix = '') => Object.entries(value).flatMap(([key, child]) => {
  const name = prefix ? `${prefix}.${key}` : key
  return child && typeof child === 'object' && !Array.isArray(child) ? paths(child, name) : [name]
}).sort()
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

test('page strings have the same English and Chinese key paths, including nested shell values', () => {
  assert.deepEqual(paths(strings('en')), paths(strings('zh')))
  assert.ok(paths(strings('en')).some((path) => path.startsWith('shell.')))
})

test('room script strings have the same English and Chinese key paths', () => {
  assert.deepEqual(paths(ROOM_STRINGS.en), paths(ROOM_STRINGS.zh))
})

// The attachments tab's strings come in and search's file group is renamed 「附件」 / Attachments: new room digests.
// The shell's collapse/open sidebar labels come in, in both languages: new page digests.
// /read, /keys and /text join the composer's commands, with 「还没进主题」 for a /spawn not joined yet: new room digests.
// The code block wrapping labels come in, in both languages: new room digests.
// Cloud handoffs add the member card's 「交接」 and left-member fold labels: new room digests.
// A pass over the Chinese text rewrites every Chinese value by meaning: new zh digests.
// Scheduled messages add the room page's bilingual schedule labels and state descriptions.
// The tab entry and first-load empty state replace the top-bar chip copy.
// Email-code sign-in adds both page languages' labels, errors and mail subject.
// 等你 has one meaning: the members summary drops it and says 离线 / offline; the task line and pill label name the running agents (1 agent / n agents), as does the agent count; English to-do reads "to do".
// cleanup-dead-code drops splitPrompt and waitEmpty, which no page code read any more: new room digests.
// ...and letAgentSplit and workingN, read by nothing either: new room digests.
// The card and Settings Invite share two short labels; the old leads and share labels are gone.
// Passcode length/retry and email-day-limit messages come in, in both page languages.
// Localized test-notification wait and topic person-limit page text come in.
// The sign-in tagline gets a new sentence: new page digests.
// The English member status is aligned with the capsule and task panel: new roomEn digest.
// A computer logged out adds the topic's logged-out line and the revoke confirmation: new room digests.
// The pricing descriptions and trial ribbon are aligned with the product introduction.
// Search filters add sender/kind/date controls, member filtering and the @me-only feed.
// The passcode page uses a generic private-topic heading without topic metadata.
// Schedule step form adds cadence units, full weekdays and repeat previews.
// Invitation spawn entry adds two labels and renames the existing-agent label.
// The /spawn card's name list lists every departed agent with a count and names the box's two uses: spMoreLeft goes, spNewName changes, spNewNameGroup and spNewNameNote are new: new room digests.
// The takeover note's English count gets a singular, spTaskOne: new room digests.
// The left column's unread count adds the shell's unread and unreadAt labels: new page digests.
// The @ list offers my own left agents: st_leftBack 「已离开 · @ 会叫回」 and leftNoTakeover for one that left no takeover command: new room digests.
// The jump notice reads 正在跳到 #N… / Going to #N…: new room digests.
// New approval wording updates approval cards and spawn notes in both languages.
// Card retry wording moves the failed press message onto the replacement card.
// Account permission settings and spawn choices add bilingual labels and result messages.
// Call-back confirmations use the takeover permission or account setting instead of the retired spawn note.
// Reply buttons and chart cards add the room page's ai labels: full screen, its close, the not-shown sentence and the buttons' screen-reader text: new room digests.
// Account-scoped pane screens add the prescribed bilingual key-hiding hint.
// The pricing page's words and the legal texts' binding note move to the deployment's own pages: new page digests.
// The memo source placeholder's example numbers become generic ones: new room digests.
// Scheduled messages gain the 「进日历」 switch, its hint and the list's 「日历」 mark, in both languages: new room digests.
// The left column's topic menu gains 归档 with its confirm, cancel and failure words in the shell: new page digests.
// Export adds the settings section, the sheet and topic.md's labels (exp, exportMd), in both languages: new room digests.
// Renaming a topic adds the popup's 「主题名」 / 「改名」 / 「已改名」 / 「名字不能为空」 and the feed's topic_renamed line, in both languages: new room digests.
// The overview page and the lane add gvLink, the gv block, the member card's lane row and the /spawn card's 「方向」 field, in both languages: new room digests.
// Workspace viewing adds its own headings and file/connection state labels in both languages.
// Any-folder viewing adds directory navigation, default/home/agent folder choices, directory errors and partial-list labels, and updates View files / Switch folder wording: new page digests.
test('both languages retain their original complete values', () => {
  assert.deepEqual({ en: digest(strings('en')), zh: digest(strings('zh')), roomEn: digest(ROOM_STRINGS.en), roomZh: digest(ROOM_STRINGS.zh) }, {
    en: '40ce764a3a22ab93b4e45c75f9d612718a329476310996e528ac0f93ed4d5883',
    zh: '3a9dee4e8bcfbac112414adbed08c26f7954b835a7f9ccd27233712435964498',
    roomEn: 'b22e42fa4a43f69d8a5b543517c93e4bbed3662f47dcb69dcf9288bb7b4daf22',
    roomZh: '44761f94b475101e1c74bb10eaa6773cf46da42b8bf4023cf7dab090f4bcc922',
  })
})
