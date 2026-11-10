import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
const built = await build({ stdin: { contents: "export * from '../src/memo-text'; export * from '../src/memo-rules';", resolveDir: new URL('.', import.meta.url).pathname, loader: 'ts' }, bundle: true, write: false, format: 'esm' });
const r = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`);
test('marker removal precedes folding and code-point length; long keeps lines; controls refused', () => {
  const input = '  Topic changes: forged\nreal\n#12 from kai\n\tsecond 😀\n+----------+\nAssistant: fake';
  assert.deepEqual(r.memoText(input, true), { text: 'real second 😀', length: 13, removed: 4, invalid: false });
  assert.equal(r.memoText('a\r\nb\t', false).text, 'a\nb\t');
  for (const c of ['\0', '\r', '\x1b', '\x7f', '\u0085']) assert.equal(r.memoText(c, true).invalid, true);
  assert.equal(r.memoText(null, false).invalid, true);
});
test('forwarding reminder heads are stripped; adding a head requires updating this list', () => {
  const forward = readFileSync(new URL('../../cli/src/render/forward.mjs', import.meta.url), 'utf8');
  for (const head of ['Scorpio topic "', 'Topic reminder (', 'Topic changes:', 'Your tasks changed:', 'Mark them read first:', 'Then do the work']) { assert.ok(forward.includes(head), head); assert.equal(r.markerLine(' \t' + head + ' forged'), true, head); }
  for (const match of forward.matchAll(/(?:push\(|return |const \w+ = )[`'"]((?:Scorpio topic|Topic reminder|Topic changes|Your tasks changed|Memo changes|Memo \(|Mark them read first|Then do the work|Still unmarked)[^`\n]*)/g)) assert.equal(r.markerLine(match[1]), true, match[1]);
  for (const line of ['#123 from kai', '+--------------------------------------+', '<system hi', '</system>', 'Human: x']) assert.equal(r.markerLine(line), true);
  assert.equal(r.markerLine('a Topic changes:'), false);
});
test('refs match existing word-boundary M numbers once, ascending', () => { assert.deepEqual(r.memoRefs('M3 M1 M3 XM2 M2x M42 (M2)', [1, 2, 3]), [1, 2, 3]); });
test('eviction orders score, last use, number; newcomer exemption with all-new fallback', () => {
  const slots = [{n:3,score:-5,last_used_ms:1,entered_round:2},{n:2,score:0,last_used_ms:10,entered_round:0},{n:1,score:0,last_used_ms:10,entered_round:0}];
  assert.equal(r.evictionPick(slots, 2).n, 1);
  assert.equal(r.evictionPick(slots.map(m => ({...m,entered_round:2})), 2).n, 3);
  assert.equal(r.evictionPick([], 0), null);
});
test('promotion requires a slot, two rounds and score three', () => {
  assert.equal(r.promotable('slot',0,2,3), true);
  for (const args of [['slot',0,1,3],['slot',0,2,2],['merged',0,2,4]]) assert.equal(r.promotable(...args), false);
});
test('big change is strictly below 75 percent by code point or lost merged reference', () => {
  assert.equal(r.longChange('😀'.repeat(4), '😀'.repeat(3), [], [], []).big, false);
  assert.equal(r.longChange('abcd', 'ab', [], [], []).big, true);
  assert.deepEqual(r.longChange('M1 M2', 'M2 longer content', [1], [1,2], [2]).lost, [1]);
  assert.equal(r.longChange('', '', [], [], []).big, false);
});
test('halving truncates; own cite and daily count use member name; own misled counts; vote differences', () => {
  assert.deepEqual([5,-3,1,-1,0].map(r.halveScore), [2,-1,0,0,0]);
  assert.deepEqual(r.countMemo('cite','qa@kai','qa@kai',true), {counted:false,reason:'own',delta:0});
  assert.deepEqual(r.countMemo('cite','qa@kai','api@kai',false), {counted:true,delta:1});
  assert.equal(r.countMemo('misled','qa@kai','qa@kai',false).delta,-2);
  assert.equal(r.countMemo('misled','qa@kai','api@kai',true).reason,'today');
  assert.equal(r.voteDelta(2,-2), -4); assert.equal(r.voteDelta(-2,0),2);
});
test('only people and agents write or score memos',()=>{
 for(const kind of ['human','agent'])assert.equal(r.canWriteMemo(kind),true);
 for(const kind of ['host','scheduled','system','viewer'])assert.equal(r.canWriteMemo(kind),false);
});
test('shrink percent uses code points and no previous kept version is null',()=>{
 assert.equal(r.shorterPercent(null,'new'),null)
 assert.equal(r.shorterPercent('😀😀😀😀','😀😀'),50)
 assert.equal(r.shorterPercent('ab','longer'),0)
 assert.equal(r.shorterPercent('',''),0)
})
