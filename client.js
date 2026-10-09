window.__ModuleLoader__.load({
  id: '@local/dsh-browser-use',
  factory() {
    const PKG = '@local/dsh-browser-use';
    const FRAME_SELECTOR = 'webview[data-sidebar-browser-frame="webview"]';
    const SHOT_MAX_WIDTH = 1600;

    const sleep = (ms, signal) => new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
    });
    const endpoint = (path) => new URL('api/browser-use/' + path, document.baseURI);
    const clip = (text, max) => (text.length > max ? text.slice(0, max) + `…（已截断，共 ${text.length} 字）` : text);

    // ── Scripts evaluated inside the visited page. They share one registry of snapshot refs (window.__dshBU). ──
    // The DOM walk and the numbered screenshot overlay follow browser-use's in-page DOM tree script
    // (browser_use/dom/dom_tree/index.js, v0.5.11, MIT © 2024 Gregor Zunic): same-origin iframes and open shadow
    // roots are walked, interactive elements are detected by tag, role, cursor and handlers, nested elements get
    // their own ref only when they are a distinct interaction, covered elements are left out, and the listing
    // interleaves visible text with `[ref]<tag attrs>label />` lines.

    const describeFn = `(el) => { if (!el) return ''; const tag = el.tagName.toLowerCase(); const label = String(el.getAttribute('aria-label') || el.getAttribute('title') || el.alt || (typeof el.value === 'string' ? el.value : '') || el.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40); return label ? tag + ' "' + label + '"' : tag; }`;

    /** Helpers every page script starts with. Coordinates handed to Electron are top-viewport CSS pixels. */
    const PAGE_LIB = `
      const __describe = ${describeFn};
      const __styleOf = (el) => el.ownerDocument.defaultView.getComputedStyle(el);
      const __frameOf = (doc) => { try { return doc.defaultView?.frameElement ?? null; } catch { return null; } };
      const __docOf = (frame) => { try { return frame.contentDocument ?? null; } catch { return null; } };
      /** Where a frame's content box starts inside its parent's viewport. */
      const __inset = (frame) => { const r = frame.getBoundingClientRect(), cs = __styleOf(frame); return { x: r.left + (frame.clientLeft || 0) + (parseFloat(cs.paddingLeft) || 0), y: r.top + (frame.clientTop || 0) + (parseFloat(cs.paddingTop) || 0) }; };
      /** Offset of a same-origin document's viewport inside the top viewport. */
      const __offset = (doc) => { let x = 0, y = 0; for (let f = __frameOf(doc); f; f = __frameOf(f.ownerDocument)) { const i = __inset(f); x += i.x; y += i.y; } return { x, y }; };
      /** The element at a point of one document, descending into open shadow roots. */
      const __pointIn = (doc, x, y) => { let el = doc.elementFromPoint(x, y); while (el?.shadowRoot && typeof el.shadowRoot.elementFromPoint === 'function') { const inner = el.shadowRoot.elementFromPoint(x, y); if (!inner || inner === el) break; el = inner; } return el; };
      /** The element at a top-viewport point, through same-origin frames; x/y come back in that element's own viewport. */
      const __hit = (x, y) => { let doc = document, el = null; for (let i = 0; i < 16; i++) { el = __pointIn(doc, x, y); const inner = el && /^I?FRAME$/.test(el.tagName) ? __docOf(el) : null; if (!inner) break; const o = __inset(el); x -= o.x; y -= o.y; doc = inner; } return { el, x, y }; };
      /** node is ancestor or self, across shadow boundaries. */
      const __within = (node, ancestor) => { for (let n = node; n; n = n.parentNode ?? n.host) if (n === ancestor) return true; return false; };
      /** Whether a real click on hit reaches el. */
      const __reaches = (hit, el) => !!hit && (__within(hit, el) || (__within(el, hit) && !/^(BODY|HTML)$/.test(hit.tagName)) || hit.closest?.('label')?.control === el);
      /** The focused element, inside shadow roots and same-origin frames. */
      const __active = () => { let el = document.activeElement; for (let i = 0; el && i < 16; i++) { const next = el.shadowRoot?.activeElement ?? (/^I?FRAME$/.test(el.tagName) ? __docOf(el)?.activeElement : null); if (!next || next === el) break; el = next; } return el; };
      /** This window and every same-origin frame window below it. */
      const __windows = () => { const out = []; const visit = (w) => { if (out.length >= 64) return; out.push(w); for (let i = 0; i < w.frames.length; i++) { let f; try { f = w.frames[i]; if (!f.document) continue; } catch { continue; } visit(f); } }; visit(window); return out; };
      const __ref = (n) => { const el = window.__dshBU?.els?.[n - 1]; return el && el.isConnected && el.ownerDocument.defaultView ? el : null; };
    `;

    const INTERACTIVE_ROLES = ['button', 'link', 'menuitem', 'menuitemradio', 'menuitemcheckbox', 'radio', 'checkbox', 'tab', 'switch', 'slider', 'spinbutton', 'combobox', 'searchbox', 'textbox', 'listbox', 'option', 'treeitem', 'scrollbar'];
    const INTERACTIVE_CURSORS = ['pointer', 'move', 'grab', 'grabbing', 'text', 'cell', 'copy', 'alias', 'all-scroll', 'col-resize', 'row-resize', 'ew-resize', 'ns-resize', 'nesw-resize', 'nwse-resize', 'e-resize', 'w-resize', 'n-resize', 's-resize', 'ne-resize', 'nw-resize', 'se-resize', 'sw-resize', 'crosshair', 'zoom-in', 'zoom-out', 'context-menu'];
    const MARKS_ID = '__dsh_bu_marks';
    const MARK_COLORS = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#008080', '#f032e6', '#9a6324', '#800000', '#000075', '#808000', '#dc143c'];

    /**
     * Serialize the page in DOM order: visible text lines and `[ref]<tag attrs>label />` lines for interactive elements.
     * Refs are 1-based indexes into window.__dshBU.els; `view` records which refs were inside the viewport.
     */
    const snapshotScript = (options) => `(() => {
      ${PAGE_LIB}
      const o = ${JSON.stringify(options)};
      const LIMIT = o.limit ?? 400, MAX_NODES = 30000;
      const vw = innerWidth, vh = innerHeight;
      const ROLES = new Set(${JSON.stringify(INTERACTIVE_ROLES)});
      const CURSORS = new Set(${JSON.stringify(INTERACTIVE_CURSORS)});
      const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'HEAD', 'TITLE', 'OPTION', 'OPTGROUP', 'DATALIST']);
      const LEAF = new Set(['SVG', 'SELECT', 'TEXTAREA', 'CANVAS', 'VIDEO', 'AUDIO', 'IMG', 'OBJECT', 'EMBED']);
      const CLIPS = /^(hidden|scroll|auto|clip|overlay)$/;
      const squash = (s) => String(s ?? '').replace(/\\s+/g, ' ').trim();
      const short = (s, n) => { s = squash(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
      const quote = (s) => (/[\\s"'=<>]/.test(s) ? JSON.stringify(s) : s);
      const editableOn = (e) => e?.isContentEditable ?? ['', 'true', 'plaintext-only'].includes(e?.getAttribute?.('contenteditable'));
      const editableRoot = (el) => editableOn(el) && !editableOn(el.parentElement);

      const shown = (el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) return false;
        if (typeof el.checkVisibility === 'function') return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
        const cs = __styleOf(el);
        return cs.visibility !== 'hidden' && cs.opacity !== '0';
      };
      const textVisible = new Map();
      const textShown = (p) => {
        let v = textVisible.get(p);
        if (v === undefined) {
          let e = p;
          while (e && __styleOf(e).display === 'contents') e = e.parentElement;
          v = !!e && (typeof e.checkVisibility === 'function' ? e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : __styleOf(e).visibility !== 'hidden');
          textVisible.set(p, v);
        }
        return v;
      };

      const labelOf = (el) => {
        const aria = el.getAttribute('aria-label');
        if (squash(aria)) return aria;
        const by = el.getAttribute('aria-labelledby');
        if (by) {
          const root = el.getRootNode();
          const t = by.split(/\\s+/).map((id) => { const ref = root.getElementById?.(id) ?? el.ownerDocument.getElementById(id); return ref ? (ref.getAttribute('aria-label') || ref.innerText || ref.textContent || '') : ''; }).join(' ');
          if (squash(t)) return t;
        }
        if (el.labels && el.labels.length) { const t = [...el.labels].map((l) => l.innerText ?? l.textContent).join(' '); if (squash(t)) return t; }
        const tag = el.tagName.toUpperCase();
        if (tag === 'INPUT' && ['button', 'submit', 'reset'].includes((el.type || '').toLowerCase())) return el.value;
        const text = /^(INPUT|TEXTAREA|SELECT)$/.test(tag) ? '' : (el.innerText ?? el.textContent);
        if (squash(text)) return text;
        return el.getAttribute('placeholder') || el.getAttribute('title') || el.querySelector?.('img[alt]')?.alt || el.getAttribute('alt') || el.querySelector?.('svg title')?.textContent || el.getAttribute('name') || '';
      };

      const tagLine = (el, tag) => {
        const t = tag.toLowerCase();
        const name = short(labelOf(el), 80);
        const same = (v) => v.toLowerCase() === name.toLowerCase();
        const type = (el.type || '').toLowerCase();
        const attrs = [];
        const role = el.getAttribute('role');
        if (role && role !== t) attrs.push('role=' + role);
        if (t === 'input' && type && type !== 'text') attrs.push('type=' + type);
        for (const a of ['placeholder', 'title', 'alt']) { const v = short(el.getAttribute(a), 40); if (v && !same(v)) attrs.push(a + '=' + quote(v)); }
        if ((t === 'input' || t === 'textarea') && type !== 'checkbox' && type !== 'radio') {
          const v = type === 'password' ? (el.value ? '••••' : '') : short(el.value, 60);
          if (v && !same(v)) attrs.push('value=' + quote(v));
        }
        if (t === 'select') attrs.push('selected=' + (quote(short(el.selectedOptions?.[0]?.text ?? '', 40)) || '""'), 'options=' + el.options.length);
        if (t !== 'input' && t !== 'textarea' && editableRoot(el)) {
          attrs.push('editable');
          const v = short(el.innerText ?? el.textContent, 60);
          if (v && !same(v)) attrs.push('value=' + quote(v));
        }
        if (el.checked === true || el.getAttribute('aria-checked') === 'true') attrs.push('checked');
        else if (el.getAttribute('aria-checked') === 'mixed') attrs.push('checked=mixed');
        if (el.getAttribute('aria-selected') === 'true') attrs.push('selected');
        if (el.getAttribute('aria-pressed') === 'true') attrs.push('pressed');
        const expanded = el.getAttribute('aria-expanded');
        if (expanded) attrs.push('expanded=' + expanded);
        if (el.disabled === true || el.getAttribute('aria-disabled') === 'true') attrs.push('disabled');
        if (t === 'a') { const href = el.getAttribute('href') || ''; if (href && !/^javascript:/i.test(href)) attrs.push('href=' + quote(short(href, 80))); }
        return '<' + t + (attrs.length ? ' ' + attrs.join(' ') : '') + (name ? '>' + name : '') + ' />';
      };

      const interactive = (el, tag, style, parentCursor) => {
        if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'SUMMARY') return true;
        if (tag === 'INPUT') return (el.type || '').toLowerCase() !== 'hidden';
        if (tag === 'A' && el.hasAttribute('href')) return true;
        // A styled checkbox or radio whose real input is hidden is operated through its label.
        if (tag === 'LABEL' && el.control && !shown(el.control)) return true;
        const role = el.getAttribute('role');
        if (role && ROLES.has(role)) return true;
        if (editableRoot(el)) return true;
        if (el.hasAttribute('onclick') || typeof el.onclick === 'function') return true;
        const tab = el.getAttribute('tabindex');
        if (tab !== null && Number(tab) >= 0) return true;
        const popup = el.getAttribute('aria-haspopup');
        if (popup && popup !== 'false') return true;
        // cursor is inherited: only the element that sets it counts.
        return tag !== 'BODY' && tag !== 'HTML' && CURSORS.has(style.cursor) && style.cursor !== parentCursor;
      };
      /** Inside an element that already has a ref, only a separate control earns its own. */
      const distinct = (el, tag) => /^(A|BUTTON|INPUT|SELECT|TEXTAREA|SUMMARY)$/.test(tag) || ROLES.has(el.getAttribute('role')) || editableRoot(el) ||
        el.hasAttribute('onclick') || el.hasAttribute('data-testid') || el.hasAttribute('data-test') || el.hasAttribute('data-cy');

      /** Whether another element sits on top of every probed point of el's visible part (el's own viewport). */
      const covered = (el, r, clip) => {
        const W = el.ownerDocument.defaultView;
        const left = Math.max(r.left, clip ? clip.left : 0, 0), top = Math.max(r.top, clip ? clip.top : 0, 0);
        const right = Math.min(r.right, clip ? clip.right : Infinity, W.innerWidth), bottom = Math.min(r.bottom, clip ? clip.bottom : Infinity, W.innerHeight);
        if (right - left < 1 || bottom - top < 1) return false;
        let answered = false;
        for (const [fx, fy] of [[0.5, 0.5], [0.2, 0.2], [0.8, 0.8]]) {
          const hit = __pointIn(el.ownerDocument, left + (right - left) * fx, top + (bottom - top) * fy);
          if (!hit) continue;
          answered = true;
          if (__reaches(hit, el)) return false;
        }
        return answered;
      };

      const prev = window.__dshBU;
      const known = prev?.seen instanceof WeakSet ? prev.seen : null;
      const seen = new WeakSet();
      const els = [], view = [], lines = [];
      const stats = { offscreen: 0, covered: 0, frames: 0, crossFrames: 0, limited: false, truncated: false };
      const budget = o.includeText === false ? 0 : Math.max(0, o.maxChars ?? 6000);
      let nodes = 0, textLen = 0, textCut = false, lastText = -1, lastDepth = -1, breakText = true;

      const pad = (depth) => '  '.repeat(Math.min(depth, 12));
      const line = (depth, s) => { lines.push(pad(depth) + s); lastText = -1; breakText = true; };
      const text = (depth, raw) => {
        let s = squash(raw);
        if (!s || budget === 0) return;
        if (textLen >= budget) { textCut = true; return; }
        if (textLen + s.length > budget) { s = s.slice(0, budget - textLen) + '…'; textCut = true; }
        textLen += s.length;
        // Inline runs of one block read as one line.
        if (!breakText && lastText === lines.length - 1 && lastDepth === depth) lines[lastText] += ' ' + s;
        else { lines.push(pad(depth) + s); lastText = lines.length - 1; lastDepth = depth; }
        breakText = false;
      };

      const walk = (node, ctx) => {
        if (stats.truncated) return;
        if (node.nodeType === 3) {
          if (ctx.indexed || budget === 0) return;
          const p = node.parentElement ?? node.parentNode?.host;
          if (!p || !textShown(p)) return;
          if (o.viewportOnly) {
            const r = p.getBoundingClientRect();
            if (r.bottom + ctx.off.y <= 0 || r.top + ctx.off.y >= vh || r.right + ctx.off.x <= 0 || r.left + ctx.off.x >= vw) return;
          }
          text(ctx.depth, node.data);
          return;
        }
        if (node.nodeType === 11) { for (const c of node.childNodes) walk(c, ctx); return; }
        if (node.nodeType !== 1) return;
        const el = node, tag = el.tagName.toUpperCase();
        if (SKIP.has(tag) || el.id === ${JSON.stringify(MARKS_ID)} || el.hasAttribute('inert')) return;
        if (++nodes > MAX_NODES) { stats.truncated = true; return; }
        const style = __styleOf(el);
        if (style.display === 'none') return;
        const block = !String(style.display).startsWith('inline') && style.display !== 'contents';
        if (block) breakText = true;
        const r = el.getBoundingClientRect();
        let { depth, indexed } = ctx;
        let listed = false;

        if ((!indexed || distinct(el, tag)) && interactive(el, tag, style, ctx.cursor) && shown(el)) {
          if (els.length >= LIMIT) stats.limited = true;
          else {
            const c = ctx.clip;
            const t = { left: r.left + ctx.off.x, top: r.top + ctx.off.y, right: r.right + ctx.off.x, bottom: r.bottom + ctx.off.y };
            let mark = '';
            if (c && !(r.right > c.left && r.left < c.right && r.bottom > c.top && r.top < c.bottom)) mark = ' ↕';
            else if (t.bottom <= 0) mark = ' ↑';
            else if (t.top >= vh) mark = ' ↓';
            else if (t.right <= 0) mark = ' ←';
            else if (t.left >= vw) mark = ' →';
            if (!mark && covered(el, r, c)) stats.covered++;
            else if (!(mark && o.viewportOnly)) {
              els.push(el); view.push(!mark); seen.add(el);
              if (mark) stats.offscreen++;
              line(depth, (known && !known.has(el) ? '*' : '') + '[' + els.length + ']' + tagLine(el, tag) + mark);
              listed = true; indexed = true; depth++;
            }
          }
        }

        if (tag === 'IFRAME' || tag === 'FRAME') {
          if (r.width < 20 || r.height < 20) return;
          const doc = __docOf(el), W = doc?.defaultView;
          const src = short(el.getAttribute('src') || '', 60);
          if (doc?.body && W) {
            stats.frames++;
            line(depth, '〔iframe' + (src ? ' ' + src : '') + '〕');
            const inset = __inset(el), root = { left: 0, top: 0, right: W.innerWidth, bottom: W.innerHeight };
            walk(doc.body, { depth: depth + 1, indexed: false, off: { x: ctx.off.x + inset.x, y: ctx.off.y + inset.y }, clip: root, rootClip: root, cursor: '' });
            breakText = true;
          } else if (shown(el)) {
            stats.crossFrames++;
            line(depth, '〔跨域 iframe' + (src ? ' ' + src : '') + '：内容读不到，可截图后按坐标点击〕');
          }
          return;
        }
        if (tag === 'CANVAS' && !listed && r.width >= 40 && r.height >= 40 && shown(el)) {
          line(depth, '〔canvas ' + Math.round(r.width) + '×' + Math.round(r.height) + '，左上角 (' + Math.round(r.left + ctx.off.x) + ', ' + Math.round(r.top + ctx.off.y) + ')：内容要截图才看得到〕');
        }
        if (LEAF.has(tag)) return;

        let clip = style.position === 'fixed' ? ctx.rootClip : ctx.clip;
        const cx = CLIPS.test(style.overflowX), cy = CLIPS.test(style.overflowY);
        if ((cx || cy) && tag !== 'BODY' && tag !== 'HTML') {
          const b = clip ?? { left: -Infinity, top: -Infinity, right: Infinity, bottom: Infinity };
          clip = {
            left: cx ? Math.max(b.left, r.left) : b.left, right: cx ? Math.min(b.right, r.right) : b.right,
            top: cy ? Math.max(b.top, r.top) : b.top, bottom: cy ? Math.min(b.bottom, r.bottom) : b.bottom,
          };
        }
        const child = { depth, indexed, off: ctx.off, clip, rootClip: ctx.rootClip, cursor: style.cursor };
        if (el.shadowRoot) walk(el.shadowRoot, child);
        for (const c of el.childNodes) walk(c, child);
        if (block) breakText = true;
      };

      const root = document.body ?? document.documentElement;
      if (root) walk(root, { depth: 0, indexed: false, off: { x: 0, y: 0 }, clip: null, rootClip: null, cursor: '' });
      window.__dshBU = { els, view, seen, at: Date.now() };
      return {
        url: location.href, title: document.title, vw, vh,
        scrollY: Math.round(scrollY), scrollHeight: Math.round(document.documentElement.scrollHeight),
        lines, count: els.length, ...stats, textLen, textCut,
      };
    })()`;

    /** Numbered boxes over every ref the last snapshot saw in the viewport (browser-use's highlight overlay). */
    const markScript = `(async () => {
      ${PAGE_LIB}
      document.getElementById(${JSON.stringify(MARKS_ID)})?.remove();
      const s = window.__dshBU;
      if (!s?.els?.length) return 0;
      const colors = ${JSON.stringify(MARK_COLORS)};
      const box = document.createElement('div');
      box.id = ${JSON.stringify(MARKS_ID)};
      box.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none;z-index:2147483647;';
      let count = 0;
      s.els.forEach((el, i) => {
        if (!s.view?.[i] || !el.isConnected || !el.ownerDocument.defaultView) return;
        const off = __offset(el.ownerDocument);
        const rects = [...el.getClientRects()].filter((r) => r.width > 1 && r.height > 1).slice(0, 4);
        if (!rects.length) return;
        const color = colors[i % colors.length];
        for (const r of rects) {
          const d = document.createElement('div');
          d.style.cssText = 'position:fixed;box-sizing:border-box;border:2px solid ' + color + ';background:' + color + '1f;left:' + (r.left + off.x) + 'px;top:' + (r.top + off.y) + 'px;width:' + r.width + 'px;height:' + r.height + 'px;';
          box.appendChild(d);
        }
        const r = rects[0], label = document.createElement('div');
        label.textContent = String(i + 1);
        // Inside the top-right corner when the element is big enough, otherwise just above it.
        const inside = r.width >= 30 && r.height >= 18;
        const top = inside ? r.top + off.y + 1 : r.top + off.y - 15;
        label.style.cssText = 'position:fixed;transform:translateX(-100%);padding:0 3px;border-radius:3px;background:' + color + ';color:#fff;font:bold 11px/14px -apple-system,"Segoe UI",Arial,sans-serif;white-space:nowrap;left:' + Math.max(24, r.right + off.x - 1) + 'px;top:' + Math.max(0, Math.min(innerHeight - 14, top)) + 'px;';
        box.appendChild(label);
        count++;
      });
      (document.body || document.documentElement).appendChild(box);
      // The top layer puts the marks above open <dialog>s and popovers too.
      try { box.popover = 'manual'; box.showPopover(); } catch {}
      await new Promise((done) => { requestAnimationFrame(() => requestAnimationFrame(done)); setTimeout(done, 150); });
      return count;
    })()`;
    const unmarkScript = `(() => { document.getElementById(${JSON.stringify(MARKS_ID)})?.remove(); })()`;

    /** Bring a ref into view and find a point where a real click reaches it; otherwise name what covers it. */
    const locateScript = (ref) => `(() => {
      ${PAGE_LIB}
      const el = __ref(${Number(ref)});
      if (!el) return { stale: true };
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      const off = __offset(el.ownerDocument);
      const rects = [...el.getClientRects()].filter((r) => r.width > 1 && r.height > 1);
      const r = rects[0] ?? el.getBoundingClientRect();
      const tag = el.tagName.toLowerCase();
      const label = String(el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 60);
      let first;
      for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75], [0.5, 0.15], [0.5, 0.85]]) {
        const x = Math.round(r.left + r.width * fx + off.x), y = Math.round(r.top + r.height * fy + off.y);
        const hit = __hit(x, y).el;
        first ??= { x, y, hit };
        if (__reaches(hit, el)) return { x, y, covered: false, tag, label };
      }
      return { x: first.x, y: first.y, covered: true, by: __describe(first.hit), tag, label };
    })()`;

    /** Click a ref with DOM calls, for when the caller accepts that a real click cannot reach it. */
    const forceClickScript = (ref) => `(() => {
      ${PAGE_LIB}
      const el = __ref(${Number(ref)});
      if (!el) return false;
      el.focus?.();
      if (typeof el.click === 'function') el.click();
      else { const W = el.ownerDocument.defaultView; el.dispatchEvent(new W.MouseEvent('click', { bubbles: true, cancelable: true, composed: true, view: W })); }
      return true;
    })()`;

    /** A short-lived ring where the agent clicks, so the user can follow along. */
    const rippleScript = (x, y) => `(() => {
      const d = document.createElement('div');
      d.style.cssText = 'position:fixed;left:${x - 14}px;top:${y - 14}px;width:28px;height:28px;border:3px solid #4d6bfe;border-radius:50%;background:rgba(77,107,254,.18);pointer-events:none;z-index:2147483647;transition:transform .5s ease-out,opacity .5s ease-out;';
      (document.body || document.documentElement).appendChild(d);
      requestAnimationFrame(() => { d.style.transform = 'scale(1.8)'; d.style.opacity = '0'; });
      setTimeout(() => d.remove(), 650);
    })()`;

    const targetExpr = (ref) => (ref === undefined ? '__active()' : `__ref(${Number(ref)})`);

    const focusScript = (ref, clear) => `(() => {
      ${PAGE_LIB}
      const el = ${targetExpr(ref)};
      if (!el || !el.isConnected) return { stale: true };
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      el.focus();
      if (${clear ? 'true' : 'false'}) {
        if (typeof el.select === 'function' && ('value' in el)) el.select();
        else if (el.isContentEditable) { const d = el.ownerDocument, range = d.createRange(); range.selectNodeContents(el); const s = d.defaultView.getSelection(); s.removeAllRanges(); s.addRange(range); }
      } else if (typeof el.setSelectionRange === 'function' && typeof el.value === 'string') {
        try { el.setSelectionRange(el.value.length, el.value.length); } catch {}
      }
      return { tag: el.tagName.toLowerCase(), editable: el.isContentEditable || /^(INPUT|TEXTAREA)$/.test(el.tagName) };
    })()`;

    /** Fallback when native text insertion is unavailable: set the value the way frameworks observe it. */
    const setValueScript = (ref, text, clear) => `(() => {
      ${PAGE_LIB}
      const el = ${targetExpr(ref)};
      if (!el) return false;
      const W = el.ownerDocument.defaultView;
      const next = (${clear ? 'true' : 'false'} ? '' : (el.value ?? el.innerText ?? '')) + ${JSON.stringify(text)};
      if (el.isContentEditable) { el.innerText = next; }
      else { const proto = el.tagName === 'TEXTAREA' ? W.HTMLTextAreaElement.prototype : W.HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, next); }
      el.dispatchEvent(new W.Event('input', { bubbles: true }));
      el.dispatchEvent(new W.Event('change', { bubbles: true }));
      return true;
    })()`;

    const selectScript = (ref, value) => `(() => {
      ${PAGE_LIB}
      const el = __ref(${Number(ref)});
      if (!el) return { stale: true };
      if (el.tagName !== 'SELECT') return { error: '这个元素不是 <select>，请改用 browser_click 打开它的选项' };
      const W = el.ownerDocument.defaultView;
      const want = ${JSON.stringify(String(value))};
      const option = [...el.options].find((o) => o.value === want) || [...el.options].find((o) => o.text.trim() === want.trim()) || [...el.options].find((o) => o.text.toLowerCase().includes(want.toLowerCase()));
      if (!option) return { error: '没有匹配的选项。可选：' + [...el.options].map((o) => o.text.trim()).slice(0, 40).join(' | ') };
      el.value = option.value;
      el.dispatchEvent(new W.Event('input', { bubbles: true }));
      el.dispatchEvent(new W.Event('change', { bubbles: true }));
      return { selected: option.text.trim() };
    })()`;

    const scrollScript = (ref, dx, dy) => `(() => {
      ${PAGE_LIB}
      const before = [scrollX, scrollY];
      if (${ref === undefined ? 'false' : 'true'}) {
        const el = __ref(${Number(ref)});
        if (!el) return { stale: true };
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
      } else {
        scrollBy({ left: ${Number(dx) || 0}, top: ${dy === undefined ? 'Math.round(innerHeight * 0.85)' : Number(dy)}, behavior: 'instant' });
      }
      return { moved: before[0] !== scrollX || before[1] !== scrollY, scrollY: Math.round(scrollY), scrollHeight: Math.round(document.documentElement.scrollHeight), vh: innerHeight, vw: innerWidth };
    })()`;

    /** Whether the text appears in the page or any same-origin frame. */
    const textPresentScript = (text) => `(() => {
      ${PAGE_LIB}
      const t = ${JSON.stringify(String(text))};
      return __windows().some((w) => { try { return !!w.document.body && w.document.body.innerText.includes(t); } catch { return false; } });
    })()`;

    // ── Input delivery. sendInputEvent is silently dropped while the webview is not painting (its Session is in the
    //    background), so every real input is checked with a probe and replaced by synthetic DOM events when it never arrives. ──

    /** Listen for trusted events of the given types in every same-origin frame; also report what sits at (x, y) when given. */
    const armProbeScript = (types, x, y) => `(() => {
      ${PAGE_LIB}
      window.__dshProbe?.off?.();
      const state = { hit: false };
      const on = (e) => { if (e.isTrusted) state.hit = true; };
      const types = ${JSON.stringify(types)};
      const wins = __windows();
      for (const w of wins) for (const t of types) w.addEventListener(t, on, true);
      state.off = () => { for (const w of wins) for (const t of types) { try { w.removeEventListener(t, on, true); } catch {} } };
      window.__dshProbe = state;
      return { target: __describe(${x === undefined ? '__active()' : `__hit(${Number(x)}, ${Number(y)}).el`}) };
    })()`;
    /** true / false once armed; null when the page changed in between (a navigation means the input arrived). */
    const readProbeScript = `(() => { const s = window.__dshProbe; if (!s) return null; s.off(); window.__dshProbe = undefined; return s.hit; })()`;

    const syntheticClickScript = (x, y, button = 'left', double = false) => `(() => {
      ${PAGE_LIB}
      const h = __hit(${Number(x)}, ${Number(y)});
      const el = h.el;
      if (!el) return { missed: true };
      const W = el.ownerDocument.defaultView, x = h.x, y = h.y;
      const btn = ${JSON.stringify(button)} === 'right' ? 2 : ${JSON.stringify(button)} === 'middle' ? 1 : 0;
      const buttons = [1, 4, 2][btn];
      const PE = W.PointerEvent || W.MouseEvent;
      const base = { bubbles: true, cancelable: true, composed: true, view: W, clientX: x, clientY: y, screenX: ${Number(x)}, screenY: ${Number(y)}, button: btn, pointerId: 1, pointerType: 'mouse', isPrimary: true };
      const fire = (C, type, extra) => el.dispatchEvent(new C(type, { ...base, ...extra }));
      fire(PE, 'pointerover'); fire(W.MouseEvent, 'mouseover'); fire(PE, 'pointermove'); fire(W.MouseEvent, 'mousemove');
      for (let n = 1; n <= ${double ? 2 : 1}; n++) {
        fire(PE, 'pointerdown', { buttons, detail: n });
        const go = fire(W.MouseEvent, 'mousedown', { buttons, detail: n });
        if (go && n === 1 && btn === 0) el.closest('input,textarea,select,button,a[href],[tabindex],[contenteditable]')?.focus?.();
        fire(PE, 'pointerup', { detail: n });
        fire(W.MouseEvent, 'mouseup', { detail: n });
        if (btn === 0) fire(W.MouseEvent, 'click', { detail: n }); else if (btn === 1) fire(W.MouseEvent, 'auxclick', { detail: n });
      }
      if (${double ? 'true' : 'false'}) fire(W.MouseEvent, 'dblclick', { detail: 2 });
      if (btn === 2) fire(W.MouseEvent, 'contextmenu', { buttons: 2 });
      return { target: __describe(el) };
    })()`;

    const DOM_KEY = { Up: 'ArrowUp', Down: 'ArrowDown', Left: 'ArrowLeft', Right: 'ArrowRight', Space: ' ' };
    const LEGACY_CODE = { Backspace: 8, Tab: 9, Enter: 13, Escape: 27, ' ': 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 };

    /** Key events on the focused element, with the legacy keyCode/which that older handlers still read. */
    const syntheticKeyScript = (electronKey, modifiers = []) => {
      const key = DOM_KEY[electronKey] ?? electronKey;
      const legacy = LEGACY_CODE[key] ?? (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
      const code = key === ' ' ? 'Space' : key.length === 1 ? (/[a-z]/i.test(key) ? 'Key' + key.toUpperCase() : /[0-9]/.test(key) ? 'Digit' + key : '') : key;
      const has = (m) => modifiers.includes(m);
      return `(() => {
        ${PAGE_LIB}
        const el = __active() || document.body;
        const W = el.ownerDocument.defaultView;
        const init = { key: ${JSON.stringify(key)}, code: ${JSON.stringify(code)}, bubbles: true, cancelable: true, composed: true, view: W,
          shiftKey: ${has('shift')}, ctrlKey: ${has('control')}, altKey: ${has('alt')}, metaKey: ${has('meta')} };
        const make = (type) => { const e = new W.KeyboardEvent(type, init); for (const p of ['keyCode', 'which']) Object.defineProperty(e, p, { get: () => ${legacy} }); return e; };
        const go = el.dispatchEvent(make('keydown'));
        if (go && ${key.length === 1 && !has('control') && !has('meta') && !has('alt')}) el.dispatchEvent(make('keypress'));
        el.dispatchEvent(make('keyup'));
        return { target: __describe(el) };
      })()`;
    };

    const valueScript = (ref) => `(() => {
      ${PAGE_LIB}
      const el = ${targetExpr(ref)};
      if (!el) return null;
      return typeof el.value === 'string' ? el.value : el.isContentEditable ? el.innerText : null;
    })()`;

    // ── browser_eval: return the value of the last expression statement without running the script twice. ──

    /** Offsets where a top-level statement may end: after ; or a block's }, or at a line break (kind 'line'). */
    function topLevelBoundaries(src) {
      const out = [];
      const stack = [];
      let i = 0;
      while (i < src.length) {
        const c = src[i];
        if (stack[stack.length - 1] === '`') {
          if (c === '\\') i += 2;
          else if (c === '`') { stack.pop(); i++; }
          else if (c === '$' && src[i + 1] === '{') { stack.push('${'); i += 2; }
          else i++;
          continue;
        }
        const n = src[i + 1];
        if (c === '/' && n === '/') { const j = src.indexOf('\n', i); i = j < 0 ? src.length : j; continue; }
        if (c === '/' && n === '*') { const j = src.indexOf('*/', i + 2); i = j < 0 ? src.length : j + 2; continue; }
        if (c === '"' || c === "'") {
          i++;
          while (i < src.length && src[i] !== c && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
          i++;
          continue;
        }
        if (c === '`' || c === '(' || c === '[' || c === '{') { stack.push(c); i++; continue; }
        if (c === ')' || c === ']' || c === '}') {
          const open = stack.pop();
          i++;
          if (c === '}' && open === '{' && stack.length === 0) out.push({ at: i, kind: 'block' });
          continue;
        }
        if (stack.length === 0 && (c === ';' || c === '\n')) out.push({ at: i + 1, kind: c === ';' ? 'semi' : 'line' });
        i++;
      }
      return out;
    }

    const STATEMENT_START = /^(?:return|const|let|var|if|for|while|do|switch|try|throw|function|class|import|export|break|continue|debugger|else|catch|finally)\b|^[{}]/;
    // After a bare line break JavaScript keeps parsing the previous expression when the next line starts with one of these.
    const CONTINUATION = /^[.,?:=<>*/%&|^+\-([`]/;

    /** Async-function bodies to try in order: the whole script as one expression, the last statement returned, the script as is. */
    function evalBodies(source) {
      const bodies = ['return (\n' + source + '\n);'];
      const cuts = topLevelBoundaries(source);
      for (let k = cuts.length - 1, tried = 0; k >= 0 && tried < 8; k--) {
        const tail = source.slice(cuts[k].at).trim().replace(/;+$/, '').trim();
        if (!tail || STATEMENT_START.test(tail) || (cuts[k].kind === 'line' && CONTINUATION.test(tail))) continue;
        tried++;
        bodies.push(source.slice(0, cuts[k].at) + '\nreturn (\n' + tail + '\n);');
      }
      bodies.push(source);
      return bodies;
    }

    const AsyncFunction = (async () => {}).constructor;
    /** The first body that parses (compiling runs nothing); undefined when this window may not compile code. */
    function pickEvalBody(source) {
      const bodies = evalBodies(source);
      for (const body of bodies) {
        try { new AsyncFunction(body); return body; }
        catch (error) { if (!(error instanceof SyntaxError)) return undefined; }
      }
      return bodies[bodies.length - 1];
    }

    // ── Electron key names for sendInputEvent. ──

    const KEY_ALIASES = { arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', up: 'Up', down: 'Down', left: 'Left', right: 'Right', enter: 'Enter', return: 'Enter', tab: 'Tab', escape: 'Escape', esc: 'Escape', backspace: 'Backspace', delete: 'Delete', del: 'Delete', home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', space: 'Space', ' ': 'Space' };
    const CHAR_OF = { Enter: '\r', Tab: '\t', Space: ' ' };
    const keyName = (key) => KEY_ALIASES[String(key).toLowerCase()] ?? (String(key).length === 1 ? String(key) : String(key));

    function base64(bytes) {
      let out = '';
      for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(out);
    }
    /**
     * PNG data URL from capturePage → JPEG no wider than the page's CSS width (and SHOT_MAX_WIDTH), using only
     * web APIs (Image + canvas). Falls back to the original PNG if the canvas path is unavailable.
     */
    async function encodeShot(dataUrl, cssWidth) {
      if (!/^data:image\/png;base64,./.test(dataUrl)) throw new Error('截图为空');
      const img = new Image();
      img.decoding = 'async';
      img.src = dataUrl;
      await img.decode();
      const naturalW = img.naturalWidth, naturalH = img.naturalHeight;
      if (!naturalW || !naturalH) throw new Error('截图为空');
      const width = Math.max(1, Math.min(SHOT_MAX_WIDTH, cssWidth || naturalW, naturalW));
      const height = Math.max(1, Math.round(naturalH * (width / naturalW)));
      try {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const g = canvas.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.fillStyle = '#fff';
        g.fillRect(0, 0, width, height);
        g.drawImage(img, 0, 0, width, height);
        const jpeg = canvas.toDataURL('image/jpeg', 0.82);
        canvas.width = canvas.height = 0; // release the backing store right away
        if (jpeg.startsWith('data:image/jpeg;base64,')) return { data: jpeg.slice('data:image/jpeg;base64,'.length), mediaType: 'image/jpeg', width, height };
      } catch {}
      return { data: dataUrl.slice('data:image/png;base64,'.length), mediaType: 'image/png', width: naturalW, height: naturalH };
    }
    const withTimeout = (promise, ms, message) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      Promise.resolve(promise).then((value) => { clearTimeout(timer); resolve(value); }, (error) => { clearTimeout(timer); reject(error); });
    });
    const errorText = (error) => String(error?.message ?? error).replace(/^Error invoking remote method '[^']+': /, '');

    return {
      inject: ['sidebarRight'],
      scripts: { snapshotScript, markScript, unmarkScript, locateScript, forceClickScript, focusScript, setValueScript, selectScript, scrollScript, textPresentScript, keyName, armProbeScript, readProbeScript, syntheticClickScript, syntheticKeyScript, valueScript, topLevelBoundaries, evalBodies, pickEvalBody },
      apply(ctx) {
        const carrier = globalThis.dshDesktop;
        // Web profiles render the browser as a cross-origin iframe that no script may drive; stay silent there
        // so the Host reports "no desktop window" instead of accepting commands it cannot run.
        if (carrier?.protocolVersion !== 1) return;

        let lastFrame;
        let badge;
        let badgeTimer;

        ctx.effect(() => {
          const style = document.createElement('style');
          style.dataset.plugin = PKG;
          style.textContent = `
            .dshbu-badge { position:fixed; z-index:2147483000; display:flex; align-items:center; gap:6px; padding:4px 10px; border-radius:999px;
              background:rgba(77,107,254,.92); color:#fff; font-size:12px; line-height:18px; pointer-events:none; box-shadow:0 2px 8px rgba(0,0,0,.18);
              transition:opacity .25s ease; white-space:nowrap; }
            .dshbu-badge i { width:7px; height:7px; border-radius:50%; background:#fff; animation:dshbu-pulse 1s ease-in-out infinite; }
            .dshbu-frame { outline:2px solid rgba(77,107,254,.85); outline-offset:-2px; }
            @keyframes dshbu-pulse { 50% { opacity:.3; } }
            @media (prefers-reduced-motion: reduce) { .dshbu-badge i { animation:none; } }
          `;
          document.head.appendChild(style);
          return () => { style.remove(); badge?.remove(); lastFrame?.classList.remove('dshbu-frame'); };
        }, 'browser-use: styles');

        /** Show which browser the agent is driving and what it is doing. */
        function announce(frame, text) {
          // A browser in a Session the user is not looking at stays silent: the badge would land on another Session's view.
          if (!visible(frame)) return;
          clearTimeout(badgeTimer);
          if (lastFrame && lastFrame !== frame) lastFrame.classList.remove('dshbu-frame');
          frame.classList.add('dshbu-frame');
          lastFrame = frame;
          badge ??= Object.assign(document.createElement('div'), { className: 'dshbu-badge' });
          badge.innerHTML = '<i></i><span></span>';
          badge.querySelector('span').textContent = 'Agent · ' + text;
          const r = frame.getBoundingClientRect();
          badge.style.top = Math.max(4, r.top + 8) + 'px';
          badge.style.right = Math.max(4, window.innerWidth - r.right + 8) + 'px';
          badge.style.opacity = '1';
          if (!badge.isConnected) document.body.appendChild(badge);
        }
        function quiet(frame) {
          clearTimeout(badgeTimer);
          badgeTimer = setTimeout(() => { if (badge) badge.style.opacity = '0'; frame?.classList.remove('dshbu-frame'); }, 1500);
        }

        // ── Finding the sidebar browser ──

        // Every command belongs to the Session whose agent called the tool. Commands run one at a time,
        // so this is the Session of the command in progress; a browser of any other Session is never touched.
        let current;
        const lastBySession = new Map();

        const sessionOf = (el) => el.closest('[data-sidebar-right-session]')?.getAttribute('data-sidebar-right-session');
        const frames = () => [...document.querySelectorAll(FRAME_SELECTOR)].filter((el) => el.isConnected && sessionOf(el) === current);
        const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 20 && r.height > 20; };
        const ready = (el) => { try { el.getWebContentsId(); el.getURL(); return true; } catch { return false; } };

        function pickFrame() {
          const own = frames().filter(ready);
          const last = lastBySession.get(current);
          if (last && own.includes(last)) return last;
          // Desktop keeps every Browser tab mounted; prefer the one on screen, then the active tab of its pane.
          return own.find(visible) ?? own.find((el) => el.closest('[data-dockkit-pane-active="true"]')) ?? own[0];
        }

        async function ensureFrame(url, signal) {
          const existing = pickFrame();
          if (existing) return { frame: existing, opened: false };
          const sidebar = ctx.sidebarRight;
          const options = url ? { params: { url } } : {};
          const mounted = sidebar?.mounted?.getSnapshot?.();
          if (mounted === current && typeof sidebar.openTab === 'function') sidebar.openTab('browser', options);
          else if (typeof sidebar?.openTabIn === 'function') sidebar.openTabIn(current, 'browser', options);
          else throw new Error('这个会话的右侧栏里没有浏览器标签，而它当前不在前台，无法替它打开。请让用户切到这个会话（或在它的右侧栏手动打开浏览器）后重试。');
          for (let waited = 0; waited < 8_000 && !signal.aborted; waited += 150) {
            const frame = pickFrame();
            if (frame) return { frame, opened: true };
            await sleep(150, signal);
          }
          // openTabIn does nothing for a Session whose sidebar was never loaded in this window.
          throw new Error('没能在这个会话的右侧栏打开浏览器（它的右侧栏可能还没在窗口中加载过）。请让用户切到这个会话一次，或在它的右侧栏手动打开浏览器后重试。不会借用其他会话的浏览器。');
        }

        async function settle(frame, { budget = 15_000, grace = 250 } = {}) {
          await sleep(grace);
          const start = Date.now();
          while (Date.now() - start < budget) {
            let loading = false;
            try { loading = frame.isLoading(); } catch { return; }
            if (!loading) break;
            await sleep(150);
          }
          await sleep(150);
        }

        const where = (frame) => {
          try { return `${frame.getTitle() || '(无标题)'} — ${frame.getURL()}`; } catch { return '(页面尚未就绪)'; }
        };
        const run = (frame, script) => frame.executeJavaScript(script, true);

        function normalizeUrl(input) {
          let text = String(input ?? '').trim();
          if (text === '') throw new Error('缺少 url');
          if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = 'https://' + text;
          let url;
          try { url = new URL(text); } catch { throw new Error('无效的网址：' + input); }
          if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('内置浏览器只打开 http(s) 网址');
          return url.href;
        }

        const SYNTHETIC_NOTE = '（真实输入没有送达页面——这个会话的浏览器不在前台，已改用合成事件 isTrusted=false；大多数页面照常响应，若无效果请让用户切到这个会话后重试）';

        /** One line on what the snapshot left out or could not read. */
        function snapshotNotes(s, maxChars) {
          const notes = [`${s.count} 个可交互元素`];
          if (s.offscreen) notes.push(`${s.offscreen} 个在视口外（行尾 ↑↓←→ 指方向，↕ 表示被外层容器裁掉或滚出）`);
          if (s.covered) notes.push(`${s.covered} 个被其他元素挡住，未列出`);
          if (s.frames) notes.push(`已展开 ${s.frames} 个同源 iframe`);
          if (s.crossFrames) notes.push(`${s.crossFrames} 个跨域 iframe 读不到内容`);
          if (s.limited) notes.push('元素太多，后面的没有编号');
          if (s.truncated) notes.push('页面节点太多，只读了前一部分');
          if (s.textCut) notes.push(`页面文字截到 ${maxChars} 字（调大 max_chars，或用 viewport_only 只看视口）`);
          return notes.join('；');
        }

        /** Real mouse input, verified; falls back to synthetic DOM events. Returns what was hit and how. */
        async function mouseClick(frame, x, y, { button = 'left', double = false } = {}) {
          await run(frame, rippleScript(x, y)).catch(() => {});
          const armed = await run(frame, armProbeScript(['pointerdown', 'mousedown'], x, y)).catch(() => null);
          frame.sendInputEvent({ type: 'mouseMove', x, y });
          for (let count = 1; count <= (double ? 2 : 1); count++) {
            frame.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: count });
            frame.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: count });
          }
          if (!armed) return { target: '', synthetic: false };
          await sleep(150);
          const delivered = await run(frame, readProbeScript).catch(() => null);
          if (delivered !== false) return { target: armed.target, synthetic: false };
          const r = await run(frame, syntheticClickScript(x, y, button, double));
          return { target: r.target ?? armed.target, synthetic: true, missed: r.missed === true };
        }

        /** Real key input, verified; falls back to synthetic key events on the focused element. */
        async function pressKey(frame, key, modifiers = []) {
          const keyCode = keyName(key);
          const armed = await run(frame, armProbeScript(['keydown'])).catch(() => null);
          frame.sendInputEvent({ type: 'keyDown', keyCode, modifiers });
          const char = CHAR_OF[keyCode] ?? (keyCode.length === 1 ? keyCode : undefined);
          if (char !== undefined && !modifiers.some((m) => m === 'control' || m === 'meta' || m === 'alt')) frame.sendInputEvent({ type: 'char', keyCode: char, modifiers });
          frame.sendInputEvent({ type: 'keyUp', keyCode, modifiers });
          if (!armed) return { target: '', synthetic: false };
          await sleep(120);
          const delivered = await run(frame, readProbeScript).catch(() => null);
          if (delivered !== false) return { target: armed.target, synthetic: false };
          const r = await run(frame, syntheticKeyScript(keyCode, modifiers));
          return { target: r.target, synthetic: true };
        }

        const stale = () => new Error('元素 ref 已失效（页面已变化），请先调用 browser_snapshot 获取新的 ref');

        // ── Actions ──

        const actions = {
          async navigate(args, signal) {
            const action = args.action ?? 'go';
            const url = action === 'go' ? normalizeUrl(args.url) : undefined;
            const { frame, opened } = await ensureFrame(url, signal);
            announce(frame, action === 'go' ? '打开 ' + new URL(url).host : action);
            if (action === 'back') { if (!frame.canGoBack()) return { frame, text: '没有可以后退的页面。当前：' + where(frame) }; frame.goBack(); }
            else if (action === 'forward') { if (!frame.canGoForward()) return { frame, text: '没有可以前进的页面。当前：' + where(frame) }; frame.goForward(); }
            else if (action === 'reload') frame.reload();
            else {
              if (opened) await settle(frame, { budget: 8_000 });
              const current = (() => { try { return frame.getURL(); } catch { return ''; } })();
              if (!opened || current.startsWith('about:')) {
                // Redirects abort the first load; the page still arrives.
                await frame.loadURL(url).catch((error) => { if (!/ERR_ABORTED|\(-3\)/.test(errorText(error))) throw new Error('页面加载失败：' + errorText(error)); });
              }
            }
            await settle(frame, { budget: 30_000 });
            return { frame, text: '已加载：' + where(frame) };
          },

          async snapshot(args, signal) {
            const { frame } = await ensureFrame(undefined, signal);
            announce(frame, '读取页面');
            const maxChars = Math.min(40_000, Math.max(0, args.max_chars ?? 6_000));
            const s = await run(frame, snapshotScript({ includeText: args.include_text !== false, maxChars, viewportOnly: args.viewport_only === true }));
            const parts = [
              `页面：${s.title || '(无标题)'}`,
              `URL：${s.url}`,
              `视口 ${s.vw}×${s.vh}，已滚动 ${s.scrollY}/${Math.max(0, s.scrollHeight - s.vh)}px`,
              snapshotNotes(s, maxChars),
              '',
              ...(s.lines.length ? s.lines : ['（页面没有可见内容）']),
            ];
            return { frame, text: parts.join('\n') };
          },

          async screenshot(args, signal) {
            const { frame } = await ensureFrame(undefined, signal);
            const annotate = args.annotate === true;
            announce(frame, annotate ? '标注截图' : '截图');
            if (badge) badge.style.opacity = '0';
            let listing = '';
            if (annotate) {
              // A fresh viewport snapshot, so the numbers drawn are exactly the refs the other tools take.
              const s = await run(frame, snapshotScript({ includeText: false, maxChars: 0, viewportOnly: true }));
              const drawn = await withTimeout(run(frame, markScript), 5_000, '画标注超时').catch(() => 0);
              listing = `\n图中编号就是当前 ref（已刷新，可直接用于 browser_click 等），共标注 ${drawn} 个。${snapshotNotes(s, 0)}\n` + (s.lines.length ? s.lines.join('\n') : '（视口内没有可交互元素）');
            }
            // capturePage waits for the next composited frame, which never comes while the window is hidden or occluded.
            let image;
            try {
              image = await withTimeout(frame.capturePage(), 8_000, visible(frame) ? '截图超时：DSH 窗口可能被最小化或完全遮挡，请把窗口切到前台后重试（browser_snapshot 不受影响）' : '截图超时：这个会话当前不在前台，它的浏览器没有在绘制。可以改用 browser_snapshot，或请用户切到这个会话后再截图');
            } finally {
              if (annotate) await run(frame, unmarkScript).catch(() => {});
            }
            if (!image || typeof image.toDataURL !== 'function') throw new Error('这个版本的桌面端不支持网页截图');
            // Only toDataURL() touches the NativeImage: it returns a plain string. NativeImage.resize()/toJPEG()
            // hand the renderer Buffers over external native memory, which Electron's V8 sandbox rejects with a
            // fatal CHECK — every screenshot used to crash the whole DSH window (SIGTRAP in CrRendererMain).
            // Scaling and JPEG encoding happen with standard canvas APIs instead.
            const cssWidth = Math.round(frame.getBoundingClientRect().width) || 0;
            const encoded = await encodeShot(image.toDataURL(), cssWidth);
            const out = { width: encoded.width, height: encoded.height };
            const { data, mediaType } = encoded;
            const ratio = (cssWidth || out.width) / out.width;
            return {
              frame,
              text: `截图 ${out.width}×${out.height} · ${where(frame)}` + (Math.abs(ratio - 1) > 0.02 ? `\n截图坐标 × ${ratio.toFixed(3)} = 页面 CSS 坐标（browser_click 的 x/y）` : '\n截图坐标即页面 CSS 坐标，可直接用于 browser_click 的 x/y') + listing,
              image: { data, mediaType },
            };
          },

          async click(args, signal) {
            const { frame } = await ensureFrame(undefined, signal);
            let x = args.x, y = args.y, note = '';
            if (args.ref !== undefined) {
              const spot = await run(frame, locateScript(args.ref));
              if (spot.stale) throw stale();
              announce(frame, `点击 [${args.ref}] ${spot.label || spot.tag}`);
              if (spot.covered) {
                const blocker = spot.by || '其他元素';
                // A real click would land on the cover (a banner, a modal backdrop), so say what it is instead of guessing.
                if (args.force !== true) throw new Error(`[${args.ref}] ${spot.label || spot.tag} 被 ${blocker} 挡住，真实点击会落在它上面。先关掉遮挡的弹窗或浮层（browser_press Escape，或点它的关闭按钮），或滚动后重新 browser_snapshot；确定要点这个元素时传 force: true 改用脚本点击`);
                if (!(await run(frame, forceClickScript(args.ref)))) throw stale();
                await settle(frame, { budget: 10_000, grace: 400 });
                return { frame, text: `已点击 [${args.ref}] ${spot.label}（被 ${blocker} 挡住，按 force 用脚本点击；没有效果时请先关掉遮挡物）\n当前：${where(frame)}` };
              }
              x = spot.x; y = spot.y;
            } else if (typeof x !== 'number' || typeof y !== 'number') {
              throw new Error('需要 ref，或同时提供 x 和 y');
            } else announce(frame, `点击 (${Math.round(x)}, ${Math.round(y)})`);
            const hit = await mouseClick(frame, Math.round(x), Math.round(y), { button: args.button ?? 'left', double: args.double === true });
            if (hit.missed) throw new Error(`(${Math.round(x)}, ${Math.round(y)}) 处没有元素（超出视口？），真实点击也没有送达页面`);
            if (hit.synthetic) note += SYNTHETIC_NOTE;
            await settle(frame, { budget: 10_000, grace: 400 });
            const what = args.ref !== undefined ? `[${args.ref}]` : `(${Math.round(x)}, ${Math.round(y)})${hit.target ? ' → ' + hit.target : ''}`;
            return { frame, text: `已点击 ${what}${note}\n当前：${where(frame)}` };
          },

          async type(args, signal) {
            const { frame } = await ensureFrame(undefined, signal);
            const text = String(args.text ?? '');
            const clear = args.clear !== false;
            announce(frame, `输入 “${text.length > 16 ? text.slice(0, 16) + '…' : text}”`);
            const target = await run(frame, focusScript(args.ref, clear));
            if (target.stale) throw stale();
            frame.focus();
            let method = 'keyboard';
            const before = await run(frame, valueScript(args.ref)).catch(() => null);
            try {
              if (text === '' && clear) { if ((await pressKey(frame, 'Backspace')).synthetic) method = 'script'; }
              else await frame.insertText(text);
            } catch {
              method = 'script';
            }
            if (method === 'keyboard' && text !== '') {
              // insertText is dropped like any other input while the browser is not painting; the value tells.
              await sleep(60);
              const after = await run(frame, valueScript(args.ref)).catch(() => null);
              if (before !== null && after === before) method = 'script';
            }
            if (method === 'script') await run(frame, setValueScript(args.ref, text, clear));
            let submitNote = '';
            if (args.submit === true) {
              await sleep(80);
              if ((await pressKey(frame, 'Enter')).synthetic) submitNote = '（Enter 为合成事件，表单不一定会提交；必要时点击提交按钮）';
              await settle(frame, { budget: 15_000, grace: 400 });
            }
            const where$ = args.ref !== undefined ? `[${args.ref}]` : '当前焦点元素';
            return { frame, text: `已在 ${where$} 输入 ${text.length} 个字符${method === 'script' ? '（脚本方式）' : ''}${args.submit ? '并按下 Enter' + submitNote : ''}\n当前：${where(frame)}` };
          },

          async press(args, signal) {
            const { frame } = await ensureFrame(undefined, signal);
            const modifiers = Array.isArray(args.modifiers) ? args.modifiers : [];
            announce(frame, '按键 ' + [...modifiers, args.key].join('+'));
            frame.focus();
            const sent = await pressKey(frame, args.key, modifiers);
            await settle(frame, { budget: 10_000, grace: 300 });
            return { frame, text: `已按下 ${[...modifiers, args.key].join('+')}${sent.target ? ' → ' + sent.target : ''}${sent.synthetic ? SYNTHETIC_NOTE : ''}\n当前：${where(frame)}` };
          },

          async scroll(args, signal) {
            const { frame } = await ensureFrame(undefined, signal);
            announce(frame, args.ref !== undefined ? `滚动到 [${args.ref}]` : '滚动');
            let s = await run(frame, scrollScript(args.ref, args.dx, args.dy));
            if (s.stale) throw stale();
            let how = '';
            if (!s.moved && args.ref === undefined) {
              // The document itself does not scroll; wheel over the middle so the inner scroller under it moves.
              const r = frame.getBoundingClientRect();
              frame.sendInputEvent({ type: 'mouseWheel', x: Math.round(r.width / 2), y: Math.round(r.height / 2), deltaX: -(Number(args.dx) || 0), deltaY: -(args.dy ?? Math.round(r.height * 0.85)), canScroll: true });
              await sleep(250);
              how = '（页面内部容器滚动）';
            }
            s = await run(frame, `({ scrollY: Math.round(scrollY), scrollHeight: Math.round(document.documentElement.scrollHeight), vh: innerHeight })`);
            return { frame, text: `已滚动${how}，位置 ${s.scrollY}/${Math.max(0, s.scrollHeight - s.vh)}px` };
          },

          async select(args, signal) {
            const { frame } = await ensureFrame(undefined, signal);
            announce(frame, `选择 “${args.value}”`);
            const r = await run(frame, selectScript(args.ref, args.value));
            if (r.stale) throw stale();
            if (r.error) throw new Error(r.error);
            await settle(frame, { budget: 8_000 });
            return { frame, text: `已选择 “${r.selected}”\n当前：${where(frame)}` };
          },

          async wait(args, signal) {
            const { frame } = await ensureFrame(undefined, signal);
            if (args.text) {
              announce(frame, `等待 “${String(args.text).slice(0, 16)}”`);
              const budget = Math.min(60_000, Math.max(500, args.timeout ?? 15_000));
              const start = Date.now();
              while (Date.now() - start < budget && !signal.aborted) {
                const hit = await run(frame, textPresentScript(args.text)).catch(() => false);
                if (hit) return { frame, text: `已出现 “${args.text}”（${((Date.now() - start) / 1000).toFixed(1)}s）\n当前：${where(frame)}` };
                await sleep(400, signal);
              }
              throw new Error(`等待 ${Math.round(budget / 1000)} 秒后仍未出现 “${args.text}”。当前：${where(frame)}`);
            }
            const ms = Math.min(60_000, Math.max(0, args.ms ?? 1_000));
            announce(frame, `等待 ${(ms / 1000).toFixed(1)}s`);
            await sleep(ms, signal);
            return { frame, text: `已等待 ${ms}ms\n当前：${where(frame)}` };
          },

          async eval(args, signal) {
            const { frame } = await ensureFrame(undefined, signal);
            announce(frame, '执行脚本');
            const source = String(args.script ?? '');
            const serialize = (body) => `(async () => { const __v = await (async () => {\n${body}\n})(); try { return JSON.stringify(__v === undefined ? null : __v, null, 2); } catch { return String(__v); } })()`;
            const body = pickEvalBody(source);
            let result;
            if (body !== undefined) {
              // The body already parses, so the script runs exactly once.
              try { result = await run(frame, serialize(body)); }
              catch (error) { throw new Error('脚本出错：' + errorText(error)); }
            } else {
              // This window may not compile code to check syntax: only a parse failure (which runs nothing) earns a retry.
              try { result = await run(frame, serialize('return (\n' + source + '\n);')); }
              catch (error) {
                if (!/SyntaxError/.test(errorText(error))) throw new Error('脚本出错：' + errorText(error));
                try { result = await run(frame, serialize(source)); }
                catch (again) { throw new Error('脚本出错：' + errorText(again)); }
              }
            }
            return { frame, text: clip(String(result ?? 'null'), 20_000) };
          },
        };

        // ── Command loop: one command at a time, while the poll keeps listening. ──

        let chain = Promise.resolve();
        async function execute(command) {
          const signal = new AbortController().signal;
          let frame;
          let reply;
          try {
            const action = actions[command.action];
            if (action === undefined) throw new Error('未知操作：' + command.action);
            if (typeof command.sessionId !== 'string' || command.sessionId === '') throw new Error('浏览器工具只能在会话中调用');
            current = command.sessionId;
            // One stuck Electron call must not hold every later command hostage.
            const { frame: used, text, image } = await withTimeout(action(command.args ?? {}, signal), 70_000, '浏览器操作卡住，已放弃：' + command.action);
            frame = used;
            lastBySession.set(current, used);
            reply = { id: command.id, ok: true, value: { text, ...(image ? { image } : {}) } };
          } catch (error) {
            reply = { id: command.id, ok: false, error: errorText(error) };
          } finally {
            quiet(frame ?? lastFrame);
          }
          await fetch(endpoint('result'), {
            method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reply),
          }).catch(() => {});
        }

        ctx.effect(() => {
          const controller = new AbortController();
          const { signal } = controller;
          (async () => {
            while (!signal.aborted) {
              try {
                const response = await fetch(endpoint('poll'), { credentials: 'same-origin', cache: 'no-store', signal });
                if (response.status === 204) continue;
                if (!response.ok) { await sleep(3_000, signal); continue; }
                const command = await response.json();
                chain = chain.then(() => execute(command));
              } catch {
                if (!signal.aborted) await sleep(3_000, signal);
              }
            }
          })();
          return () => controller.abort();
        }, 'browser-use: command loop');
      },
    };
  },
});
