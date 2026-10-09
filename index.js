/**
 * Host half of browser use: browser_* agent tools that drive the Desktop right-sidebar browser.
 * Tool calls travel to the Client half through an authenticated long-poll channel, because only
 * the renderer that owns the Electron <webview> can operate it. Only `ctx` services are used.
 */
import { BrowserUseError, createBridge } from './src/bridge.js';

export const name = 'dsh-browser-use';
export const inject = ['connection', 'tools'];

const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;

const json = (value, status = 200) => new Response(JSON.stringify(value ?? null), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const int = (description) => ({ type: 'integer', description });
const bool = (description) => ({ type: 'boolean', description });
const REF = int('Element ref number from the latest browser_snapshot.');

const RESULT_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    text: { type: 'string' },
    image: {
      type: 'object', additionalProperties: false,
      properties: { attachmentId: { type: 'string' }, mediaType: { type: 'string' }, bytes: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, name: { type: 'string' } },
    },
  },
  required: ['text'],
};
const render = (_args, value) => [
  { type: 'text', text: value.text },
  ...(value.image ? [{ type: 'image', attachment: value.image }] : []),
];

/** Model-facing tools; `action` is what the Client executes, `timeout` its budget. */
const TOOLS = [
  {
    name: 'browser_navigate', action: 'navigate', timeout: 45_000,
    description: 'Operate the built-in browser in the DSH right sidebar (the user sees every step). Open a URL, or go back / forward / reload. Opens a browser tab in the sidebar when none is open. Waits for the page to load and returns its URL and title; call browser_snapshot next to see what is on the page.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        url: str('HTTP(S) URL to open. A bare host name becomes https://.'),
        action: { type: 'string', enum: ['go', 'back', 'forward', 'reload'], description: 'Default go (needs url).' },
      },
    },
  },
  {
    name: 'browser_snapshot', action: 'snapshot', timeout: 20_000,
    description: 'Read the page in the sidebar browser (browser-use style DOM serialization): URL, title, scroll position, then the page in DOM order — visible text lines interleaved with interactive elements as `[ref]<tag attrs>label />`. Same-origin iframes and open shadow DOM are included; indentation shows elements nested inside other elements or iframes. `*[ref]` marks an element that appeared since the previous snapshot; a trailing ↑ ↓ ← → means outside the viewport in that direction, ↕ means clipped or scrolled out inside an inner container. Elements covered by something else (e.g. behind a modal) are left out and counted. Use the ref with browser_click / browser_type / browser_select / browser_scroll. Refs change after navigation or big page updates, so snapshot again when an action reports a stale ref.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        include_text: bool('Interleave the visible page text (default true).'),
        max_chars: int('Most characters of page text (default 6000, max 40000); interactive elements are always listed.'),
        viewport_only: bool('Only list elements inside the current viewport (default false).'),
      },
    },
  },
  {
    name: 'browser_screenshot', action: 'screenshot', timeout: 30_000,
    description: 'Take a screenshot of the visible part of the page in the sidebar browser and return it as an image. Use it when layout, images or canvas content matter; browser_snapshot is cheaper for text and controls. With annotate, every interactive element in the viewport gets a numbered box (like browser-use), and the numbers are the refs for browser_click etc.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        annotate: bool('Draw numbered boxes on the interactive elements in the viewport. This takes a fresh viewport snapshot, so the numbers are the current refs; the ref list is returned with the image.'),
      },
    },
  },
  {
    name: 'browser_click', action: 'click', timeout: 30_000,
    description: 'Click an element in the sidebar browser with a real mouse event: by ref from browser_snapshot, or at viewport coordinates x/y (CSS pixels, e.g. read off browser_screenshot). Works inside same-origin iframes and shadow DOM. A ref covered by another element (a modal, a banner) is not clicked: the error names the cover, and force clicks it with a script instead. Reports the element hit. When the Session is in the background and real input does not reach the page, synthetic DOM events are dispatched instead and the result says so. Waits briefly for any navigation it causes.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        ref: REF, x: { type: 'number', description: 'Viewport X.' }, y: { type: 'number', description: 'Viewport Y.' }, double: bool('Double-click.'), button: { type: 'string', enum: ['left', 'right', 'middle'] },
        force: bool('With ref: when the element is covered by another element, click it with a script instead of reporting the cover.'),
      },
    },
  },
  {
    name: 'browser_type', action: 'type', timeout: 30_000,
    description: 'Type text into an input, textarea or contenteditable in the sidebar browser (real keyboard input). Focuses the ref first; without ref types into the focused element. Replaces existing content unless clear is false. Set submit to press Enter afterwards.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { ref: REF, text: str('Text to type.'), clear: bool('Clear the field first (default true).'), submit: bool('Press Enter after typing.') },
      required: ['text'],
    },
  },
  {
    name: 'browser_press', action: 'press', timeout: 20_000,
    description: 'Press a key in the sidebar browser, e.g. Enter, Tab, Escape, Backspace, ArrowDown, PageDown, or a character, with optional modifiers. Falls back to synthetic key events on the focused element (and says so) when real input does not reach a background Session.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        key: str('Key name (Enter, Tab, Escape, Backspace, Delete, ArrowUp/Down/Left/Right, Home, End, PageUp, PageDown, Space) or one character.'),
        modifiers: { type: 'array', items: { type: 'string', enum: ['shift', 'control', 'alt', 'meta'] }, description: 'Modifier keys held down.' },
      },
      required: ['key'],
    },
  },
  {
    name: 'browser_scroll', action: 'scroll', timeout: 15_000,
    description: 'Scroll the page in the sidebar browser: bring a ref into view, or scroll by pixels (default one screen down). Negative dy scrolls up.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { ref: REF, dy: { type: 'number', description: 'Vertical pixels (default ≈ one viewport).' }, dx: { type: 'number', description: 'Horizontal pixels.' } },
    },
  },
  {
    name: 'browser_select', action: 'select', timeout: 15_000,
    description: 'Choose an option of a <select> element in the sidebar browser, by option value or visible label.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { ref: REF, value: str('Option value or label.') },
      required: ['ref', 'value'],
    },
  },
  {
    name: 'browser_wait', action: 'wait', timeout: 65_000,
    description: 'Wait in the sidebar browser until some text appears on the page, or for a number of milliseconds. Returns the URL and title when done.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { text: str('Text to wait for.'), ms: int('Milliseconds to wait (max 60000).'), timeout: int('Max milliseconds to wait for text (default 15000, max 60000).') },
    },
  },
  {
    name: 'browser_eval', action: 'eval', timeout: 30_000,
    description: 'Run a JavaScript expression or snippet in the page of the sidebar browser and return its JSON-serializable result (promises are awaited). Use for reading data the snapshot does not show; prefer click/type for interaction.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: { script: str('JavaScript; top-level await is allowed. The value of the last expression statement is returned, also after other statements; an explicit `return` works too. The script runs exactly once.') },
      required: ['script'],
    },
  },
];

export function apply(ctx) {
  const attachments = ctx.get('attachments');
  const bridge = createBridge();
  ctx.effect(() => () => bridge.dispose(), 'dsh-browser-use: bridge');

  // Claim the shared browser-use provider slot when this DSH build offers one; the tools work either way.
  const slot = ctx.get('browserUse');
  if (slot !== undefined) {
    try { ctx.effect(() => slot.register('dsh-browser-use'), 'dsh-browser-use: provider'); }
    catch (error) { ctx.logger?.warn?.('dsh-browser-use: another browser-use provider is registered', error); }
  }

  async function saveScreenshot(image) {
    if (attachments === undefined) throw new BrowserUseError('DSH 附件服务不可用，无法返回截图', 503);
    const data = Buffer.from(String(image.data ?? ''), 'base64');
    if (data.length === 0 || data.length > MAX_SCREENSHOT_BYTES) throw new BrowserUseError('截图为空或过大');
    const mediaType = image.mediaType === 'image/png' ? 'image/png' : 'image/jpeg';
    const ref = await attachments.saveImage({ data: new Uint8Array(data), mediaType, name: `browser-${Date.now()}.${mediaType === 'image/png' ? 'png' : 'jpg'}` });
    return { attachmentId: String(ref.attachmentId), mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height, name: 'screenshot' };
  }

  for (const tool of TOOLS) {
    ctx.effect(() => ctx.tools.register({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      timeoutMs: tool.timeout + 5_000,
      output: { schema: RESULT_SCHEMA, render },
      async execute(args, exec) {
        const value = await bridge.request(
          { action: tool.action, args: args ?? {}, sessionId: exec.agent?.id === undefined ? undefined : String(exec.agent.id) },
          { timeoutMs: tool.timeout, signal: exec.signal },
        );
        const text = typeof value?.text === 'string' ? value.text : JSON.stringify(value ?? null);
        return value?.image ? { text, image: await saveScreenshot(value.image) } : { text };
      },
    }), 'dsh-browser-use: ' + tool.name);
  }

  const routes = {
    '/api/browser-use/poll': {
      methods: ['GET'],
      fetch: async (request) => {
        const command = await bridge.poll(request.signal);
        return command === undefined ? new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } }) : json(command);
      },
    },
    '/api/browser-use/result': {
      methods: ['POST'],
      fetch: async (request) => {
        let input;
        try { input = await request.json(); } catch { return json({ error: '请求体不是有效的 JSON' }, 400); }
        if (typeof input?.id !== 'string') return json({ error: '缺少 id' }, 400);
        const accepted = bridge.answer(input.id, input.ok === true ? { ok: true, value: input.value } : { ok: false, error: String(input.error ?? '浏览器操作失败') });
        return json({ accepted });
      },
    },
  };
  for (const [path, route] of Object.entries(routes)) {
    ctx.effect(() => ctx.connection.fetch.register({
      path, methods: route.methods, requestBody: 'buffered',
      fetch: async (request) => {
        try { return await route.fetch(request); } catch (error) { return json({ error: error?.message ?? String(error) }, error?.status ?? 500); }
      },
    }), 'dsh-browser-use: ' + path);
  }
}
