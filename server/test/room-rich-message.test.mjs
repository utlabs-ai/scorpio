import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
const built = await build({ entryPoints: [new URL('../src/room-rich-message.ts', import.meta.url).pathname], bundle: true, format: 'esm', write: false })
const { labelWidth, validButtons, richMessage, pressDecision } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`)

test('button width follows East Asian W/F per code point', () => {
  for (const [text, width] of [['English', 7], ['中文', 4], ['Ａ！', 4], ['😀', 2], ['a中😀', 5], ['éΩ', 2], ['ｶ', 1], ['e\u0301', 2]]) assert.equal(labelWidth(text), width, text)
})
test('buttons are distinct single lines of 1 to 24 columns', () => {
  for (const labels of [['汉'.repeat(12)], ['a'.repeat(24)], [' ' + 'a'.repeat(24) + ' '], ['😀'.repeat(12)], ['a中', 'b', 'c', 'd']]) assert.equal(validButtons(labels), true)
  for (const labels of [[], [''], ['   '], ['yes', ' yes '], ['汉'.repeat(13)], ['a'.repeat(25)], ['same', 'same'], ['a\nb'], ['a\u0085b'], ['a\u2028b'], ['a\tb'], ['a', 'b', 'c', 'd', 'e'], [1], 'a', null]) assert.equal(validButtons(labels), false, JSON.stringify(labels))
})
test('rich inputs validate kind, UTF-8 bytes and summary code points', () => {
  assert.equal(richMessage('human', ['OK']).error.code, 'bad_request')
  assert.equal(richMessage('scheduled', undefined, { kind: 'html', summary: 's', html: '' }).error.code, 'bad_request')
  assert.equal(richMessage('agent', []).error.code, 'bad_buttons')
  const card = { kind: 'html', summary: '😀'.repeat(300), html: '中'.repeat(87381) }
  assert.equal(richMessage('agent', ['OK'], card).card.size, 262143)
  assert.equal(richMessage('agent', undefined, { ...card, html: card.html + '中' }).error.code, 'card_too_large')
  for (const summary of ['', ' ', 'x\ny', '😀'.repeat(301), null]) assert.equal(richMessage('agent', undefined, { ...card, summary }).error.code, 'card_summary_required')
  for (const value of [null, {}, { kind: 'svg', html: '', summary: 's' }, { kind: 'html', html: 1, summary: 's' }]) assert.equal(richMessage('agent', undefined, value).error.code, 'bad_request')
  assert.deepEqual(richMessage('human'), { buttons: undefined, card: undefined })
})
test('press decision suppresses repeats and moves a person without mutating input', () => {
  const buttons = [{ label: 'A', by: ['kai', 'lee'] }, { label: 'B', by: ['zed'] }]
  assert.deepEqual(pressDecision(buttons, 0, 'kai', 'bot@kai'), { send: false, unchanged: true, moveFrom: 0 })
  const result = pressDecision(buttons, 1, 'kai', 'bot@kai')
  assert.equal(result.send, true)
  assert.equal(result.text, '@bot@kai B') // to the agent that asked, as the page's reply menu writes it (docs/api/messages.md)
  assert.equal(result.moveFrom, 0)
  assert.deepEqual(result.buttons, [{ label: 'A', by: ['lee'] }, { label: 'B', by: ['zed', 'kai'] }])
  assert.deepEqual(buttons[0].by, ['kai', 'lee'])
  for (const index of [-1, 0.5, 2, NaN]) assert.equal(pressDecision(buttons, index, 'kai', 'bot@kai').error.code, 'bad_request')
  assert.equal(pressDecision(null, 0, 'kai', 'bot@kai').error.code, 'bad_request')
})

test('stored button labels are trimmed before measuring and deduplicating', () => {
  assert.deepEqual(richMessage('agent', [' Yes ', ' No']).buttons, [{ label: 'Yes', by: [] }, { label: 'No', by: [] }])
})

test('card summary next describes search and readers without claiming push carries a body', () => {
  const card = {kind:'html',html:'',summary:''};
  const en = richMessage('agent',undefined,card,'en').error.next;
  const zh = richMessage('agent',undefined,card,'zh').error.next;
  assert.ok(en.includes('Search and anyone')); assert.ok(zh.includes('搜索和看不到图的人'));
  assert.doesNotMatch(en,/push/i); assert.doesNotMatch(zh,/推送/);
});
