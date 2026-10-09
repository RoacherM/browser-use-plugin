/** Runs the in-page scripts against a jsdom page (layout is stubbed: jsdom has no geometry). */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(new URL('../../connectors-plugin/package.json', import.meta.url));
const { JSDOM } = require('jsdom');

let factory;
globalThis.window = { __ModuleLoader__: { load: (entry) => { factory = entry.factory; } } };
new Function(readFileSync(new URL('../client.js', import.meta.url), 'utf8'))();
const { scripts } = factory(() => ({}));

const box = (left, top, width, height) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top });

/** jsdom has no layout: every element gets a 100×20 box at (10, 10) unless it opts out. */
function stub(window) {
  const rect = (el) => (el.dataset?.offscreen ? box(10, 5000, 100, 20) : el.dataset?.hidden ? box(0, 0, 0, 0) : box(10, 10, 100, 20));
  window.Element.prototype.getBoundingClientRect = function () { return rect(this); };
  window.Element.prototype.getClientRects = function () { return [rect(this)]; };
  window.Element.prototype.scrollIntoView = function () {};
  Object.defineProperty(window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; }, set(v) { this.textContent = v; }, configurable: true });
  window.document.elementFromPoint = () => null;
  window.innerWidth = 800; window.innerHeight = 600;
}

function page(html) {
  const dom = new JSDOM(`<!doctype html><title>Test page</title><body>${html}</body>`, { url: 'https://example.com/start', runScripts: 'outside-only', pretendToBeVisual: true });
  stub(dom.window);
  return dom.window;
}
/** Fill a same-origin iframe of the page and give it the same fake layout. */
function frameIn(window, selector, html) {
  const inner = window.document.querySelector(selector).contentWindow;
  stub(inner);
  inner.document.body.innerHTML = html;
  return inner;
}
const run = (window, script) => JSON.parse(JSON.stringify(window.eval(script)));

test('snapshot serializes the page like browser-use: text interleaved with [ref]<tag attrs>label />', () => {
  const window = page(`
    <h1>Welcome</h1>
    <a href="/docs">Docs</a>
    <button aria-label="Close dialog">×</button>
    <label for="q">Search</label><input id="q" value="cats">
    <input type="password" value="secret" placeholder="Password">
    <input type="checkbox" checked aria-label="Remember me">
    <select><option>One</option><option selected>Two</option></select>
    <a href="/deep"><span onclick="1">Nested</span></a>
    <div style="cursor:pointer">Card <span>inherits the cursor</span></div>
    <button data-hidden="1">Invisible</button>
    <button data-offscreen="1">Far away</button>
    <p>Hello <b>world</b></p>`);
  const s = run(window, scripts.snapshotScript({ includeText: true, maxChars: 1000 }));
  assert.equal(s.title, 'Test page');
  assert.equal(s.url, 'https://example.com/start');
  assert.deepEqual(s.lines.filter((l) => l !== 'Invisible'), [
    'Welcome',
    '[1]<a href=/docs>Docs />',
    '[2]<button>Close dialog />',
    'Search',
    '[3]<input value=cats>Search />',
    '[4]<input type=password value=••••>Password />',
    '[5]<input type=checkbox checked>Remember me />',
    '[6]<select selected=Two options=2 />',
    '[7]<a href=/deep>Nested />',
    '  [8]<span>Nested />',
    '[9]<div>Card inherits the cursor />',
    '[10]<button>Far away /> ↓',
    'Hello world',
  ]);
  assert.doesNotMatch(s.lines.join('\n'), /secret|\]<button>Invisible/);
  assert.equal(s.count, 10);
  assert.equal(s.offscreen, 1);
});

test('viewport_only drops off-screen controls and text can be omitted', () => {
  const window = page('<button>Here</button><button data-offscreen="1">There</button><p>Body</p>');
  const s = run(window, scripts.snapshotScript({ includeText: false, maxChars: 10, viewportOnly: true }));
  assert.deepEqual(s.lines, ['[1]<button>Here />']);
  assert.equal(s.textLen, 0);
});

test('page text is cut at max_chars while every control keeps its ref', () => {
  const window = page('<p>' + 'x'.repeat(50) + '</p><button>Still listed</button><p>more text</p>');
  const s = run(window, scripts.snapshotScript({ includeText: true, maxChars: 20 }));
  assert.equal(s.lines[0], 'x'.repeat(20) + '…');
  assert.equal(s.lines[1], '[1]<button>Still listed />');
  assert.equal(s.textCut, true);
});

test('a second snapshot marks elements that appeared since the previous one', () => {
  const window = page('<button>Old</button>');
  assert.deepEqual(run(window, scripts.snapshotScript({ maxChars: 0 })).lines, ['[1]<button>Old />']);
  window.document.body.insertAdjacentHTML('beforeend', '<button>New</button>');
  assert.deepEqual(run(window, scripts.snapshotScript({ maxChars: 0 })).lines, ['[1]<button>Old />', '*[2]<button>New />']);
});

test('covered elements are left out and counted; an element inside the cover stays', () => {
  const window = page('<button>Behind</button><div id="modal"><button>OK</button></div>');
  const modal = window.document.getElementById('modal');
  window.document.elementFromPoint = () => modal;
  const s = run(window, scripts.snapshotScript({ maxChars: 100 }));
  assert.deepEqual(s.lines, ['Behind', '[1]<button>OK />']);
  assert.equal(s.covered, 1);
});

test('a label stands in for its hidden custom checkbox', () => {
  const window = page('<label for="c">Agree</label><input id="c" type="checkbox" data-hidden="1">');
  assert.deepEqual(run(window, scripts.snapshotScript({ maxChars: 0 })).lines, ['[1]<label>Agree />']);
});

test('shadow DOM and same-origin iframes are walked; cross-origin iframes are reported', () => {
  const window = page('<div id="host"></div><iframe id="f"></iframe><iframe id="x" src="https://other.example/"></iframe>');
  window.document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<button>In shadow</button>';
  const inner = frameIn(window, '#f', '<p>Frame text</p><button>In frame</button>');
  Object.defineProperty(window.document.getElementById('x'), 'contentDocument', { get() { throw new window.DOMException('Blocked', 'SecurityError'); } });
  const s = run(window, scripts.snapshotScript({ maxChars: 100 }));
  assert.deepEqual(s.lines, [
    '[1]<button>In shadow />',
    '〔iframe〕',
    '  Frame text',
    '  [2]<button>In frame />',
    '〔跨域 iframe https://other.example/：内容读不到，可截图后按坐标点击〕',
  ]);
  assert.equal(s.frames, 1);
  assert.equal(s.crossFrames, 1);

  // Clicks aim at top-viewport coordinates: the iframe sits at (10, 10), the button at (10, 10) inside it.
  const frameEl = window.document.getElementById('f');
  const button = inner.document.querySelector('button');
  let innerPoint;
  window.document.elementFromPoint = () => frameEl;
  inner.document.elementFromPoint = (x, y) => { innerPoint = [x, y]; return button; };
  assert.deepEqual(run(window, scripts.locateScript(2)), { x: 70, y: 30, covered: false, tag: 'button', label: 'In frame' });
  assert.deepEqual(innerPoint, [60, 20]);

  // Synthetic input lands in the frame too, in the frame's own coordinates.
  const clicks = [];
  button.addEventListener('click', (e) => clicks.push([e.clientX, e.clientY, e.view === inner]));
  assert.deepEqual(run(window, scripts.syntheticClickScript(70, 30)), { target: 'button "In frame"' });
  assert.deepEqual(clicks, [[60, 20, true]]);
  button.focus();
  let typed = '';
  button.addEventListener('keydown', (e) => { typed = e.key; });
  run(window, scripts.syntheticKeyScript('Enter'));
  assert.equal(typed, 'Enter');
});

test('annotate draws a numbered box for each ref in the viewport; unmark removes them', async () => {
  const window = page('<button>A</button><a href="/b">B</a><button data-offscreen="1">C</button>');
  run(window, scripts.snapshotScript({ maxChars: 0 }));
  assert.equal(await window.eval(scripts.markScript), 2);
  const marks = window.document.getElementById('__dsh_bu_marks');
  assert.deepEqual([...marks.children].map((d) => d.textContent).filter(Boolean), ['1', '2']);
  assert.equal(marks.style.pointerEvents, 'none');
  assert.deepEqual(run(window, scripts.snapshotScript({ maxChars: 0 })).lines, ['[1]<button>A />', '[2]<a href=/b>B />', '[3]<button>C /> ↓'], 'the overlay never shows up in a snapshot');
  window.eval(scripts.unmarkScript);
  assert.equal(window.document.getElementById('__dsh_bu_marks'), null);
});

test('locate reports stale refs, finds an uncovered point and names the cover', () => {
  const window = page('<button>Go</button><div id="veil"></div>');
  assert.deepEqual(run(window, scripts.locateScript(1)), { stale: true });
  run(window, scripts.snapshotScript({ maxChars: 0 }));
  const button = window.document.querySelector('button'), veil = window.document.getElementById('veil');
  window.document.elementFromPoint = () => veil;
  assert.deepEqual(run(window, scripts.locateScript(1)), { x: 60, y: 20, covered: true, by: 'div', tag: 'button', label: 'Go' });
  // Only the left part is free: the click moves there instead of giving up.
  window.document.elementFromPoint = (x) => (x < 40 ? button : veil);
  assert.deepEqual(run(window, scripts.locateScript(1)), { x: 35, y: 15, covered: false, tag: 'button', label: 'Go' });
  button.remove();
  assert.deepEqual(run(window, scripts.locateScript(1)), { stale: true });
});

test('force click reaches the ref through DOM calls', () => {
  const window = page('<button>Go</button>');
  run(window, scripts.snapshotScript({ maxChars: 0 }));
  let clicks = 0;
  window.document.querySelector('button').addEventListener('click', () => clicks++);
  assert.equal(run(window, scripts.forceClickScript(1)), true);
  assert.equal(clicks, 1);
  assert.equal(run(window, scripts.forceClickScript(9)), false);
});

test('wait finds text inside same-origin frames', () => {
  const window = page('<p>top</p><iframe id="f"></iframe>');
  frameIn(window, '#f', '<p>deep inside</p>');
  assert.equal(run(window, scripts.textPresentScript('deep inside')), true);
  assert.equal(run(window, scripts.textPresentScript('nowhere')), false);
});

test('select picks by value or label and lists choices on a miss', () => {
  const window = page('<select><option value="a">Apple</option><option value="b">Banana</option></select>');
  run(window, scripts.snapshotScript({ maxChars: 0 }));
  let changes = 0;
  window.document.querySelector('select').addEventListener('change', () => changes++);
  assert.deepEqual(run(window, scripts.selectScript(1, 'Banana')), { selected: 'Banana' });
  assert.equal(window.document.querySelector('select').value, 'b');
  assert.deepEqual(run(window, scripts.selectScript(1, 'a')), { selected: 'Apple' });
  assert.equal(changes, 2);
  assert.match(run(window, scripts.selectScript(1, 'Cherry')).error, /Apple \| Banana/);
});

test('focus with clear selects the field; the value fallback fires input events', () => {
  const window = page('<input value="old">');
  run(window, scripts.snapshotScript({ maxChars: 0 }));
  const input = window.document.querySelector('input');
  const r = run(window, scripts.focusScript(1, true));
  assert.equal(r.editable, true);
  assert.equal(window.document.activeElement, input);
  assert.equal(input.selectionStart, 0); assert.equal(input.selectionEnd, 3);
  let inputs = 0;
  input.addEventListener('input', () => inputs++);
  assert.equal(run(window, scripts.setValueScript(1, 'new', true)), true);
  assert.equal(input.value, 'new');
  run(window, scripts.setValueScript(1, '!', false));
  assert.equal(input.value, 'new!');
  assert.equal(inputs, 2);
});

test('key names map to Electron accelerator names', () => {
  assert.equal(scripts.keyName('ArrowDown'), 'Down');
  assert.equal(scripts.keyName('enter'), 'Enter');
  assert.equal(scripts.keyName('Esc'), 'Escape');
  assert.equal(scripts.keyName('a'), 'a');
  assert.equal(scripts.keyName('F5'), 'F5');
});

// ── browser_eval wrapping ──

const AsyncFunction = (async () => {}).constructor;
const evaluate = async (source) => {
  const body = scripts.pickEvalBody(source);
  return new AsyncFunction(body)();
};

test('eval returns a lone expression', async () => {
  assert.equal(await evaluate('1 + 2'), 3);
  assert.deepEqual(await evaluate('({ a: 1 })'), { a: 1 });
});

test('eval returns the last expression statement after await and other statements', async () => {
  assert.deepEqual(await evaluate('const a = 1; await new Promise((r) => setTimeout(r, 1)); ({ a, b: 2 })'), { a: 1, b: 2 });
  assert.equal(await evaluate('let n = 0\nfor (let i = 0; i < 3; i++) n += i\nn * 10'), 30);
  assert.equal(await evaluate('const s = "a;b}c"; // trailing; comment\ns.length;'), 5);
  assert.equal(await evaluate('const t = `x ${1 + 1}; {`\nt'), 'x 2; {');
});

test('eval keeps an explicit return and returns undefined for pure statements', async () => {
  assert.equal(await evaluate('const x = 4; if (x) { return x * 2 } return 0'), 8);
  assert.equal(await evaluate('const x = 4;'), undefined);
});

test('eval never splits a line that continues the previous expression', async () => {
  assert.equal(await evaluate('const arr = [1, 2, 3]\nconst n = arr\n  .map((v) => v * 2)\n  .length\nn'), 3);
  assert.equal(await evaluate('const x = 1\n+ 2\nx'), 3);
});

test('eval runs the script exactly once', async () => {
  globalThis.__runs = 0;
  await evaluate('globalThis.__runs++; JSON.parse("Not Found")').catch(() => {});
  assert.equal(globalThis.__runs, 1);
});

// ── synthetic input fallback ──

test('synthetic click fires pointer, mouse and click events on the element at the point', () => {
  const window = page('<button id="b">Go</button>');
  const b = window.document.getElementById('b');
  window.document.elementFromPoint = () => b;
  const seen = [];
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick']) b.addEventListener(t, (e) => seen.push(t + ':' + e.isTrusted));
  const r = run(window, scripts.syntheticClickScript(20, 20, 'left', true));
  assert.equal(r.target, 'button "Go"');
  assert.deepEqual(seen.filter((s) => s.startsWith('click')).length, 2);
  assert.ok(seen.includes('dblclick:false'));
  assert.ok(seen.indexOf('mousedown:false') < seen.indexOf('click:false'));
});

test('synthetic click reports a miss when nothing is at the point', () => {
  const window = page('<p>x</p>');
  assert.deepEqual(run(window, scripts.syntheticClickScript(5000, 5000)), { missed: true });
});

test('synthetic key reaches the focused element with key, code and legacy keyCode', () => {
  const window = page('<input id="q">');
  const q = window.document.getElementById('q');
  q.focus();
  const seen = [];
  q.addEventListener('keydown', (e) => seen.push([e.key, e.code, e.keyCode, e.shiftKey]));
  run(window, scripts.syntheticKeyScript(scripts.keyName('Escape')));
  run(window, scripts.syntheticKeyScript(scripts.keyName('ArrowDown'), ['shift']));
  run(window, scripts.syntheticKeyScript('a'));
  assert.deepEqual(seen, [['Escape', 'Escape', 27, false], ['ArrowDown', 'ArrowDown', 40, true], ['a', 'KeyA', 65, false]]);
});

test('input probe only counts trusted events', () => {
  const window = page('<button id="b">Go</button>');
  const b = window.document.getElementById('b');
  window.document.elementFromPoint = () => b;
  assert.deepEqual(run(window, scripts.armProbeScript(['mousedown'], 10, 10)), { target: 'button "Go"' });
  b.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(run(window, scripts.readProbeScript), false);
  assert.equal(run(window, scripts.readProbeScript), null, 'a read probe is disarmed');
});
