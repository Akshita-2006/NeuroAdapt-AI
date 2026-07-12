/**
 * NeuroAdapt Engine — Page Context Extractor
 *
 * Exposes: window.NeuroAdaptEngine.extractPageContext(doc)
 *
 * Extracts a compact summary of a page's visible headings/buttons/links/
 * inputs/tabs. Shared by two callers that need it to behave identically:
 *  - content.js (NA_GET_PAGE_CONTEXT), against the live rendered `document`.
 *  - offscreen.js, against a detached Document produced by DOMParser from
 *    prefetched HTML (see background.js's link-lookahead prefetch) — this
 *    document has no browsing context, so `getComputedStyle`/`innerText`
 *    (both layout-dependent) don't work on it. `isVisible()` degrades to
 *    "assume visible" and text extraction falls back to `textContent` in
 *    that case, which is the best a static-HTML analysis can do.
 */
window.NeuroAdaptEngine = window.NeuroAdaptEngine || {};

(() => {
  function isVisible(doc, el) {
    try {
      if (!doc.defaultView) return true; // detached document — no layout to check
      const s = doc.defaultView.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden';
    } catch { return true; }
  }

  function text(el) {
    return (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ');
  }

  function extractPageContext(doc = document) {
    const uniq = (arr) => [...new Set(arr.filter(Boolean))];

    const headings = uniq(
      [...doc.querySelectorAll('h1,h2,h3,[role="heading"]')]
        .map((el) => text(el).slice(0, 60))
    ).slice(0, 8);

    const buttons = uniq(
      [...doc.querySelectorAll(
        'button,[role="button"],input[type="submit"],input[type="button"],a[role="button"]'
      )]
        .filter((el) => isVisible(doc, el))
        .map((el) => (el.innerText || el.value || el.getAttribute('aria-label') || el.textContent || '')
          .trim().replace(/\s+/g, ' ').slice(0, 50))
        .filter((t) => t.length > 0 && t.length < 50)
    ).slice(0, 25);

    const links = uniq(
      [...doc.querySelectorAll('a[href]')]
        .filter((el) => isVisible(doc, el) && text(el).length > 0)
        .map((el) => text(el).slice(0, 50))
        .filter((t) => t.length > 1 && t.length < 50)
    ).slice(0, 20);

    const inputs = uniq(
      [...doc.querySelectorAll('input:not([type="hidden"]),textarea,select,[contenteditable="true"]')]
        .filter((el) => isVisible(doc, el))
        .map((el) => {
          const aria = el.getAttribute('aria-label')?.trim();
          if (aria) return aria;
          const ph = el.getAttribute('placeholder')?.trim() || el.getAttribute('data-placeholder')?.trim();
          if (ph) return ph;
          if (el.id) {
            try {
              const assoc = doc.querySelector(`label[for="${CSS.escape(el.id)}"]`);
              const t = assoc?.textContent?.trim().replace(/\s+/g, ' ');
              if (t && t.length < 60) return t;
            } catch { /* CSS.escape not available */ }
          }
          const wrap = el.closest('label');
          if (wrap) {
            const clone = wrap.cloneNode(true);
            clone.querySelectorAll('input,select,textarea').forEach((n) => n.remove());
            const t = clone.textContent?.trim().replace(/\s+/g, ' ');
            if (t && t.length < 60) return t;
          }
          const prev = el.previousElementSibling;
          if (prev?.tagName === 'LABEL') {
            const t = prev.textContent?.trim();
            if (t && t.length < 60) return t;
          }
          return el.getAttribute('name')?.replace(/[-_]/g, ' ').trim() || '';
        })
        .filter(Boolean)
    ).slice(0, 15);

    const tabs = uniq(
      [...doc.querySelectorAll('[role="tab"],[role="menuitem"]')]
        .filter((el) => isVisible(doc, el))
        .map((el) => (el.innerText || el.getAttribute('aria-label') || el.textContent || '')
          .trim().replace(/\s+/g, ' ').slice(0, 50))
        .filter((t) => t.length > 0 && t.length < 50)
    ).slice(0, 10);

    return { headings, buttons, links, inputs, tabs };
  }

  window.NeuroAdaptEngine.extractPageContext = extractPageContext;
})();
