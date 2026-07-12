/**
 * NeuroAdapt AI — Offscreen document (hidden DOM parser)
 *
 * The only reason this document exists: background.js is a service worker
 * with no DOM, so it can't run DOMParser directly. This page is created on
 * demand via chrome.offscreen.createDocument() to parse prefetched page HTML
 * (fetched by background.js ahead of an anticipated navigation) into the same
 * compact page-context shape content.js reports for the live DOM — see
 * engine/pageContext.js, shared by both.
 *
 * Never navigates anywhere and never executes the fetched page's scripts —
 * DOMParser builds a detached, script-inert Document from the raw HTML text.
 */

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'NA_PARSE_HTML') return false;

  try {
    const parsed = new DOMParser().parseFromString(message.html ?? '', 'text/html');
    const ctx    = window.NeuroAdaptEngine.extractPageContext(parsed);
    sendResponse({ ok: true, pageTitle: parsed.title || '', ...ctx });
  } catch (err) {
    sendResponse({ ok: false, error: err.message });
  }

  return false; // handled synchronously
});
