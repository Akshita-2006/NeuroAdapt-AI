'use strict';

/**
 * Measures the accuracy contribution of refineStepForPage() in isolation:
 *   - baseline: deterministic ranker's top pick using the raw sight-unseen guess
 *   - fixed:    deterministic ranker's top pick using the label refineStepForPage()
 *               grounds against the real page
 *
 * identifyElement()/validateSelection() (the LLM semantic-matching stage) are
 * pre-existing, unmodified code — not exercised here so this run stays within
 * the free-tier Gemini quota (1 LLM call per step instead of ~4).
 *
 * Makes real Gemini API calls using the key in config.js.
 */

const { buildPage, rankCandidates, buildPageContext } = require('./harness/domEngine');
const scenarios = require('./scenarios');

const MIN_CONFIDENCE = 25; // mirrors background.js

// The free-tier Gemini key allows very few requests/minute. Space every call
// well apart so a full run doesn't bounce off 429s.
const MIN_CALL_GAP_MS = 15000;
let _lastCallAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function paced(fn) {
  const wait = MIN_CALL_GAP_MS - (Date.now() - _lastCallAt);
  if (wait > 0) await sleep(wait);
  _lastCallAt = Date.now();
  return fn();
}

function deterministicWinner(rankResult) {
  const { topDeterministic } = rankResult;
  return topDeterministic
    ? { element: topDeterministic.node.element, score: topDeterministic.score }
    : { element: null, score: 0 };
}

async function main() {
  const { GEMINI_API_KEY } = await import('../config.js');
  const llm = await import('../engine/llm.js');
  const apiKey = GEMINI_API_KEY?.trim();
  if (!apiKey) {
    console.error('No Gemini API key in config.js — cannot run LLM-dependent accuracy tests.');
    process.exit(1);
  }

  const results = [];

  for (const scenario of scenarios) {
    console.log(`\n=== ${scenario.name} ===`);
    for (let i = 0; i < scenario.steps.length; i++) {
      const { page, guessedStep, correctSelector } = scenario.steps[i];
      const engine = buildPage(page);
      const correctEl = engine.document.querySelector(correctSelector);
      if (!correctEl) {
        throw new Error(`Fixture error: ${correctSelector} not found in ${scenario.name} step ${i + 1}`);
      }

      const baselineRank = rankCandidates(engine, guessedStep.targetLabel, guessedStep.alternatives, {
        elementType: guessedStep.elementType, preferredZone: guessedStep.zone, action: guessedStep.action,
      });
      const baseline = deterministicWinner(baselineRank);
      const baselinePass = baseline.element === correctEl && baseline.score >= MIN_CONFIDENCE;

      const pageContext = buildPageContext(engine.document);
      const refined = await paced(() => llm.refineStepForPage(apiKey, guessedStep, {
        pageUrl: page.url, pageTitle: page.title, pageContext,
      }));
      const fixedStep = refined ? { ...guessedStep, ...refined } : guessedStep;
      const fixedRank = rankCandidates(engine, fixedStep.targetLabel, fixedStep.alternatives, {
        elementType: fixedStep.elementType, preferredZone: fixedStep.zone, action: fixedStep.action,
      });
      const fixed = deterministicWinner(fixedRank);
      const fixedPass = fixed.element === correctEl && fixed.score >= MIN_CONFIDENCE;

      results.push({
        scenario: scenario.name, step: i + 1, baselinePass, fixedPass,
        guessedLabel: guessedStep.targetLabel,
        refinedLabel: refined ? refined.targetLabel : null,
      });

      console.log(
        `  Step ${i + 1}: guessed="${guessedStep.targetLabel}"` +
        (refined ? ` -> refined="${refined.targetLabel}"` : ' (refine: no confident match)')
      );
      console.log(
        `    baseline: ${baselinePass ? 'PASS' : 'FAIL'} (score=${baseline.score})` +
        `   fixed: ${fixedPass ? 'PASS' : 'FAIL'} (score=${fixed.score})`
      );
    }
  }

  const total = results.length;
  const baselineCount = results.filter((r) => r.baselinePass).length;
  const fixedCount = results.filter((r) => r.fixedPass).length;

  console.log('\n=== Summary ===');
  console.log(`Baseline (raw guess, no refine): ${baselineCount}/${total} = ${((100 * baselineCount) / total).toFixed(1)}%`);
  console.log(`Fixed (refineStepForPage applied): ${fixedCount}/${total} = ${((100 * fixedCount) / total).toFixed(1)}%`);

  const failing = results.filter((r) => !r.fixedPass);
  if (failing.length) {
    console.log('\nRemaining failures (fixed pipeline):');
    for (const f of failing) {
      console.log(`  - ${f.scenario} step ${f.step}: guessed="${f.guessedLabel}" refinedTo="${f.refinedLabel}"`);
    }
  }

  process.exitCode = fixedCount === total ? 0 : 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
