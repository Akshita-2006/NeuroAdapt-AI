'use strict';

/**
 * Loads the unpacked extension in a real Chromium instance via Playwright.
 * Used by e2e smoke/scenario tests to drive the actual popup/background
 * pipeline against real pages, as a complement to the synthetic jsdom
 * harness in test/harness/domEngine.js (which only exercises engine/*.js).
 *
 * Headless is NOT supported here: verified directly in this environment
 * (multiple configurations — bundled Chromium and a real `channel: 'chrome'`
 * install, with and without `--headless=new`) that the MV3 background
 * service worker never registers under `headless: true`, even after
 * navigating a real page and waiting several seconds. The exact same setup
 * with `headless: false` registers the service worker immediately. This is
 * a headless-mode limitation for MV3 extensions, not an extension bug —
 * always launch headed.
 */

const path = require('path');
const { chromium } = require('playwright');

const EXTENSION_PATH = path.join(__dirname, '..', '..');

async function launchExtension({ userDataDir }) {
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
    ],
  });

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });

  const extensionId = worker.url().split('/')[2];

  return { context, extensionId, worker };
}

module.exports = { launchExtension, EXTENSION_PATH };
