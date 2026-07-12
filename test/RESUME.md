Resume prompt — multi-page step accuracy work on NeuroAdapt-AI

Context: NeuroAdapt-AI is a Chrome extension (plain JS, Manifest V3) that walks a user through a goal in N steps by highlighting elements on the page, using Gemini for element identification. The reported bug: the step flow works well when a goal completes on one page, but accuracy drops when a goal's steps span multiple different pages (real navigation in between).

Two root causes were found and fixed in background.js / engine/llm.js:

1. Click-vs-navigation race condition (background.js). NA_ELEMENT_CLICKED used to wait a fixed 600ms after a click before re-ranking the page, regardless of whether the click triggered a real page navigation (frame destroyed/reloading) or a same-page SPA update. Fixed with `_navInFlight` + `_postClickTimer`, set/cleared by new `chrome.webNavigation.onBeforeNavigate` / `onErrorOccurred` listeners; `onCompleted` now also recovers from `waiting_for_human` (not just `navigating`), so a premature HITL fallback self-corrects once the destination page actually loads.

2. Sight-unseen step guesses (engine/llm.js, background.js). `generateSteps()`'s own prompt tells the LLM to guess targetLabel/alternatives for steps on "future pages" it has never seen. Added `refineStepForPage(apiKey, step, {pageUrl, pageTitle, pageContext})` in engine/llm.js, which re-grounds a step's targetLabel/alternatives against the real page once it's actually loaded. Wired into `executeCurrentStep()` in background.js: each step refines itself once (`_refined` flag on step metadata) the first time it executes, not tied to a specific navigation event — so if two steps land on the same new page, both still get grounded. Step 0 is marked pre-refined at SET_GOAL time since generateSteps() already grounds it in the real starting page's context.

A test harness was built to measure this without needing a real browser:
- `test/harness/domEngine.js` — runs the REAL engine/pruner.js + engine/ranker.js against jsdom, with getBoundingClientRect/innerText polyfilled (jsdom has no layout engine, so pruner.js's visibility checks need non-zero rects). Also mirrors content.js's NA_GET_PAGE_CONTEXT extraction (`buildPageContext`).
- `test/scenarios.js` — multi-page fixtures (login, signup, checkout) with deliberate decoy elements that share keywords with the correct target, so keyword-only matching can plausibly pick the wrong one.
- `test/runAccuracy.js` — for each step, compares the deterministic ranker's pick using the raw guessed label vs. the label after `refineStepForPage()`, isolating exactly what the fix changes. Makes real Gemini API calls (config.js key) for the refine step, paced ~15s apart.

Update: the API quota block never lifted (still hits the free-tier 20-requests/day cap), but the two remaining failures turned out to be fixable without the LLM at all — they were ranker/pruner bugs, not missing semantic reasoning. Deterministic-only baseline is now 7/7 = 100% on `test/scenarios.js`. Fixed in `engine/ranker.js` and `engine/pruner.js`:

1. `TYPE_MAP.input`/`field` matched ANY `<input>` tag regardless of `type`, so a checkbox or submit button counted as a valid "input" target. Narrowed to exclude `checkbox/radio/submit/button/reset/image/file`.
2. `labelSimilarity()`'s "matched all content tokens via substring" case was scored identically to a true full-string label equality (`labelExact`, +50) — a decoy whose long unrelated label merely *contains* the hint keyword scored as if it were a perfect match. Split into a real `exact` flag (literal `node.label` === hint) vs. a `labelStrong` (+42) tier for substring-derived 1.0 similarity.
3. The type-keyword scoring (`email`/`phone`/`mobile`/`search`) was a hard match-or-penalize check, but plenty of legitimate login/username fields are `type="text"`, not literally `type="email"`. Reclassified those as "soft" keywords: matching still gives a bonus (halved), but not matching no longer incurs the `-10` wrong-type penalty — it falls back to `stepMeta.elementType`.
4. New `stepMeta.elementType` mismatch penalty (`metaTypePenalty`, -10) plus a `categoricalMismatch` gate: when a step's planned `action` is `"type"` and the candidate is structurally non-text-enterable (button/link/checkbox/radio), its label/aria credit is zeroed outright — a checkbox captioned "Email me weekly deals" is not an email field no matter what its label says. Gated specifically on `action === 'type'` (now threaded through content.js/background.js's NA_RANK message) rather than `elementType` alone, because `elementType: "input"` is also reported for checkbox/radio steps (`action: "check"/"select"`) and those must NOT be disqualified — verified with an added synthetic checkbox/"check"-action case so this doesn't regress.
5. `pruner.js` `resolveLabel()`: adjacent-sibling label heuristics (`<label>X</label><button>`) ran *before* checking the element's own visible text, so a `<button>Skip for now</button>` sitting right after an unrelated `<label>` inherited the label's text instead of its own. Own `innerText`/`textContent` is now checked first; bare inputs (no own text) still fall through to the sibling-label rules unaffected.
6. `labelSimilarity()`'s fuzzy fallback (`token.startsWith(w)`) had no minimum length on `w`, so single-letter stopwords like "a" (from "Pick a nickname") spuriously prefix-matched multi-letter content tokens like "address". Added a `w.length >= 3` floor.

Update 2 (this pass): resumed from the state above. Findings and fixes:

1. Added `test/runDeterministic.js` — runs the real ranker/pruner against every
   scenario's guessed label with zero LLM calls, so the deterministic baseline
   can be re-verified offline/instantly without touching Gemini quota. Confirmed
   the prior 7/7 = 100% claim.

2. Confirmed and fixed the checkbox-vs-textfield weakness flagged in next-step
   #2 above. Reproduced it with a synthetic case: a `check`-action step whose
   real target is a checkbox worded nothing like the hint ("Keep me posted"),
   next to a decoy plain-text `<input>` elsewhere on the page that happens to
   be captioned with the hint's *exact* words ("Email notifications"). The
   decoy won on label strength alone (exact-match +50 outweighing the existing
   -10 type-mismatch penalty). Root cause: `categoricalMismatch` in
   `engine/ranker.js` (the gate that zeroes out label/aria credit for
   structurally-impossible candidates) was scoped only to `action === 'type'`
   vs. non-text-enterable elements — there was no equivalent hard gate for a
   `checkbox`/`radio`/`select` step landing on a node that just isn't one,
   regardless of action. Added `STRUCTURAL_ELEMENT_TYPES` (checkbox, radio,
   select, dropdown) and folded a second, action-independent check into
   `categoricalMismatch`: if the step wants one of those and the node fails
   the corresponding `TYPE_MAP` check, its label credit is zeroed exactly like
   the type-action case. Added scenario `notification-prefs-checkbox` to
   `test/scenarios.js` to lock this in. Deterministic baseline is now
   8/8 = 100%.

3. Bigger find: `identifyElement`, `refineStepForPage`, and `validateSelection`
   in `engine/llm.js` all pass a Gemini `thinkingConfig.thinkingBudget` that is
   larger than (or too close to) their `maxOutputTokens`. Thinking tokens are
   NOT a separate budget from `maxOutputTokens` on this API/model — they draw
   from the same pool as the final answer. Confirmed live: a `refineStepForPage`
   call returned `finishReason:"MAX_TOKENS"` with `thoughtsTokenCount:284` out
   of a 300-token cap, leaving 12 tokens for the answer — the JSON was cut off
   mid-string (`{"match":true,"targetLabel` with no closing), so `findJson()`
   always failed and the function always silently returned null. This means
   the LLM semantic-matching stage had likely never actually contributed a
   successful correction in practice — every call quietly degraded to "no
   confident match" and fell back to the deterministic ranker, masked by the
   fact that the deterministic baseline is already 100% on these fixtures.
   `identifyElement` had the worst ratio (`maxOutputTokens:200` vs.
   `thinkingBudget:1024` — thinking alone exceeds the whole cap). Fixed by
   giving each call generous headroom above its thinking budget:
   `identifyElement` 200→1536, `generateSteps` 1200→2048, `refineStepForPage`
   300→900, `validateSelection` 200→800. Live-verified after the fix with two
   direct calls (a `type`-action step and a `click`-action step, both against
   fixtures already in `test/scenarios.js`): both now return `match:true` with
   the real page's exact label instead of truncating.

4. Added `shipping-speed-decoy` to `test/scenarios.js` — the one fixture
   (of 9 total now) where the deterministic baseline is *expected* to fail:
   "Get it in 5 days" fuzzy-matches "day"/"days" from the "Next day delivery"
   alternative and wins the keyword ranking (score 57) outright over the
   actually-correct "Get it tomorrow", which shares no keyword with the guess
   or any alternative at all. Confirmed via direct `refineStepForPage` probe
   (not the full paced suite, to conserve quota — see below) that it correctly
   grounds the guess to "Get it tomorrow" given the real page's button list,
   and that re-ranking with the corrected label lands on the right element
   (score 76). `test/runDeterministic.js` now reports 8/9 = 88.9% — this is
   the expected, intentional number; the shortfall is exactly the gap
   `refineStepForPage` exists to close, not a regression.

5. Did not re-run the full paced `test/runAccuracy.js` battery after the
   token-budget fix or after adding `shipping-speed-decoy`, to conserve the
   free-tier daily call quota (already spent ~13 calls today across the
   earlier full run and this pass's probes, against a 20/day cap). The
   targeted probes above (one per scenario type: type-action, click-action,
   and the genuinely-hard decoy case) are strong evidence the fix is correct;
   a full battery run is still worth doing once quota resets, expecting
   9/9 = 100% "fixed" against the intentional 8/9 baseline.

Update 3: the user's real-world complaint after testing the extension — it
handles a single direct task fine but is "unclear" on further/multi-page
tasks — pointed at the same root gap Update 1/2 partially addressed: every
step beyond the first is still only grounded *reactively*, after the user has
already navigated to its page. Requested feature: let the assistant "see the
next webpage" before navigating there, the way a person would preview a link
before clicking it. Added a genuine lookahead, not just a faster reactive path:

1. `engine/pageContext.js` (new) — the page-context extraction logic that used
   to live inline in content.js's `NA_GET_PAGE_CONTEXT` handler (and was
   separately duplicated in `test/harness/domEngine.js`'s `buildPageContext`)
   is now one shared `window.NeuroAdaptEngine.extractPageContext(doc)`. Two
   production callers need it to behave identically on different kinds of
   `doc`: content.js (live rendered `document`) and the new offscreen parser
   below (a detached, unrendered `Document`) — so `isVisible()` degrades to
   "assume visible" and text extraction falls back to `textContent` when
   `doc.defaultView` is null (no layout to query), which is exactly what a
   detached document gives you. `test/harness/domEngine.js`'s
   `buildPageContext` is now a one-line wrapper calling the real file instead
   of a third copy of the same logic.

2. `offscreen.html` / `offscreen.js` (new) — a Chrome MV3 offscreen document
   (`reasons: ['DOM_PARSER']`). Exists solely because the background service
   worker has no DOM and can't run `DOMParser` itself; this hidden page loads
   `engine/pageContext.js` and, on an `NA_PARSE_HTML` message, parses raw HTML
   text into a detached `Document` and returns `extractPageContext()`'s
   result. Never executes the fetched page's scripts and never becomes a
   visible tab — `DOMParser` output is inert markup only.

3. `background.js`: `prefetchPageContext(url)` — validates the URL is
   http(s), `fetch()`s it with `credentials: 'omit'` (no cookies sent/read,
   same privacy posture as a browser's anchor prefetch), bails if the
   response isn't HTML, hands the raw text to the offscreen document via
   `ensureOffscreenDocument()` + `chrome.runtime.sendMessage`, 6s timeout.
   Returns null on any failure — network error, non-HTML, timeout, or a
   heavily JS-rendered destination with nothing meaningful in the raw markup
   (expected and fine: the existing *reactive* `refineStepForPage`, run after
   real navigation completes, remains the fallback of record for those).

4. `background.js`: `maybePrefetchNextStep(fromIndex, expectedGoal, href)` —
   called (fire-and-forget, never awaited) right after `STEP_FOUND` when
   `content.js` reports the just-highlighted element is a link with a
   resolvable `href` (new `topHref` field on the `NA_RANK` response, set in
   content.js only when `winNode.tag === 'a'` and its resolved URL is
   http(s)). Prefetches step N+1's destination and runs the existing
   `refineStepForPage` against it *before* the user clicks — so by the time
   real navigation happens and `executeCurrentStep()` reaches that step, it's
   already `_refined` and skips the reactive round-trip entirely, landing on
   the correct element instantly instead of doing a multi-second grounding
   call after the page loads. Guards against staleness (goal cancelled/
   replaced, step already refined by the reactive path first, or already
   attempted) by re-checking `STATE` before applying the patch — the
   underlying race is real (fetch + LLM call takes long enough that state can
   move on) but harmless: worst case the prefetch result is silently
   discarded and the reactive fallback still runs.
   Only fires for link-based steps — button/form-submit steps never have a
   knowable destination before they're actually clicked, so those are
   unaffected and still rely solely on the reactive path from Update 1/2.

5. `REFINE_STEP` transition generalized to take an explicit `payload.stepIndex`
   (defaults to `STATE.currentStepIndex`, preserving the existing reactive call
   site unchanged) so the prefetch path can patch a *future* step's metadata
   while the user is still on the current one.

6. `test/runPrefetchContext.js` (new) — for every scenario fixture, extracts
   page context two ways from the identical HTML: through the normal harness
   (live jsdom `document`, mirrors content.js) and through a bare, detached
   jsdom parse with none of the harness's rect/innerText polyfills (mirrors
   exactly what `DOMParser` produces for the offscreen path). Asserts all five
   fields (`headings`/`buttons`/`links`/`inputs`/`tabs`) agree — 45/45 pass.
   This is the test that would catch the lookahead ever grounding a step
   against a different page summary than the one the user actually lands on.

What this does NOT do, by design: it never opens a visible tab, never runs the
destination's JavaScript, and never touches cookies for the prefetched origin
(`credentials:'omit'`) — so it can't trigger side effects (analytics counted as
a real visit, session/cart mutation, CSRF-guarded actions) the way opening a
real hidden tab would have. The tradeoff is real: heavily client-rendered
destinations (SPA routes whose content only exists after JS runs) yield little
or nothing from a raw-HTML fetch, so the lookahead is a no-op there and the
existing reactive refine (Update 1/2) is what actually saves those cases.

Not yet done / needs a real browser: I cannot drive an actual Chrome instance
from this environment, so everything above is verified at the unit level
(engine/pageContext.js extraction parity, syntax checks, deterministic ranker
suite still 8/9 as before) but NOT end-to-end inside the extension. Before
trusting this in production, someone needs to: load the unpacked extension,
run a multi-page goal whose steps are genuinely link-based (not button/submit)
across a couple of real multi-page sites, and confirm via the service worker
console that `[NeuroAdapt] Prefetching step N's destination` logs appear and
that the corresponding step lands instantly (no visible grounding delay) once
navigated to. Also worth confirming `chrome.offscreen` behaves as expected
across repeated goals in one browser session (the singleton document should
persist and get reused, not recreated every time — `ensureOffscreenDocument()`
checks `hasDocument()` first, but this hasn't been exercised against real
back-to-back goals).

Update 4: the user reported that even after Update 3's lookahead, multi-step
goals still "don't work" in real testing. That's a strong signal the actual
bug was never in the ranking/grounding logic at all (which the offline test
suite already exercises thoroughly) but somewhere the test suite structurally
*can't* reach: MV3 service worker lifecycle. Re-audited background.js end to
end with that lens and found two real, previously-undiagnosed bugs, both in
the category "silently hangs forever on some multi-page flows, invisible to
any Node-based test because there's no service worker to evict in Node":

1. **STATE-restoration race on service worker wake-up.** `restoreState()`
   (reads `STATE` back from `chrome.storage.session`) was only ever called
   fire-and-forget at the very bottom of the file, with nothing awaiting it.
   MV3 kills this service worker after ~30s idle and spins up a fresh
   instance — with `STATE` back at `DEFAULT_STATE` (`tabId: null`) — the next
   time an event needs delivering. A real multi-page goal routinely leaves
   more than 30s of idle time between steps (real network latency, the user
   actually reading the page), and the event most likely to wake a dead
   worker is exactly `chrome.webNavigation.onCompleted` — the "navigation
   finished, re-run the step" signal. If that listener fires before
   `restoreState()` resolves, `STATE.tabId !== tabId` reads `null !== tabId`,
   the guard bails, and the signal is dropped for good — the goal just hangs
   on that step with no further sign of life, no error, nothing. Fixed by
   capturing `restoreState()`'s promise once (`const _stateReady = ...`) and
   adding `await _stateReady;` as the first STATE-dependent line in every
   listener that reads `STATE` before anything else can run: the main
   `chrome.runtime.onMessage` handler and all three `chrome.webNavigation`
   listeners (`onBeforeNavigate`, `onErrorOccurred`, `onCompleted`).

2. **HITL click delivery tied to a single long-lived promise.** The
   human-in-the-loop fallback ("I can't find it, please click it for me")
   armed the content script's click capture via
   `chrome.tabs.sendMessage(tabId, {type:'NA_CAPTURE_CLICK'}).then(clickResult => {...})`
   — and that `.then()` callback, living only in the specific service worker
   execution that issued the call, didn't run until the content script called
   `sendResponse()` on the *user's actual click*, which by design can be an
   arbitrarily long wait. That's exactly the kind of gap MV3 evicts a worker
   during. Once evicted, the eventual click's response has no execution
   context left to deliver to — Chrome doesn't (and can't) resume a specific
   dead worker's in-flight closure — so the click silently vanishes and the
   goal stays stuck on `waiting_for_human` forever, even though the user did
   exactly what was asked. Fixed by decoupling "capture is armed" from "the
   click happened": `NA_CAPTURE_CLICK`'s response now fires immediately on
   arming (content.js), and the actual click is reported through its own
   fresh, independent `NA_HITL_CLICKED` message — handled by the persistent
   `onMessage` listener (now itself covered by fix #1's `_stateReady` guard),
   which works correctly no matter how many service worker restarts happened
   during the wait or how long the user took to click.

Both bugs share the same signature and explain the user's report precisely:
single-page/direct tasks complete fast enough that the service worker rarely
goes idle mid-flow, so neither bug fires; any multi-page goal has natural gaps
(real navigation time, HITL waits, or just a user pausing to read a page)
long enough to trigger eviction, at which point the flow can silently stall
with zero error output — which reads exactly as "multi step things don't
work," not as a ranking/accuracy problem, which is why Updates 1–3 (all
correct, all still worth having) didn't resolve it.

These can't be exercised by the existing Node-based test suite at all — there
is no service worker, no eviction, no `chrome.*` APIs to simulate in Node.
Confirmed by full read-through and manual trace of every `STATE` read against
every listener registration order instead. Real-browser verification is
required (see Update 3's same caveat, now doubly true): load the unpacked
extension, run a multi-page goal with deliberate gaps between steps (e.g. wait
30–60s after a step highlights before clicking, long enough to plausibly evict
the worker), and confirm the flow still advances correctly on the next click —
plus specifically test the HITL path with a similar delay before clicking the
fallback-prompted element.

Update 5: real-world test on WhatsApp Web surfaced two more issues, neither of
which is a ranking-accuracy problem — one is a UX/honesty problem, the other
is a genuine SPA-specific instability bug the scenario fixtures can't catch
(they're all traditional multi-page sites, not continuously-live apps):

1. **"It made assumptions about what's in the menu."** The side panel's step
   list (`sidepanel.js` `renderSteps()`) shows every step up front, including
   ones generateSteps() had to guess sight-unseen (e.g. what's inside a menu
   that hasn't been opened yet) — and showed them with the exact same plain
   styling as confirmed steps, reading as asserted fact rather than a guess
   pending confirmation. Fixed at the presentation layer (no change to the
   planning/ranking pipeline): steps beyond the current one that aren't yet
   `_refined` now render in `sidepanel.js`/`styles/sidepanel.css` with a
   distinct "?" marker, italics, and a "(to be confirmed)" suffix, so an
   unconfirmed guess never looks the same as a grounded step. Also tightened
   `generateSteps()`'s prompt in `engine/llm.js`: future/unseen steps must now
   phrase `hint` around the user's intent rather than asserting a specific
   invented UI string, prefer common/recognizable terms over invented ones,
   and give 4 alternatives instead of 2 — all to raise the odds the eventual
   real-page grounding (reactive refine or lookahead prefetch) actually finds
   a match rather than needing to fully override a narrow bad guess.
   Caveat: `_refined` means "a grounding attempt was made," not "grounding
   succeeded" — refineStepForPage sets it even when it returns no match (so
   it doesn't retry forever on an ungroundable page). A step whose refine
   attempt genuinely failed (e.g. truly empty page context) will still show
   as "confirmed" once it becomes current, even though it's still the
   original guess. Distinguishing "attempted" from "succeeded" would need
   refineStepForPage to report that back explicitly — noted below, not done
   this pass.

2. **"Shaking decisions at the start."** WhatsApp Web mutates its DOM
   continuously (chat list, message previews, presence indicators, timestamps
   — none of it related to whatever element the assistant is looking for).
   The `NA_TREE_UPDATED` handling (content.js's `MutationObserver` callback,
   background.js's debounced retry) re-ran the *entire* rank on every batch of
   mutations any time `status === 'navigating'`, with no check for whether a
   confident target had already been found and highlighted. On a page that
   never stops mutating, this meant continuously re-deciding — and since the
   ranker's scoring (duplicate-label penalties, prominence, viewport
   position) shifts as the DOM keeps changing, different mutation batches
   could rank a different candidate on top each time, visibly flickering the
   highlight between choices even after the right element had already been
   found and was just waiting for the user to click it. Fixed with a targeted
   staleness check instead of a blanket suppression (which would have broken
   legitimate re-ranking when a target genuinely gets removed by an SPA
   re-render): `engine/highlighter.js` gained `isStable()` — true only when
   something is currently highlighted AND it's still actually attached to the
   DOM. `content.js`'s `MutationObserver` callback now checks
   `highlighter.isStable()` before notifying background.js at all; still
   re-prunes the tree either way (cheap, keeps it fresh for the next real
   rank) but only requests a re-rank when there's genuinely nothing stable
   yet — no target found, or the previous target just got removed.

Neither of these can be exercised by `test/scenarios.js` as it stands — every
fixture is a static multi-page flow, not a continuously-mutating single-page
app. If WhatsApp-style targets become a common case, a scenario harness that
fires repeated *unrelated* DOM mutations (e.g. append/remove decoy nodes with
a timer) after a confident match to assert the highlight target doesn't
change would directly cover fix #2 — worth adding.

Next steps for whoever picks this up:
1. Re-run `node test/runAccuracy.js` with fresh quota to get the full battery's
   verdict in one shot: baseline should read 8/9 (matching runDeterministic.js),
   fixed should read 9/9 now that refineStepForPage both (a) doesn't regress the
   8 already-correct guesses and (b) actually rescues shipping-speed-decoy.
2. The same maxOutputTokens/thinkingBudget class of bug is worth double-checking
   in any future function added to `engine/llm.js` that turns on `thinkingConfig`
   — the rule is: `maxOutputTokens` must comfortably exceed `thinkingBudget`
   plus the expected answer length, since they share one pool.
3. Feel free to add more scenarios to test/scenarios.js — same shape as existing
   entries (a `page` fixture, a `guessedStep` simulating a sight-unseen plan,
   and a `correctSelector`). Give new fixtures neutral ids/names (e.g. "opt-a",
   "field-b") unless testing id/name-based matching specifically — a
   descriptive id (e.g. "express-shipping") leaks the answer into
   labelSimilarity's id/name text and silently invalidates the test.
4. Do the real-browser verification pass described above for the link-lookahead
   prefetch feature — this is the one piece of Update 3 that only a live
   Chrome session can confirm.
5. Consider extending the lookahead beyond same-tab `<a href>` steps: multi-step
   flows that go through a button/form submit to an unknowable destination get
   no head start today. If that becomes the common case in practice, an
   alternative worth weighing is prefetching via a real hidden background tab
   (`chrome.tabs.create({active:false})`) instead of a raw fetch, trading the
   side-effect risk (cookies, analytics, executing the destination's JS) for
   coverage of button-triggered and JS-rendered navigations — should be an
   explicit, opt-in tradeoff, not a silent default.
6. **Highest priority**: do the real-browser verification pass described in
   Update 4 for the two service-worker-lifecycle fixes (STATE-restoration race,
   HITL click decoupling) — deliberately test with gaps of 30-60+ seconds
   between a step highlighting and clicking it, since that's the exact window
   that was previously silently losing progress. This is very plausibly the
   actual explanation for "multi-step doesn't work" and can't be confirmed by
   the Node-based test suite at all — it needs a live extension in Chrome with
   the service worker actually going idle and restarting mid-goal. Open
   `chrome://extensions` → the service worker's "Inspect views" link to watch
   its console across the restart.
7. Verify fix #2 from Update 5 (the "shaking" fix) on WhatsApp Web itself or
   a similarly noisy SPA — confirm the highlight now stays put on an already-
   found target while the rest of the page keeps updating around it, and that
   legitimate cases (target actually removed by a re-render) still recover.
8. Consider having `refineStepForPage` distinguish "attempted, no match found"
   from "attempted and succeeded" (e.g. always set `_refined: true` but add a
   separate `_grounded: true` only on an actual match), so the sidepanel's
   "(to be confirmed)" marker in Update 5 can stay accurate even when a
   refine attempt silently failed instead of just tracking whether an attempt
   was made.
9. Consider a scenario harness for continuously-mutating pages (append/remove
   unrelated decoy DOM nodes on a timer after a confident match) to directly
   cover the Update 5 "shaking" fix — not currently possible with the static
   multi-page fixtures in test/scenarios.js.

Constraint: do not add any Claude/Anthropic/AI-authorship attribution anywhere in this project — no code comments, console output, commit messages, or docs referencing AI authorship. Everything should read as the project owner's own work.
