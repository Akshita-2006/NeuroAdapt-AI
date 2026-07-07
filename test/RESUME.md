Resume prompt — multi-page step accuracy work on NeuroAdapt-AI

Context: NeuroAdapt-AI is a Chrome extension (plain JS, Manifest V3) that walks a user through a goal in N steps by highlighting elements on the page, using Gemini for element identification. The reported bug: the step flow works well when a goal completes on one page, but accuracy drops when a goal's steps span multiple different pages (real navigation in between).

Two root causes were found and fixed in background.js / engine/llm.js:

1. Click-vs-navigation race condition (background.js). NA_ELEMENT_CLICKED used to wait a fixed 600ms after a click before re-ranking the page, regardless of whether the click triggered a real page navigation (frame destroyed/reloading) or a same-page SPA update. Fixed with `_navInFlight` + `_postClickTimer`, set/cleared by new `chrome.webNavigation.onBeforeNavigate` / `onErrorOccurred` listeners; `onCompleted` now also recovers from `waiting_for_human` (not just `navigating`), so a premature HITL fallback self-corrects once the destination page actually loads.

2. Sight-unseen step guesses (engine/llm.js, background.js). `generateSteps()`'s own prompt tells the LLM to guess targetLabel/alternatives for steps on "future pages" it has never seen. Added `refineStepForPage(apiKey, step, {pageUrl, pageTitle, pageContext})` in engine/llm.js, which re-grounds a step's targetLabel/alternatives against the real page once it's actually loaded. Wired into `executeCurrentStep()` in background.js: each step refines itself once (`_refined` flag on step metadata) the first time it executes, not tied to a specific navigation event — so if two steps land on the same new page, both still get grounded. Step 0 is marked pre-refined at SET_GOAL time since generateSteps() already grounds it in the real starting page's context.

A test harness was built to measure this without needing a real browser:
- `test/harness/domEngine.js` — runs the REAL engine/pruner.js + engine/ranker.js against jsdom, with getBoundingClientRect/innerText polyfilled (jsdom has no layout engine, so pruner.js's visibility checks need non-zero rects). Also mirrors content.js's NA_GET_PAGE_CONTEXT extraction (`buildPageContext`).
- `test/scenarios.js` — multi-page fixtures (login, signup, checkout) with deliberate decoy elements that share keywords with the correct target, so keyword-only matching can plausibly pick the wrong one.
- `test/runAccuracy.js` — for each step, compares the deterministic ranker's pick using the raw guessed label vs. the label after `refineStepForPage()`, isolating exactly what the fix changes. Makes real Gemini API calls (config.js key) for the refine step, paced ~15s apart.

Current status: BLOCKED on API quota, not on code. Every free-tier Gemini key tried today (including one on a different Google account) immediately returns HTTP 429 with `quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier, quotaValue: 20` — a 20-requests/day cap. It hit even on the very first call of a supposedly-separate account's key when run from this machine/network, which suggests possible IP-based throttling rather than a purely per-key/account limit — unconfirmed, just an observation. Deterministic-only results (no LLM, zero cost) were 5/7 = 71.4% on the adversarial fixtures; the 2 failures are exactly the class of case the LLM refine/identify stage exists to solve (a decoy's placeholder/label literally contains the guessed keyword, e.g. a newsletter box saying "email" next to an actual login field), but this hasn't been validated with a real, unthrottled key yet.

Next steps for whoever picks this up:
1. From a network/environment that isn't rate-limited, run `node test/runAccuracy.js` from the project root (needs a working Gemini API key in config.js — see config.example.js for the format).
2. Read the printed baseline vs. fixed pass rate and the "Remaining failures" list.
3. If refineStepForPage resolves the two known decoy cases (login-portal step 1, signup-account-type step 2) — the fix works as intended. If not, look at improving the refineStepForPage prompt in engine/llm.js (search for `refineStepForPage`) or add more page-context signal (e.g. surrounding form membership) to help the LLM disambiguate.
4. Feel free to add more scenarios to test/scenarios.js — same shape as existing entries (a `page` fixture, a `guessedStep` simulating a sight-unseen plan, and a `correctSelector`).
5. Iterate until satisfied with the pass rate, same as the original ask (rough target ~97%, not a hard requirement).

Constraint: do not add any Claude/Anthropic/AI-authorship attribution anywhere in this project — no code comments, console output, commit messages, or docs referencing AI authorship. Everything should read as the project owner's own work.
