'use strict';

/**
 * Drives the REAL production message-passing pipeline (content.js's NA_RANK
 * handler, exactly as background.js's rankAcrossFrames() calls it) against a
 * real, live production page's actual DOM. Not part of the regular test
 * suite — run manually, one site at a time, during the real-world QA pass.
 *
 * Content scripts run in an isolated JS world, invisible to Playwright's
 * page.evaluate() (which runs in the page's main world) — that's a Chrome
 * extension security boundary, not a bug. The correct way to reach the
 * content script is the same way the real extension does: message-passing
 * via chrome.tabs.sendMessage, issued from the background service worker's
 * own context (worker.evaluate()).
 *
 * Usage: node test/e2e/realSiteProbe.js <profileDir> <url> <hintsJson>
 *   hintsJson: JSON array of [hint, elementType, action] tuples, e.g.
 *   '[["Enter your username","input","type"],["Click login","button","click"]]'
 */

const { launchExtension } = require('./launchExtension');

async function rankViaRealPipeline(worker, url, hint, elementType, action) {
  return worker.evaluate(async ([url, hint, elementType, action]) => {
    const [tab] = await chrome.tabs.query({ url });
    if (!tab) return { error: 'tab not found' };
    // frameId: 0 explicitly targets the main frame, matching background.js's
    // real rankAcrossFrames() — without it, sendMessage can resolve to a
    // same-tab third-party iframe (ad frames, Partytown sandboxes, etc.)
    // instead of the page's own content, which is exactly the ambiguity the
    // real production fan-out logic (+ main-frame bonus) exists to resolve.
    const resp = await chrome.tabs.sendMessage(tab.id, {
      type: 'NA_RANK',
      targetHint: hint,
      tooltip: hint,
      minScore: 1, // probe every candidate's real score, don't pre-filter
      alternatives: [],
      elementType,
      preferredZone: null,
      action,
    }, { frameId: 0 });
    return {
      topLabel: resp.topLabel, topScore: resp.topScore, source: resp.source,
      ranked: resp.ranked,
    };
  }, [url, hint, elementType, action]);
}

async function main() {
  const [profileDir, url, hintsJson] = process.argv.slice(2);
  const hints = JSON.parse(hintsJson);

  const { context, worker } = await launchExtension({ userDataDir: profileDir });

  const page = await context.newPage();
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(4000); // let content scripts settle on heavier SPAs

  // Real sites often redirect (locale/flow params, etc.) — query by the
  // page's actual post-redirect URL, not the one originally navigated to.
  const finalUrl = page.url();
  console.log(`\n=== ${finalUrl} (real production NA_RANK pipeline) ===`);
  if (finalUrl !== url) console.log(`(redirected from ${url})`);

  for (const [hint, elementType, action] of hints) {
    const result = await rankViaRealPipeline(worker, finalUrl, hint, elementType, action);
    console.log(`\nHint: "${hint}" (elementType=${elementType}, action=${action})`);
    if (result.error) { console.log('  ERROR:', result.error); continue; }
    console.log('  Winner:', JSON.stringify(result.topLabel), `score=${result.topScore} source=${result.source}`);
    if (result.ranked) {
      for (const r of result.ranked.slice(0, 5)) {
        console.log(`    - ${JSON.stringify(r.label)} <${r.tag}> score=${r.score}`);
        console.log(`        ${(r.reasons || []).join(' | ')}`);
      }
    }
  }

  await context.close();
  console.log('\nreal-site probe DONE.');
}

main().catch((err) => {
  console.error('real-site probe FAILED:', err.message);
  process.exit(1);
});
