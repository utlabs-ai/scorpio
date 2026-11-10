// The calendar subscription on the pages: the settings row with the address and the CalDAV account (settings-page.ts, settings.js) and the schedule switch and mark (room-schedules.js).
import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import { build } from 'esbuild'

const out = await build({ entryPoints: [new URL('../src/settings-page.ts', import.meta.url).pathname], bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent' })
const { settingsPage } = await import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`)
const staticFile = (name) => fs.readFileSync(new URL(`../../web/public/static/${name}`, import.meta.url), 'utf8')

async function page(lang) {
  const html = await settingsPage(lang, { handle: 'kai', email: 'kai@x.test' }, {
    drive: null, done: '', displayName: null, devices: [], providers: [], plan: 'pro', trialUntil: null, paid: null,
    limits: { activeRooms: null, msgsPerRoomDay: null, msgsPerAccountDay: null, devices: 5 }, space: { used: 0, limit: 1000 },
    activeRooms: 0, messagesToday: 0, visibleRooms: [], invite: null, handoffLocal: false, computers: { n: 0, limit: 5, free: 1, pro: 5 },
  })
  return html.text()
}

test('the settings row sits at the end of Notifications, closed, with the address field, both buttons, the explanation, the three CalDAV items with a copy each, and the reset, in both languages', async () => {
  for (const [lang, words] of [
    ['zh', ['日历订阅', '加到日历', '复制', '已复制', 'iPhone 和 Mac 点「加到日历」。Android 等其他日历：在手机日历里添加 CalDAV 帐号，填下面三项。Google 日历只能在电脑网页上加订阅地址，一天同步一两次，不响提醒。地址和密码泄露了就重置。', 'CalDAV 帐号', '>服务器<', '>账号<', '>密码<', '>重置<', '已重置，旧地址和旧密码已失效']],
    ['en', ['Calendar subscription', 'Add to calendar', 'Copy', 'Copied', 'On iPhone and Mac, tap Add to calendar. Android and other calendars: add a CalDAV account in your phone calendar with the three items below. Google Calendar adds the address only on the web, syncs once or twice a day and does not sound reminders. If the address or password leaks, reset.', 'CalDAV account', '>Server<', '>Account<', '>Password<', '>Reset<', 'Reset; the old address and password no longer work']],
  ]) {
    const html = await page(lang)
    const notifications = html.slice(html.indexOf('<section class="sec" id="notifications">'), html.indexOf('<section class="sec" id="spawn-perm">'))
    for (const w of words) assert.ok(notifications.includes(w), `${lang}: ${w}`)
    for (const gone of ['重置地址', 'Reset address', '地址等于密码', 'works like a password']) assert.ok(!notifications.includes(gone), `${lang}: ${gone} is gone`)
    assert.match(notifications, /<details class="name-setting" id="calendar-setting"><summary>/)
    assert.ok(!notifications.includes('<details class="name-setting" id="calendar-setting" open'))
    assert.ok(notifications.trimEnd().endsWith('</details></li></ul></section>'))
    assert.match(notifications, /<input id="calendar-url" readonly/)
    assert.match(notifications, /<a class="btn sm" id="calendar-add" href="#" aria-disabled="true">/)
    assert.match(notifications, /<button type="button" class="btn sm" id="calendar-copy" data-copy-of="calendar-url" data-done="[^"]+" disabled>/)
    // the explanation, then the sub-heading, then one line per item: label, read-only field, copy
    const order = ['<small class="muted">', '<b class="cal-sub">', 'for="caldav-server"', '<input id="caldav-server" readonly>', 'data-copy-of="caldav-server"', 'for="caldav-account"', '<input id="caldav-account" readonly>', 'data-copy-of="caldav-account"', 'for="caldav-password"', '<input id="caldav-password" readonly>', 'data-copy-of="caldav-password"', '<div class="cal-reset">']
    const positions = order.map((o) => notifications.indexOf(o))
    assert.ok(positions.every((p, i) => p >= 0 && (i === 0 || p > positions[i - 1])), `${lang}: ${JSON.stringify(positions)}`)
    assert.equal((notifications.match(/<div class="cal-link cal-item"><label for="caldav-\w+">[^<]+<\/label><input id="caldav-\w+" readonly><button type="button" class="btn sm" data-copy-of="caldav-\w+" data-done="[^"]+" disabled>[^<]+<\/button><\/div>/g) || []).length, 3)
    assert.match(notifications, /<button type="button" class="link" id="calendar-reset" data-done="[^"]+" disabled>/)
    assert.ok(!notifications.includes('/cal/') && !notifications.includes('kai<'), 'no address, account or password is in the page: they are fetched when the row opens')
  }
})

test('the settings script asks for the address and the CalDAV items only when the row opens, fills the four fields from the one answer, makes the webcal link, copies each with one handler, and resets', () => {
  const js = staticFile('settings.js')
  assert.match(js, /calendar\.addEventListener\('toggle'/)
  assert.match(js, /calPost\('\/settings\/calendar'\)\.then\(showCalendar/)
  assert.match(js, /calPost\('\/settings\/calendar\/reset'\)\.then\(function \(body\) \{ showCalendar\(body\); calResult\.textContent = calReset\.dataset\.done; \}/)
  assert.match(js, /body\.url\.replace\(\/\^https\?:\/, 'webcal:'\)/)
  assert.match(js, /\['server', 'account', 'password'\]\.forEach\(function \(k\) \{ document\.getElementById\('caldav-' \+ k\)\.value = body\.caldav\[k\]; \}\)/)
  assert.match(js, /calendar\.querySelectorAll\('button\[data-copy-of\]'\)/)
  assert.equal((js.match(/navigator\.clipboard\.writeText\(text\)/g) || []).length, 2, 'one copy handler for the invite link, one shared by the four calendar buttons')
  assert.ok(!/fetch\('\/settings\/calendar'/.test(js.split('toggle')[0]), 'nothing is fetched before the row is opened')
  const css = staticFile('page-integration.css')
  assert.match(css, /\.ui\.settings \.cal-item \{ flex-wrap: nowrap; \}/)
  assert.match(css, /@media \(max-width: 760px\) \{ \.ui\.settings \.cal-item \{ flex-wrap: wrap; \} \.ui\.settings \.cal-item label \{ flex: 1 0 100%; width: auto; \} \}/, 'the label sits above its field on a phone, so the server address is read in full')
})

test('the schedules panel: the form sends calendar with add and edit, its switch toggles the form, the detail switch edits, and the list marks it', () => {
  const js = staticFile('room-schedules.js')
  assert.match(js, /revive: true, calendar: false, nonce: crypto\.randomUUID\(\)/)
  assert.match(js, /f\.calendar = !!item\.calendar/)
  assert.match(js, /op: "add", text: input\.value, rule: rule, revive: form\.revive, calendar: form\.calendar, nonce: form\.nonce/)
  assert.match(js, /op: "edit", id: editItem\.id, text: input\.value, revive: form\.revive, calendar: form\.calendar/)
  assert.match(js, /data-sched-field="calendar"/)
  assert.match(js, /form\[field\] = field === "revive" \|\| field === "calendar" \? e\.target\.checked/)
  assert.match(js, /data-sched-calendar.*\(!item\.canEdit \|\| proRequired \|\| !ctx\.canWrite\(\) \? ' disabled' : ''\)/)
  assert.match(js, /hasAttribute\("data-sched-calendar"\)\) \{ api\(\{ op: "edit", id: detail\.id, calendar: e\.target\.checked \}\)/)
  assert.match(js, /item\.calendar \? '<i class="sched-mark">' \+ esc\(S\.calendarMark\) \+ '<\/i>' : ''/)
  assert.match(js, /esc\(S\.calendarHint\)/)
  const css = staticFile('room-schedules.css')
  assert.match(css, /\.sched-mark \{/)
  assert.match(css, /\.sched-calendar \{/)
})
