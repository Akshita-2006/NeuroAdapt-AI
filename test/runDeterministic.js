'use strict';

/**
 * Deterministic-only accuracy pass: runs the real ranker/pruner against
 * every scenario's guessedStep (the sight-unseen label) with no LLM calls
 * at all. Isolates the ranker/pruner fixes from refineStepForPage/identifyElement
 * so this can run offline, instantly, and without touching Gemini quota.
 */

const { buildPage, rankCandidates } = require('./harness/domEngine');
const scenarios = require('./scenarios');

const MIN_CONFIDENCE = 25; // mirrors background.js

function main() {
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

      const rank = rankCandidates(engine, guessedStep.targetLabel, guessedStep.alternatives, {
        elementType: guessedStep.elementType, preferredZone: guessedStep.zone, action: guessedStep.action,
      });
      const { topDeterministic } = rank;
      const winnerEl = topDeterministic ? topDeterministic.node.element : null;
      const winnerScore = topDeterministic ? topDeterministic.score : 0;
      const pass = winnerEl === correctEl && winnerScore >= MIN_CONFIDENCE;

      results.push({ scenario: scenario.name, step: i + 1, pass, winnerScore, correctSelector });

      const winnerDesc = winnerEl
        ? `<${winnerEl.tagName.toLowerCase()}${winnerEl.id ? `#${winnerEl.id}` : ''}>`
        : '(none)';
      console.log(
        `  Step ${i + 1}: guessed="${guessedStep.targetLabel}" action=${guessedStep.action}` +
        ` -> picked ${winnerDesc} score=${winnerScore} want=${correctSelector} :: ${pass ? 'PASS' : 'FAIL'}`
      );
    }
  }

  const total = results.length;
  const passCount = results.filter((r) => r.pass).length;

  console.log('\n=== Summary ===');
  console.log(`Deterministic-only baseline: ${passCount}/${total} = ${((100 * passCount) / total).toFixed(1)}%`);

  const failing = results.filter((r) => !r.pass);
  if (failing.length) {
    console.log('\nFailures:');
    for (const f of failing) {
      console.log(`  - ${f.scenario} step ${f.step}: wanted ${f.correctSelector}, score=${f.winnerScore}`);
    }
  }

  process.exitCode = passCount === total ? 0 : 1;
}

main();
