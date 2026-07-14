'use strict';

/**
 * Smoke test: confirms this environment can actually launch Chromium with
 * the unpacked MV3 extension loaded before any real e2e scenarios are
 * built on top of it. Not part of the regular test suite — run manually.
 */

const { launchExtension } = require('./launchExtension');

async function main() {
  console.log('Launching Chromium with the unpacked extension...');
  const { context, extensionId, worker } = await launchExtension({
    userDataDir: process.argv[2] || '.pw-profile',
  });

  console.log('Service worker registered. Extension ID:', extensionId);

  const popupUrl = `chrome-extension://${extensionId}/popup.html`;
  const page = await context.newPage();
  await page.goto(popupUrl);
  const title = await page.title();
  console.log('Popup loaded. Title:', title);

  const goalInput = await page.$('textarea, input[type="text"]');
  console.log('Goal input found:', !!goalInput);

  await context.close();
  console.log('Smoke test PASSED.');
}

main().catch((err) => {
  console.error('Smoke test FAILED:', err.message);
  process.exit(1);
});
