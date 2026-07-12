'use strict';

/**
 * Test-only harness that runs the REAL engine/pruner.js + engine/ranker.js
 * against synthetic multi-page fixtures in jsdom, so accuracy tests exercise
 * production ranking/matching logic instead of a reimplementation of it.
 *
 * jsdom has no layout engine — every element's getBoundingClientRect() is
 * zero by default, which would make pruner.js's isRendered() (requires
 * rect.width > 0 || rect.height > 0) drop every element. getBoundingClientRect
 * is patched below to assign each element a synthetic, monotonically
 * increasing position so visibility/inViewport checks behave sensibly.
 * jsdom also doesn't implement innerText (layout-dependent); it's polyfilled
 * as an alias for textContent, which is enough for flat-text fixtures.
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const PRUNER_SRC  = fs.readFileSync(path.join(__dirname, '../../engine/pruner.js'), 'utf8');
const RANKER_SRC  = fs.readFileSync(path.join(__dirname, '../../engine/ranker.js'), 'utf8');
const PAGECTX_SRC = fs.readFileSync(path.join(__dirname, '../../engine/pageContext.js'), 'utf8');

function buildPage({ html, url = 'https://example.test/', title = '' }) {
  const dom = new JSDOM(`<!DOCTYPE html><html><head><title>${title}</title></head><body>${html}</body></html>`, {
    url,
    runScripts: 'outside-only',
  });
  const { window } = dom;

  if (!Object.getOwnPropertyDescriptor(window.HTMLElement.prototype, 'innerText')) {
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
      get()  { return this.textContent; },
      set(v) { this.textContent = v; },
      configurable: true,
    });
  }

  let rectCounter = 0;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.__naRectIndex == null) this.__naRectIndex = rectCounter++;
    const top = this.__naRectIndex * 40;
    return { top, left: 10, right: 210, bottom: top + 30, width: 200, height: 30, x: 10, y: top, toJSON() {} };
  };
  window.innerHeight = 4000;
  window.innerWidth  = 1200;

  window.eval(PRUNER_SRC);
  window.eval(RANKER_SRC);
  window.eval(PAGECTX_SRC);

  const pruner = new window.NeuroAdaptEngine.Pruner();
  const ranker = new window.NeuroAdaptEngine.TargetRanker();

  return { window, document: window.document, pruner, ranker, url, title };
}

/**
 * Mirrors content.js's NA_RANK handler: multi-hint expansion (targetHint +
 * alternatives, merged by best score per element) plus the viewport/fallback
 * pools when keyword scoring finds nothing. Returns candidates in both a
 * serialised form (matches what production sends over the message bus, for
 * feeding identifyElement/refineStepForPage) and a ref->element map (test-only,
 * to verify which real DOM node a ref ultimately resolved to).
 */
function rankCandidates({ pruner, ranker }, targetHint, alternatives = [], stepMeta = {}) {
  const tree = pruner.prune();
  const allHints = [targetHint, ...alternatives.slice(0, 3)].filter(Boolean);
  const merged = new Map();
  for (const h of allHints) {
    for (const { node, score } of ranker.rank(tree, h, stepMeta)) {
      const cur = merged.get(node.ref);
      if (!cur || score > cur.score) merged.set(node.ref, { node, score });
    }
  }
  let candidates = [...merged.values()].sort((a, b) => b.score - a.score).slice(0, 30);

  if (!candidates.length) {
    candidates = tree
      .filter((n) => n.inViewport)
      .slice(0, 25)
      .map((n) => ({ node: n, score: 0 }));
  }
  if (!candidates.length) {
    candidates = tree.slice(0, 20).map((n) => ({ node: n, score: 0 }));
  }

  const refToElement = new Map(candidates.map(({ node }) => [node.ref, node.element]));

  const serialised = candidates.map(({ node, score }) => ({
    ref: node.ref, tag: node.tag, type: node.type, role: node.role,
    label: node.label, ariaLabel: node.ariaLabel, placeholder: node.placeholder,
    name: node.name, id: node.id, href: node.href, parentHeading: node.parentHeading,
    htmlSnippet: node.htmlSnippet ?? null, zone: node.zone ?? null,
    dataAttrs: node.dataAttrs ?? null, rect: node.rect, inViewport: node.inViewport,
    score,
  }));

  return { serialised, refToElement, topDeterministic: candidates[0] ?? null };
}

/**
 * Runs the REAL engine/pageContext.js against the harness's jsdom document —
 * same production code content.js's NA_GET_PAGE_CONTEXT handler calls, and
 * the same one offscreen.js calls against prefetched HTML (see
 * maybePrefetchNextStep() in background.js), so this one function's test
 * coverage backs both the live-DOM and link-lookahead-prefetch paths.
 */
function buildPageContext(document) {
  return document.defaultView.NeuroAdaptEngine.extractPageContext(document);
}

module.exports = { buildPage, rankCandidates, buildPageContext };
