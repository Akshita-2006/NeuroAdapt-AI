'use strict';

/**
 * Verifies engine/pageContext.js works correctly in BOTH contexts that call
 * it in production:
 *   - the live DOM (content.js's NA_GET_PAGE_CONTEXT, via the normal harness
 *     which polyfills getBoundingClientRect/innerText the way a real page does)
 *   - a detached, script-inert document (offscreen.js's NA_PARSE_HTML, parsing
 *     HTML fetched ahead of navigation by maybePrefetchNextStep() in
 *     background.js) — no polyfills, no defaultView, matching exactly what
 *     DOMParser().parseFromString() produces in a real browser.
 *
 * If these two ever disagree on the same HTML, the link-lookahead prefetch
 * would ground steps against a different page summary than the one the user
 * actually lands on — this test exists to catch that drift.
 */

const fs   = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { buildPage, buildPageContext } = require('./harness/domEngine');
const scenarios = require('./scenarios');

const PAGECTX_SRC = fs.readFileSync(path.join(__dirname, '../engine/pageContext.js'), 'utf8');

/** Mirrors offscreen.js: a bare, detached document — no rect/innerText polyfills. */
function extractViaDetachedParse(html) {
  const dom = new JSDOM(`<!DOCTYPE html><html><body>${html}</body></html>`, { runScripts: 'outside-only' });
  dom.window.eval(PAGECTX_SRC);
  return dom.window.NeuroAdaptEngine.extractPageContext(dom.window.document);
}

function main() {
  let failures = 0;
  let checks   = 0;

  for (const scenario of scenarios) {
    for (let i = 0; i < scenario.steps.length; i++) {
      const { page } = scenario.steps[i];
      const engine = buildPage(page);
      const live   = buildPageContext(engine.document);
      const prefetched = extractViaDetachedParse(page.html);

      for (const field of ['headings', 'buttons', 'links', 'inputs', 'tabs']) {
        checks++;
        const liveVals = live[field] ?? [];
        const preVals  = prefetched[field] ?? [];
        // Detached parse can't evaluate CSS visibility (no layout), so it may
        // include elements the live/rendered path would filter out as
        // display:none — none of the fixtures use that, so a strict
        // equality is the right bar here. If a future fixture legitimately
        // needs display:none coverage, relax this to a superset check.
        const same = liveVals.length === preVals.length &&
          liveVals.every((v, idx) => v === preVals[idx]);
        if (!same) {
          failures++;
          console.log(`FAIL ${scenario.name} step ${i + 1} [${field}]`);
          console.log(`  live:       ${JSON.stringify(liveVals)}`);
          console.log(`  prefetched: ${JSON.stringify(preVals)}`);
        }
      }
    }
  }

  console.log(`\n${checks - failures}/${checks} field-level checks agree between live DOM and detached-parse extraction.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main();
