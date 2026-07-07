/**
 * NeuroAdapt AI — Background Service Worker (v2)
 *
 * Owns the single source of truth for navigation state and acts as the
 * message bus between the popup/sidepanel UI and every content-script frame.
 *
 * State machine statuses:
 *   idle               → no active goal
 *   navigating         → working through steps, element found
 *   waiting_for_human  → score too low, paused for user click
 *   complete           → all steps done
 *   error              → unrecoverable failure
 *
 * Changes from v1:
 *  - executeCurrentStep(): execution lock (_executing flag + finally clear)
 *    prevents concurrent calls from corrupting state on mutation-heavy SPAs.
 *  - NA_TREE_UPDATED: debounced 500ms in the background handler (content
 *    script already debounces at 400ms, creating a two-layer buffer).
 *  - rankAcrossFrames(): main-frame (frameId=0) receives a +10 score bonus
 *    before the merge, preventing ad/tracking iframes from winning.
 *  - NA_SET_GOAL: fetches page URL and title from the Chrome tab API and
 *    passes them to generateSteps() and executeCurrentStep() for site-aware
 *    LLM calls.
 *  - NA_LLM_IDENTIFY: passes pageUrl and pageTitle through to identifyElement().
 *  - NA_ELEMENT_CLICKED: new handler — content script notifies when the user
 *    clicks the highlighted element, triggering automatic step advance.
 *  - Debug logging: set self.__naDebug = true in SW console to enable.
 */

import { getStepExplanation, identifyElement, generateSteps, validateSelection, testApiKey } from './engine/llm.js';
import { GEMINI_API_KEY } from './config.js';

console.log('[NeuroAdapt] Background service worker v3 started.');

// ── Debug helper ────────────────────────────────────────────────────────────

function dbg(stage, data) {
  if (!self.__naDebug) return;
  const ts = performance.now().toFixed(1);
  console.group(`%c[NeuroAdapt:${stage}] +${ts}ms`, 'color:#60a5fa;font-weight:700');
  if (typeof data === 'object' && data !== null) {
    try { console.table(data); } catch { console.log(data); }
  } else {
    console.log(data);
  }
  console.groupEnd();
}

// ── State ────────────────────────────────────────────────────────────────────

const DEFAULT_STATE = Object.freeze({
  userGoal:         null,
  stepsList:        [],   // string[] — display labels
  stepsMetadata:    [],   // StepObject[] — structured metadata parallel to stepsList
  currentStepIndex: 0,
  status:           'idle',
  tabId:            null,
  topRef:           null,
  topScore:         0,
  topLabel:         null,
  frameId:          null,
  llmExplanation:   null,
  fallbackPrompt:   null,
  lastUpdated:      0,
});

let STATE = { ...DEFAULT_STATE, lastUpdated: Date.now() };

const MIN_CONFIDENCE    = 25;  // lowered from 40 — deterministic scores of 25-39 are usable
const POST_NAV_DELAY_MS = 1500;

// Execution lock — ensures only one executeCurrentStep() runs at a time.
let _executing      = false;
// Background debounce timer for NA_TREE_UPDATED
let _treeUpdateTimer = null;
// Auto-retry counter: allows NA_TREE_UPDATED to retry from waiting_for_human
// up to MAX_AUTO_RETRIES times (covers slow SPAs still rendering when HITL fires).
let _autoRetryCount = 0;
const MAX_AUTO_RETRIES = 3;

// ── State persistence ────────────────────────────────────────────────────────

async function persistState() {
  try {
    await chrome.storage.session.set({ naState: STATE });
  } catch (err) {
    console.warn('[NeuroAdapt] persistState failed:', err.message);
  }
}

async function restoreState() {
  try {
    const { naState } = await chrome.storage.session.get('naState');
    if (naState?.status) {
      STATE = naState;
      console.log('[NeuroAdapt] State restored from session storage:', STATE.status);
    }
  } catch { /* first run */ }
}

// ── State machine ─────────────────────────────────────────────────────────────

function transition(action, payload = {}) {
  const prev = STATE.status;

  switch (action) {
    case 'SET_GOAL':
      STATE = {
        ...DEFAULT_STATE,
        userGoal:         payload.goal,
        stepsList:        payload.steps,
        stepsMetadata:    payload.stepsMetadata ?? [],
        currentStepIndex: 0,
        status:           'navigating',
        tabId:            payload.tabId,
        lastUpdated:      Date.now(),
      };
      break;

    case 'STEP_FOUND':
      STATE = {
        ...STATE,
        topRef:      payload.topRef,
        topScore:    payload.topScore,
        topLabel:    payload.topLabel,
        frameId:     payload.frameId,
        status:      'navigating',
        lastUpdated: Date.now(),
      };
      break;

    case 'ADVANCE_STEP':
      if (STATE.currentStepIndex < STATE.stepsList.length - 1) {
        STATE = {
          ...STATE,
          currentStepIndex: STATE.currentStepIndex + 1,
          topRef:      null,
          topScore:    0,
          topLabel:    null,
          status:      'navigating',
          lastUpdated: Date.now(),
        };
      } else {
        STATE = { ...STATE, status: 'complete', lastUpdated: Date.now() };
        console.log('[NeuroAdapt] All steps complete.');
      }
      break;

    case 'REQUIRE_HITL':
      STATE = {
        ...STATE,
        status:         'waiting_for_human',
        fallbackPrompt: payload.prompt,
        lastUpdated:    Date.now(),
      };
      break;

    case 'HITL_RESOLVED':
      if (STATE.status !== 'waiting_for_human') break; // no-op if auto-retry already resolved
      STATE = {
        ...STATE,
        status:         'navigating',
        fallbackPrompt: null,
        lastUpdated:    Date.now(),
      };
      break;

    case 'SET_EXPLANATION':
      STATE = { ...STATE, llmExplanation: payload.explanation, lastUpdated: Date.now() };
      break;

    case 'CANCEL':
    case 'RESET':
      STATE = { ...DEFAULT_STATE, lastUpdated: Date.now() };
      break;

    case 'ERROR':
      STATE = { ...STATE, status: 'error', lastUpdated: Date.now() };
      break;

    default:
      console.warn('[NeuroAdapt] Unknown transition action:', action);
      return;
  }

  console.log(`[NeuroAdapt] State: ${prev} → ${STATE.status}  [${action}]`);
  dbg('STATE_TRANSITION', { from: prev, to: STATE.status, action, payload });
  broadcastState();
  persistState();
}

// ── Broadcast ─────────────────────────────────────────────────────────────────

function broadcastState() {
  chrome.runtime.sendMessage({ type: 'NA_STATE_UPDATE', state: { ...STATE } })
    .catch(() => { /* popup/sidepanel may be closed — normal */ });
}

// ── API key ───────────────────────────────────────────────────────────────────

let _apiKeyWarned = false;
function getApiKey() {
  const key = GEMINI_API_KEY?.trim();
  if (!key || key === 'PASTE_YOUR_KEY_HERE') {
    if (!_apiKeyWarned) {
      _apiKeyWarned = true;
      console.warn(
        '[NeuroAdapt] ⚠ No Gemini API key in config.js. ' +
        'LLM features are disabled — running in deterministic-only mode. ' +
        'Get a free key: https://aistudio.google.com/app/apikey'
      );
    }
    return '';
  }
  return key;
}

// ── Step object helpers ───────────────────────────────────────────────────────

/**
 * Normalise whatever generateSteps() or the caller provides into StepObject[].
 * Accepts both structured objects and legacy plain strings.
 */
function toStepObjects(steps) {
  return steps.map((s) => {
    if (typeof s === 'string') {
      return { hint: s, targetLabel: s, action: 'click', alternatives: [], elementType: null, zone: null };
    }
    // Ensure targetLabel always has a value — fall back to hint if missing
    return {
      ...s,
      targetLabel: s.targetLabel?.trim() || s.hint,
      alternatives: Array.isArray(s.alternatives) ? s.alternatives : [],
    };
  });
}

// ── Heuristic step fallback ───────────────────────────────────────────────────

/**
 * Heuristic step fallback when LLM is unavailable.
 *
 * Steps are intentionally SHORT (1-3 words) so the synonym matcher has fewer
 * noise tokens to deal with and the label similarity score is higher.
 * Verbose steps like "Find the email or username input field" dilute the
 * signal; "Email or username" matches more reliably.
 */
function generateStepsHeuristic(goal) {
  const g = goal.toLowerCase();

  if (/register|sign[\s-]?up|create[\s-]?account|enrol/.test(g))
    return [
      { hint: 'Sign Up button', targetLabel: 'Sign Up', action: 'click', alternatives: ['Register', 'Create account', 'Join', 'Get started'], elementType: 'button', zone: 'main' },
      { hint: 'Full name field', targetLabel: 'Full name', action: 'type', alternatives: ['Your name', 'Name', 'First name'], elementType: 'input', zone: 'main' },
      { hint: 'Email address field', targetLabel: 'Email', action: 'type', alternatives: ['Email address', 'Your email', 'Username'], elementType: 'input', zone: 'main' },
      { hint: 'Password field', targetLabel: 'Password', action: 'type', alternatives: ['Create password', 'New password', 'Choose password'], elementType: 'input', zone: 'main' },
      { hint: 'Submit registration button', targetLabel: 'Submit', action: 'click', alternatives: ['Create account', 'Register', 'Sign up', 'Continue'], elementType: 'button', zone: 'main' },
    ];
  if (/log[\s-]?in|sign[\s-]?in/.test(g))
    return [
      { hint: 'Email or username field', targetLabel: 'Email', action: 'type', alternatives: ['Email address', 'Username', 'Mobile number', 'Phone'], elementType: 'input', zone: 'main' },
      { hint: 'Password field', targetLabel: 'Password', action: 'type', alternatives: ['Enter password', 'Your password'], elementType: 'input', zone: 'main' },
      { hint: 'Sign In button', targetLabel: 'Sign In', action: 'click', alternatives: ['Login', 'Log in', 'Sign in', 'Continue', 'Next'], elementType: 'button', zone: 'main' },
    ];
  if (/search|find|look[\s-]?for/.test(g))
    return [
      { hint: 'Search input', targetLabel: 'Search', action: 'type', alternatives: ['Search bar', 'Search box', 'Search field', 'Type to search'], elementType: 'input', zone: 'header' },
      { hint: 'Search button', targetLabel: 'Search', action: 'click', alternatives: ['Go', 'Find', 'Submit search'], elementType: 'button', zone: 'header' },
    ];
  if (/book|reserv|ticket|appoint/.test(g))
    return [
      { hint: 'Book now button', targetLabel: 'Book', action: 'click', alternatives: ['Reserve', 'Book now', 'Get tickets', 'Schedule'], elementType: 'button', zone: 'main' },
      { hint: 'Date picker', targetLabel: 'Date', action: 'click', alternatives: ['Check-in', 'Arrival', 'Select date'], elementType: 'input', zone: 'main' },
      { hint: 'Confirm booking button', targetLabel: 'Confirm', action: 'click', alternatives: ['Book', 'Reserve', 'Submit', 'Continue'], elementType: 'button', zone: 'main' },
    ];
  if (/pay|payment|checkout|cart/.test(g))
    return [
      { hint: 'Checkout button', targetLabel: 'Checkout', action: 'click', alternatives: ['Buy now', 'Proceed to checkout', 'Place order'], elementType: 'button', zone: 'main' },
      { hint: 'Card number field', targetLabel: 'Card number', action: 'type', alternatives: ['Credit card', 'Debit card', 'Payment method'], elementType: 'input', zone: 'main' },
      { hint: 'Place order button', targetLabel: 'Place order', action: 'click', alternatives: ['Confirm payment', 'Pay now', 'Complete purchase'], elementType: 'button', zone: 'main' },
    ];
  if (/fill|form|submit|apply/.test(g))
    return [
      { hint: 'Form fields', targetLabel: 'Submit', action: 'click', alternatives: ['Apply', 'Send', 'Continue'], elementType: 'button', zone: 'main' },
    ];
  return [
    { hint: goal, targetLabel: goal, action: 'click', alternatives: [], elementType: null, zone: null },
  ];
}

// ── Content script injection ──────────────────────────────────────────────────

/**
 * Programmatically inject the NeuroAdapt content scripts into a tab.
 *
 * This solves the "stale tab" problem: Chrome only auto-injects content scripts
 * into tabs that open AFTER the extension is installed or reloaded. Tabs that
 * were already open when the extension loaded receive no content scripts.
 *
 * When rankAcrossFrames() gets 0 responses, it calls this and retries once.
 * The `window.__naInitialised` guard in content.js prevents double-init on tabs
 * that DO already have the scripts loaded.
 */
async function injectContentScripts(tabId) {
  console.log('[NeuroAdapt] Injecting content scripts into tab', tabId);
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: [
        'engine/pruner.js',
        'engine/observer.js',
        'engine/ranker.js',
        'engine/highlighter.js',
        'content.js',
      ],
    });
    await chrome.scripting.insertCSS({
      target: { tabId, allFrames: false },
      files: ['styles/highlight.css'],
    });
    console.log('[NeuroAdapt] Content scripts injected successfully.');
    return true;
  } catch (err) {
    console.warn('[NeuroAdapt] Content script injection failed:', err.message);
    return false;
  }
}

// ── Frame fan-out ─────────────────────────────────────────────────────────────

/**
 * Send NA_RANK to all frames in the tab and return the best result.
 *
 * Main-frame preference: the main frame (frameId=0) receives a +10 point
 * bonus before the merge comparison. This prevents ad iframes or login
 * widget iframes from stealing the result when their score is marginally
 * higher than the main document's match.
 *
 * Auto-injection: if no frames respond, the content scripts are probably not
 * loaded (the tab was open before the extension installed). We inject them
 * programmatically and retry once.
 */
async function rankAcrossFrames(tabId, targetHint, tooltip, stepMeta = null) {
  let frames;
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId });
  } catch (err) {
    console.warn('[NeuroAdapt] getAllFrames failed:', err.message);
    frames = [{ frameId: 0, url: '(unknown)' }];
  }

  if (!frames?.length) return { ok: false, topRef: null, topScore: 0, frameId: 0 };

  console.log(
    `[NeuroAdapt] Fanning out NA_RANK to ${frames.length} frame(s) for "${targetHint}"`
  );

  const buildFanOut = (frameList) => frameList.map((frame) =>
    chrome.tabs.sendMessage(
      tabId,
      {
        type:          'NA_RANK',
        targetHint,
        tooltip,
        minScore:      1,
        alternatives:  stepMeta?.alternatives  ?? [],
        elementType:   stepMeta?.elementType   ?? null,
        preferredZone: stepMeta?.zone          ?? null,
      },
      { frameId: frame.frameId }
    )
    .then((resp) => ({ ...resp, frameId: frame.frameId, frameUrl: frame.url }))
    .catch((err) => {
      console.log(`[NeuroAdapt]   frame[${frame.frameId}] no response: ${err.message}`);
      return null;
    })
  );

  let settled   = await Promise.allSettled(buildFanOut(frames));
  let responses = settled
    .filter((r) => r.status === 'fulfilled' && r.value?.ok)
    .map((r) => r.value);

  // Auto-injection retry: if no frames responded, the tab was probably open
  // before the extension loaded (stale tab). Inject the content scripts and
  // retry the fan-out once.
  if (!responses.length) {
    console.warn(
      '[NeuroAdapt] No frames responded — tab may not have content scripts. ' +
      'Attempting auto-injection…'
    );
    const injected = await injectContentScripts(tabId);
    if (injected) {
      // Small delay to let the injected scripts initialise
      await new Promise((r) => setTimeout(r, 600));
      settled   = await Promise.allSettled(buildFanOut([{ frameId: 0 }]));
      responses = settled
        .filter((r) => r.status === 'fulfilled' && r.value?.ok)
        .map((r) => r.value);
    }
  }

  if (!responses.length) {
    console.warn('[NeuroAdapt] No frames responded after injection attempt.');
    return { ok: false, topRef: null, topScore: 0, frameId: 0 };
  }

  // Apply main-frame bonus before comparing scores.
  const MAIN_FRAME_BONUS = 10;
  const best = responses.reduce((acc, r) => {
    const effectiveScore = (r.topScore ?? 0) + (r.frameId === 0 ? MAIN_FRAME_BONUS : 0);
    const accScore       = (acc.topScore ?? 0) + (acc.frameId === 0 ? MAIN_FRAME_BONUS : 0);
    return effectiveScore > accScore ? r : acc;
  });

  console.log(
    `[NeuroAdapt] Best: frame[${best.frameId}] score=${best.topScore} ` +
    `label="${best.topLabel ?? '—'}"`
  );
  dbg('RANK_RESULT', {
    respondedFrames: responses.length,
    totalFrames:     frames.length,
    topRef:          best.topRef,
    topLabel:        best.topLabel,
    topScore:        best.topScore,
    source:          best.source,
    frameId:         best.frameId,
    ranked:          best.ranked,
  });

  return best;
}

// ── Step executor ─────────────────────────────────────────────────────────────

/**
 * Orchestrate: rank → highlight → advance or HITL.
 *
 * Execution lock: _executing prevents concurrent runs when multiple
 * NA_TREE_UPDATED messages arrive in quick succession on SPAs.
 * The `finally` block guarantees the lock is always released, even on error.
 */
async function executeCurrentStep() {
  if (_executing) {
    console.log('[NeuroAdapt] executeCurrentStep: already running — skipping concurrent call.');
    return;
  }

  const { tabId, stepsList, stepsMetadata, currentStepIndex, status, userGoal } = STATE;
  if (status !== 'navigating') return;
  if (!tabId || !stepsList.length) {
    console.warn('[NeuroAdapt] executeCurrentStep: missing tabId or steps.');
    return;
  }

  _executing = true;
  const t0   = performance.now();

  try {
    const step     = stepsList[currentStepIndex];
    const stepMeta = stepsMetadata?.[currentStepIndex] ?? null;
    console.log(`[NeuroAdapt] ── Step ${currentStepIndex + 1}/${stepsList.length}: "${step}"`);
    if (stepMeta?.alternatives?.length) {
      console.log(`[NeuroAdapt]    alternatives: ${stepMeta.alternatives.join(' | ')}`);
    }
    dbg('STEP_START', { stepIndex: currentStepIndex, step, stepMeta, totalSteps: stepsList.length, goal: userGoal });

    // Use targetLabel as the primary rank hint when available — it directly
    // matches the element's visible text, giving the ranker the best signal.
    // Keep the full hint as a fallback and inject targetLabel into alternatives.
    const primaryHint = stepMeta?.targetLabel?.trim() || step;
    // Keep alternatives clean — verbose hints like "Click the Sign in button"
    // confuse element label matching. Only short, label-like alternatives are useful.
    const enrichedMeta = stepMeta ? {
      ...stepMeta,
      alternatives: (stepMeta.alternatives ?? []).filter(Boolean),
    } : null;

    let result;
    try {
      result = await rankAcrossFrames(tabId, primaryHint, step, enrichedMeta);
    } catch (err) {
      console.error('[NeuroAdapt] rankAcrossFrames threw:', err);
      transition('ERROR');
      return;
    }

    dbg('STEP_TIMING', { elapsedMs: (performance.now() - t0).toFixed(1), step });

    // Fire LLM explanation non-blocking
    getStepExplanation(getApiKey(), userGoal, step)
      .then((explanation) => transition('SET_EXPLANATION', { explanation }))
      .catch(() => {});

    if (result.topScore >= MIN_CONFIDENCE) {
      transition('STEP_FOUND', {
        topRef:   result.topRef,
        topScore: result.topScore,
        topLabel: result.topLabel,
        frameId:  result.frameId,
      });
    } else {
      const score  = result.topScore;
      const best   = result.topLabel ? `Best guess: "${result.topLabel}" (${score}/100).` : '';
      const prompt =
        `I can't confidently find "${step}" on this page. ${best} ` +
        `Please click it for me and I'll continue from there.`;

      console.log(`[NeuroAdapt] Low confidence (${score}/100) — triggering HITL.`);
      transition('REQUIRE_HITL', { prompt });
      attachHITLCapture(tabId, step);
    }

  } finally {
    _executing = false;
  }
}

function attachHITLCapture(tabId, step) {
  chrome.tabs.sendMessage(tabId, { type: 'NA_CAPTURE_CLICK' }, { frameId: 0 })
    .then((clickResult) => {
      if (!clickResult?.ok) return;
      // Guard: if auto-retry already succeeded (state is no longer waiting_for_human),
      // this is a stale click from a previously-active capture listener. Ignore it.
      if (STATE.status !== 'waiting_for_human') {
        console.log('[NeuroAdapt] HITL click received but state already resolved — ignoring.');
        return;
      }
      const label = clickResult.text ?? clickResult.ariaLabel ?? clickResult.tag ?? '?';
      console.log(`[NeuroAdapt] HITL resolved — user clicked: <${clickResult.tag}> "${label}"`);
      _autoRetryCount = 0; // reset for next step
      transition('HITL_RESOLVED');
      transition('ADVANCE_STEP');
      executeCurrentStep();
    })
    .catch((err) => console.warn('[NeuroAdapt] NA_CAPTURE_CLICK failed:', err.message));
}

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const origin = sender.tab
    ? `frame[${sender.frameId ?? 0}] tab[${sender.tab.id}]`
    : 'extension page';
  console.log(`[NeuroAdapt] ← "${message.type}" from ${origin}`);

  (async () => {
    switch (message.type) {

      // ── State query ────────────────────────────────────────────────────
      case 'NA_GET_STATE':
        sendResponse({ ok: true, state: { ...STATE } });
        break;

      // ── User submits a goal ────────────────────────────────────────────
      case 'NA_SET_GOAL': {
        const { goal, tabId } = message;
        if (!goal?.trim()) { sendResponse({ ok: false, error: 'goal is empty' }); break; }
        if (!tabId)        { sendResponse({ ok: false, error: 'tabId missing' }); break; }

        // Fetch page metadata from Chrome tab API
        let pageUrl = '', pageTitle = '';
        try {
          const tab = await chrome.tabs.get(tabId);
          pageUrl   = tab.url   ?? '';
          pageTitle = tab.title ?? '';
        } catch { /* tab may not be accessible */ }

        // Fetch live page context (actual button labels, headings, inputs) from
        // the content script. This lets generateSteps produce steps with exact
        // UI labels rather than guessing from URL/title alone — major accuracy gain.
        // If the content script isn't loaded yet, inject it first then retry.
        let pageContext = null;
        try {
          const ctxResp = await chrome.tabs.sendMessage(
            tabId, { type: 'NA_GET_PAGE_CONTEXT' }, { frameId: 0 }
          );
          if (ctxResp?.ok) pageContext = ctxResp;
        } catch {
          try {
            const injected = await injectContentScripts(tabId);
            if (injected) {
              await new Promise((r) => setTimeout(r, 500));
              const ctxResp = await chrome.tabs.sendMessage(
                tabId, { type: 'NA_GET_PAGE_CONTEXT' }, { frameId: 0 }
              );
              if (ctxResp?.ok) pageContext = ctxResp;
            }
          } catch { /* use URL/title only — context fetch is best-effort */ }
        }
        if (pageContext) {
          console.log(
            `[NeuroAdapt] Page context: ${pageContext.buttons?.length ?? 0} buttons, ` +
            `${pageContext.inputs?.length ?? 0} inputs, ${pageContext.headings?.length ?? 0} headings`
          );
        }

        dbg('SET_GOAL', { goal, tabId, pageUrl, pageTitle, pageContext });

        const rawSteps = Array.isArray(message.steps) && message.steps.length
          ? message.steps
          : (await generateSteps(getApiKey(), goal, { pageUrl, pageTitle, pageContext }))
            ?? generateStepsHeuristic(goal);

        const stepsMetadata = toStepObjects(rawSteps);
        const steps         = stepsMetadata.map((s) => s.hint);

        console.log(`[NeuroAdapt] Goal: "${goal}"`);
        steps.forEach((s, i) => console.log(`  ${i + 1}. ${s}`));

        _autoRetryCount = 0; // reset retry counter for fresh goal
        transition('SET_GOAL', { goal, steps, stepsMetadata, tabId });
        sendResponse({ ok: true, steps });
        await executeCurrentStep();
        break;
      }

      // ── Manual next-step ───────────────────────────────────────────────
      case 'NA_NEXT_STEP':
        if (STATE.status === 'idle') { sendResponse({ ok: false, error: 'No active goal.' }); break; }
        _autoRetryCount = 0; // reset retry counter for new step
        transition('ADVANCE_STEP');
        sendResponse({ ok: true, state: { ...STATE } });
        await executeCurrentStep();
        break;

      // ── Cancel / reset ─────────────────────────────────────────────────
      case 'NA_CANCEL':
        if (STATE.tabId) {
          chrome.tabs.sendMessage(STATE.tabId, { type: 'NA_CLEAR_HIGHLIGHT' }, { frameId: 0 })
            .catch(() => {});
        }
        clearTimeout(_treeUpdateTimer);
        _executing = false;
        _autoRetryCount = 0;
        transition('CANCEL');
        sendResponse({ ok: true });
        break;

      // ── DOM mutation notification (debounced) ──────────────────────────
      case 'NA_TREE_UPDATED': {
        const isActiveTab = sender.tab?.id === STATE.tabId;
        const canRetry    = STATE.status === 'navigating' ||
          (STATE.status === 'waiting_for_human' && _autoRetryCount < MAX_AUTO_RETRIES);
        if (isActiveTab && canRetry) {
          // Two-layer debounce: content script (400ms) + background (500ms).
          // Prevents many rapid mutations from spawning concurrent executions.
          clearTimeout(_treeUpdateTimer);
          _treeUpdateTimer = setTimeout(() => {
            if (STATE.status === 'waiting_for_human' && _autoRetryCount < MAX_AUTO_RETRIES) {
              // Slow-SPA auto-retry: HITL fired before the page finished rendering.
              // Reset to navigating so executeCurrentStep can run again.
              _autoRetryCount++;
              console.log(
                `[NeuroAdapt] DOM updated while waiting — auto-retry #${_autoRetryCount}/${MAX_AUTO_RETRIES}.`
              );
              STATE = { ...STATE, status: 'navigating', fallbackPrompt: null, lastUpdated: Date.now() };
              broadcastState();
              persistState();
            }
            if (STATE.status === 'navigating') {
              console.log('[NeuroAdapt] DOM updated in active tab — re-evaluating step.');
              executeCurrentStep();
            }
          }, 500);
        }
        sendResponse({ ok: true });
        break;
      }

      // ── User clicked the highlighted element (Phase 5 verification) ────
      case 'NA_ELEMENT_CLICKED': {
        if (STATE.status === 'navigating') {
          console.log('[NeuroAdapt] User clicked highlighted element — advancing step.');
          clearTimeout(_treeUpdateTimer);
          _executing = false; // release lock if a rank was in flight
          _autoRetryCount = 0; // reset retry counter for new step
          transition('ADVANCE_STEP');
          // Small delay to let the page respond to the click before re-ranking
          setTimeout(() => executeCurrentStep(), 600);
        }
        sendResponse({ ok: true });
        break;
      }

      // ── LLM element identification (called by content script) ──────────
      case 'NA_LLM_IDENTIFY': {
        const result = await identifyElement(
          getApiKey(),
          message.hint,
          message.candidates,
          {
            pageUrl:   message.pageUrl   ?? '',
            pageTitle: message.pageTitle ?? '',
            stepMeta:  message.stepMeta  ?? null,
          }
        );

        // Validation pass: if the LLM's confidence is low (< 45%), make a
        // second call to verify or find a better-matching candidate.
        if (result?.ref && (result.confidence ?? 100) < 45) {
          console.log(
            `[NeuroAdapt] Low LLM confidence (${result.confidence}%) — running validation pass.`
          );
          const validation = await validateSelection(
            getApiKey(),
            message.hint,
            result.ref,
            message.candidates,
            { pageUrl: message.pageUrl ?? '', pageTitle: message.pageTitle ?? '' }
          );
          if (validation && !validation.confirmed && validation.alternativeRef) {
            console.log(
              `[NeuroAdapt] Validation overrides ${result.ref} → ${validation.alternativeRef} ` +
              `(${validation.confidence}%) — ${validation.reason}`
            );
            sendResponse({
              ref:        validation.alternativeRef,
              confidence: validation.confidence ?? result.confidence,
              reason:     `[validated] ${validation.reason}`,
            });
            break;
          }
        }

        sendResponse(result ?? { ref: null, confidence: 0, reason: 'llm unavailable' });
        break;
      }

      case 'NA_TEST_API_KEY': {
        const result = await testApiKey(getApiKey());
        sendResponse({ ok: result.ok, error: result.error ?? null });
        break;
      }

      default:
        sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
    }
  })();

  return true;
});

// ── Navigation listener ───────────────────────────────────────────────────────

chrome.webNavigation.onCompleted.addListener(({ tabId, frameId }) => {
  if (frameId !== 0)                 return;
  if (STATE.status !== 'navigating') return;
  if (STATE.tabId  !== tabId)        return;

  console.log(
    `[NeuroAdapt] Top-level navigation complete in tab ${tabId} — ` +
    `re-executing step in ${POST_NAV_DELAY_MS}ms.`
  );
  setTimeout(() => executeCurrentStep(), POST_NAV_DELAY_MS);
});

// ── Lifecycle ─────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  console.log('[NeuroAdapt] Installed / updated.');
  const key = getApiKey();
  if (key) {
    testApiKey(key).then(({ ok, error }) => {
      if (ok) console.log('[NeuroAdapt] API key verified — Gemini is reachable.');
      else    console.warn('[NeuroAdapt] API key test FAILED:', error);
    });
  }
});

chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: false })
  .catch((err) => console.warn('[NeuroAdapt] sidePanel.setPanelBehavior:', err));

restoreState();
