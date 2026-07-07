/**
 * NeuroAdapt Engine — DOM Pruner (v4 — accuracy pass)
 *
 * Exposes: window.NeuroAdaptEngine.Pruner
 *
 * Every node now carries three additional fields used by the LLM for
 * high-accuracy element identification:
 *
 *  htmlSnippet    — sanitised outerHTML of the element (~200 chars).
 *                   Includes tag, type, aria-*, id, name, class names,
 *                   placeholder, href, and visible inner text.
 *                   The LLM can read an actual <button class="auth-btn">
 *                   Sign In</button> instead of fragmented key-value pairs,
 *                   which dramatically improves selection accuracy.
 *
 *  zone           — visual page zone: header | footer | main | nav |
 *                   sidebar | modal | content.
 *                   Lets the ranker and LLM prefer elements in the
 *                   correct region (e.g. login buttons are in headers,
 *                   submit buttons are in main content).
 *
 *  dataAttrs      — relevant data-* identifiers (data-testid, data-cy,
 *                   data-qa, data-action, data-label, …).
 *                   Modern apps often use these as their most stable
 *                   element identifiers — more reliable than visible text.
 *
 * All other changes from v3 are preserved.
 */

window.NeuroAdaptEngine = window.NeuroAdaptEngine || {};

(() => {

  // ── Actionable selectors ──────────────────────────────────────────────────
  const ACTIONABLE_SELECTORS = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[contenteditable="true"]',
    '[role="textbox"]',
    '[role="searchbox"]',
    '[role="button"]',
    '[role="link"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="menuitem"]',
    '[role="menuitemcheckbox"]',
    '[role="menuitemradio"]',
    '[role="tab"]',
    '[role="option"]',
    '[role="switch"]',
    '[role="treeitem"]',
    '[role="combobox"]',
    '[role="listbox"]',
    '[role="spinbutton"]',
    '[role="slider"]',
    '[role="gridcell"]',
    '[role="row"][tabindex]',
    '[tabindex]:not([tabindex="-1"])',
  ].join(',');

  // ── Shadow DOM deep query ─────────────────────────────────────────────────

  /**
   * querySelectorAll that pierces shadow DOM roots up to MAX_SHADOW_DEPTH levels.
   * Modern apps (YouTube, Shopify, many SPAs) use web components with shadow
   * roots — without this the pruner misses entire interactive trees.
   */
  const MAX_SHADOW_DEPTH = 4;

  function querySelectorAllDeep(root, selector, depth = 0) {
    const results = [];
    try {
      results.push(...root.querySelectorAll(selector));
      if (depth < MAX_SHADOW_DEPTH) {
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) {
            results.push(...querySelectorAllDeep(el.shadowRoot, selector, depth + 1));
          }
        }
      }
    } catch (_) { /* cross-origin or closed shadow root — skip */ }
    return results;
  }

  // ── Rendering check ───────────────────────────────────────────────────────

  function isRendered(el) {
    try {
      const style = window.getComputedStyle(el);
      if (style.display    === 'none')       return false;
      if (style.visibility === 'hidden')     return false;
      if (parseFloat(style.opacity) === 0)   return false;
      if (style.pointerEvents === 'none' &&
          !el.getAttribute('tabindex') &&
          el.tagName !== 'A' &&
          el.tagName !== 'BUTTON' &&
          el.getAttribute('role') !== 'button' &&
          el.getAttribute('role') !== 'link') return false;
    } catch (_) { return false; }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }

  // ── Label resolution ──────────────────────────────────────────────────────

  function resolveLabel(el) {
    // 1. aria-label (most explicit)
    const ariaLabel = el.getAttribute('aria-label')?.trim();
    if (ariaLabel) return ariaLabel;

    // 2. aria-labelledby — search in el's root (works inside shadow DOM too)
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const root = el.getRootNode?.() ?? document;
      const text = labelledBy
        .split(/\s+/)
        .map((id) => (root.getElementById?.(id) ?? document.getElementById(id))?.textContent?.trim())
        .filter(Boolean)
        .join(' ');
      if (text) return text;
    }

    // 3. value attribute — critical for input[type=submit|button|reset]
    //    Many "Sign In" buttons are <input type="submit" value="Sign In">
    const tag  = el.tagName.toLowerCase();
    const type = el.getAttribute('type')?.toLowerCase();
    if (tag === 'input' && ['submit','button','reset','image'].includes(type)) {
      const v = el.getAttribute('value')?.trim();
      if (v) return v;
    }

    // 4. <label for="id"> — search in el's root (works inside shadow DOM too)
    if (el.id) {
      try {
        const root = (el.getRootNode?.() ?? document);
        const associated = root.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        const t = associated?.textContent?.trim();
        if (t) return t;
      } catch (_) { /* CSS.escape or getRootNode not available */ }
    }

    // 5. Wrapping <label>
    const wrappingLabel = el.closest('label');
    if (wrappingLabel) {
      const clone = wrappingLabel.cloneNode(true);
      clone.querySelectorAll('input,select,textarea,button').forEach((n) => n.remove());
      const t = clone.textContent?.trim();
      if (t) return t;
    }

    // 6. Own visible text — checked BEFORE adjacent-sibling heuristics below.
    //    Buttons/links normally carry their own label as text content (e.g.
    //    <button>Skip for now</button>); bare <input>/<select>/<textarea>
    //    never have textContent, so this is a no-op for them and they still
    //    fall through to the adjacent-label rules that follow.
    const ownText = el.innerText?.trim().replace(/\s+/g, ' ').slice(0, 80) ||
                    el.textContent?.trim().replace(/\s+/g, ' ').slice(0, 80);
    if (ownText) return ownText;

    // 7. Adjacent preceding <label> sibling (common pattern: <label>Email</label><input>)
    const prevSib = el.previousElementSibling;
    if (prevSib?.tagName === 'LABEL') {
      const t = prevSib.textContent?.trim();
      if (t) return t;
    }

    // 8. Adjacent preceding text-carrying sibling (spans, divs used as labels)
    if (prevSib && ['SPAN','DIV','P','STRONG','B'].includes(prevSib.tagName)) {
      const t = prevSib.textContent?.trim().slice(0, 60);
      if (t && t.length < 50) return t; // short text only — long text is prose, not a label
    }

    // 10. title attribute
    const title = el.getAttribute('title')?.trim();
    if (title) return title;

    // 11. placeholder
    const placeholder = el.getAttribute('placeholder')?.trim();
    if (placeholder) return placeholder;

    // 12. alt (for image buttons)
    const alt = el.getAttribute('alt')?.trim() ||
                el.querySelector('img')?.getAttribute('alt')?.trim();
    if (alt) return alt;

    // 13. aria-describedby (less specific than labelledby, but still useful)
    const describedBy = el.getAttribute('aria-describedby');
    if (describedBy) {
      const text = describedBy
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent?.trim())
        .filter(Boolean)
        .join(' ');
      if (text) return text.slice(0, 80);
    }

    // 14. name attribute as last resort
    const name = el.getAttribute('name')?.replace(/[-_]/g, ' ').trim();
    if (name) return name;

    // 15. Semantic class names (absolute last resort — for icon buttons with no text)
    //     Converts "hamburger-menu" → "hamburger menu", "search-icon-btn" → filtered out.
    //     Skips generic UI framework / icon library classes.
    const GENERIC_CLASS = /^(css-|_|na-|btn|button|icon|fa-|fa |svg|img|ant-|mui|mdc-|material|mat-|mdi-|v-|el-|p-icon|feather|lucide|hero|bi-|ri-|ph-)/i;
    const semanticClass = [...el.classList]
      .filter((c) =>
        c.length > 5 &&                   // must be long enough to be semantic
        !GENERIC_CLASS.test(c) &&
        !c.match(/^[A-Z][a-z][A-Z]/) &&  // not CSS-in-JS hash
        !c.match(/^\d/) &&                // not numeric
        (c.includes('-') || c.includes('_')) // must have a word separator (not single word like "active")
      )
      .map((c) => c.replace(/[-_]/g, ' ').trim())
      .filter((c) => c.length > 5)
      .slice(0, 1)[0];
    if (semanticClass) return semanticClass;

    return '';
  }

  // ── Parent heading / section ──────────────────────────────────────────────

  function resolveParentHeading(el) {
    let node = el.parentElement;
    while (node && node !== document.body) {
      const heading = node.querySelector(
        ':scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > h5,:scope > h6'
      );
      if (heading) {
        const t = heading.textContent?.trim().slice(0, 50);
        if (t) return t;
      }
      const tag = node.tagName?.toLowerCase();
      if (['section','form','fieldset','nav','aside','article'].includes(tag)) {
        const sectionLabel = node.getAttribute('aria-label')?.trim();
        if (sectionLabel) return sectionLabel.slice(0, 50);
        const legend = node.querySelector(':scope > legend')?.textContent?.trim();
        if (legend) return legend.slice(0, 50);
      }
      node = node.parentElement;
    }
    return null;
  }

  // ── HTML snippet extractor ────────────────────────────────────────────────

  /**
   * Produce a compact, sanitised HTML representation of the element.
   * This gives the LLM actual markup to reason about — far more accurate
   * than fragmented label:"…" / aria:"…" key-value pairs, because it
   * preserves semantic class names, data attributes, and structure.
   *
   * Sanitisation strips: event handlers, inline styles, irrelevant attrs.
   * Keeps: tag, type, role, aria-*, id, name, placeholder, href, title,
   *        class (up to 3 semantic names), value, data-testid / data-cy /
   *        data-qa / data-action / data-label, visible inner text.
   */
  function extractHtmlSnippet(el) {
    const tag   = el.tagName.toLowerCase();
    const attrs = [];

    const KEEP_ATTRS = [
      'type','role','aria-label','aria-labelledby','id','name',
      'placeholder','href','title','for','value',
      'data-testid','data-cy','data-qa','data-test','data-action','data-label',
    ];
    for (const a of KEEP_ATTRS) {
      const v = el.getAttribute(a);
      if (v) attrs.push(`${a}="${v.slice(0, 60)}"`);
    }

    // Semantic class names (skip generated hash-like names, CSS modules, etc.)
    const semanticClasses = [...el.classList]
      .filter((c) =>
        c.length > 1 &&
        !c.match(/^(css-|_|[A-Z][a-z][A-Z])/) && // not CSS-in-JS hash
        !c.match(/^\d/)                             // not numeric
      )
      .slice(0, 4);
    if (semanticClasses.length) attrs.push(`class="${semanticClasses.join(' ')}"`);

    const attrStr = attrs.length ? ' ' + attrs.join(' ') : '';

    // Inner text capped: captures button labels, link text, etc.
    const inner = (el.innerText ?? el.textContent ?? '')
      .trim().replace(/\s+/g, ' ').slice(0, 70);

    const isVoid = ['input','br','hr','img','link','meta'].includes(tag);
    if (isVoid) return `<${tag}${attrStr} />`;
    return inner
      ? `<${tag}${attrStr}>${inner}</${tag}>`
      : `<${tag}${attrStr}></${tag}>`;
  }

  // ── Page zone classifier ──────────────────────────────────────────────────

  /**
   * Classify the element's page zone by walking up the DOM.
   * Zone is used by the ranker and LLM to prefer elements in expected regions
   * (login buttons are in headers, form submits are in main content, etc.).
   */
  function resolveZone(el) {
    let node = el.parentElement;
    while (node && node !== document.body) {
      const tag  = node.tagName?.toLowerCase() ?? '';
      const role = node.getAttribute?.('role') ?? '';
      const cls  = (node.className ?? '').toLowerCase();

      if (tag === 'header' || role === 'banner')                              return 'header';
      if (tag === 'footer' || role === 'contentinfo')                         return 'footer';
      if (tag === 'main'   || role === 'main')                                return 'main';
      if (tag === 'nav'    || role === 'navigation')                          return 'nav';
      if (tag === 'aside'  || role === 'complementary')                       return 'sidebar';
      if (
        role === 'dialog'       ||
        cls.includes('modal')   || cls.includes('dialog') ||
        cls.includes('overlay') || cls.includes('popup')  ||
        cls.includes('drawer')  || cls.includes('sheet')
      ) return 'modal';

      // Class-based navbar/appbar detection — covers Bootstrap .navbar,
      // Material .MuiAppBar, Tailwind sticky header patterns, etc.
      if (
        cls.includes('navbar')    || cls.includes('nav-bar')  ||
        cls.includes('appbar')    || cls.includes('app-bar')  ||
        cls.includes('topbar')    || cls.includes('top-bar')  ||
        cls.includes('toolbar')   || cls.includes('top-nav')  ||
        cls.includes('site-header') || cls.includes('page-header')
      ) {
        try {
          const style = window.getComputedStyle(node);
          if (style.position === 'fixed' || style.position === 'sticky') return 'header';
        } catch { /* getComputedStyle not available (non-Element) */ }
        return 'nav';
      }

      node = node.parentElement;
    }
    return 'content';
  }

  // ── Data-* attribute extractor ────────────────────────────────────────────

  /**
   * Extract relevant data-* attributes used as stable element identifiers.
   * Many modern apps (React, Angular, Vue, Cypress-tested) use data-testid,
   * data-cy, data-qa as their most reliable element handles. These are often
   * more accurate than visible text for intent matching.
   */
  const DATA_ATTR_ALLOWLIST = new Set([
    'data-testid','data-id','data-name','data-label','data-cy','data-qa',
    'data-test','data-action','data-track','data-component','data-section',
    'data-element','data-key','data-type','data-role',
  ]);

  function extractDataAttrs(el) {
    const result = {};
    for (const attr of el.attributes) {
      if (DATA_ATTR_ALLOWLIST.has(attr.name) && attr.value?.trim()) {
        result[attr.name] = attr.value.trim().slice(0, 80);
      }
    }
    return Object.keys(result).length ? result : null;
  }

  // ── Semantic role helper ──────────────────────────────────────────────────

  function _semanticRole(tag, type) {
    if (tag === 'button') return 'button';
    if (tag === 'a')      return 'link';
    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio')    return 'radio';
      if (type === 'submit' || type === 'button' || type === 'image') return 'button';
      if (type === 'search')   return 'searchbox';
      if (type === 'range')    return 'slider';
      if (type === 'number')   return 'spinbutton';
      return 'textbox';
    }
    if (tag === 'select')   return 'combobox';
    if (tag === 'textarea') return 'textbox';
    return tag;
  }

  // ── Data extraction ───────────────────────────────────────────────────────

  function extractData(el, index) {
    const rect = el.getBoundingClientRect();
    const tag  = el.tagName.toLowerCase();
    const type = el.getAttribute('type')?.toLowerCase() || null;
    const role = el.getAttribute('role') || _semanticRole(tag, type);

    const vh = window.innerHeight || document.documentElement.clientHeight;
    const vw = window.innerWidth  || document.documentElement.clientWidth;

    return {
      ref:           `na-el-${index}`,
      index,
      tag,
      type,
      role,
      id:            el.id                         || null,
      name:          el.getAttribute('name')       || null,
      label:         resolveLabel(el),
      ariaLabel:     el.getAttribute('aria-label') || null,
      placeholder:   el.getAttribute('placeholder')|| null,
      href:          el.getAttribute('href')        || null,
      value:         el.value != null ? String(el.value) : null,
      parentHeading: resolveParentHeading(el),
      htmlSnippet:   extractHtmlSnippet(el),        // NEW: compact sanitised HTML
      zone:          resolveZone(el),               // NEW: header|footer|main|nav|sidebar|modal|content
      dataAttrs:     extractDataAttrs(el),          // NEW: data-testid, data-cy, data-qa, etc.
      rect: {
        top:    Math.round(rect.top),
        left:   Math.round(rect.left),
        width:  Math.round(rect.width),
        height: Math.round(rect.height),
        bottom: Math.round(rect.bottom),
      },
      inViewport: (
        rect.top    < vh && rect.bottom > 0 &&
        rect.left   < vw && rect.right  > 0
      ),
      element: el, // raw DOM ref — never serialise over the message bus
    };
  }

  // ── Pruner class ──────────────────────────────────────────────────────────

  class Pruner {
    constructor() {
      this._tree = [];
      console.log('[NeuroAdapt] Pruner v4 ready (htmlSnippet + zone + dataAttrs).');
    }

    prune(root = document.body) {
      const t0    = performance.now();
      // Use deep query to pierce shadow DOM roots in web components
      const nodes = querySelectorAllDeep(root, ACTIONABLE_SELECTORS);
      const seen  = new Set(); // deduplicate by DOM element reference
      const tree  = [];
      let   index = 0;

      for (const el of nodes) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (!isRendered(el)) continue;
        tree.push(extractData(el, index++));
      }

      this._tree = tree;
      const elapsed = (performance.now() - t0).toFixed(1);
      const inView  = tree.filter((n) => n.inViewport).length;
      console.log(
        `[NeuroAdapt] Pruner: ${tree.length} elements ` +
        `(${inView} in viewport, ${tree.length - inView} below fold) in ${elapsed}ms`
      );
      return tree;
    }

    getTree()   { return this._tree; }

    serialise() {
      return this._tree.map(({ element: _el, ...rest }) => rest);
    }
  }

  window.NeuroAdaptEngine.Pruner = Pruner;
})();
