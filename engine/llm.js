/**
 * NeuroAdapt Engine — LLM Abstraction (v2)
 *
 * ES module — imported by background.js only (never a content script).
 *
 * Changes from v1:
 *  - identifyElement(): accepts { pageUrl, pageTitle } for site-aware picks.
 *  - identifyElement(): includes role, deterministic score, href, bounding
 *    rect position, and parentHeading in each candidate line.
 *  - identifyElement(): prompt reframed to treat rank_score as guidance only,
 *    not ground truth, so Gemini corrects deterministic errors rather than
 *    reinforcing them.
 *  - generateSteps(): accepts { pageUrl, pageTitle } for site-specific steps.
 *  - All functions: structured debug logging when na_debug is set.
 */

// gemini-2.5-flash: best available model on this key — supports internal thinking
const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

const TIMEOUT_MS = 15_000; // 2.5-flash with thinking needs more time

// ── Debug helper ────────────────────────────────────────────────────────────

function dbg(stage, data) {
  try {
    if (typeof self !== 'undefined' && self.__naDebug) {
      console.group(`%c[NeuroAdapt:LLM:${stage}]`, 'color:#f59e0b;font-weight:700');
      console.log(data);
      console.groupEnd();
    }
  } catch { /* ignore */ }
}

// ── Shared fetch helper ─────────────────────────────────────────────────────

async function geminiPost(apiKey, body) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method:  'POST',
      signal:  controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    clearTimeout(timer);
    if (!resp.ok) {
      const msg = await resp.text().catch(() => resp.statusText);
      throw new Error(`Gemini ${resp.status}: ${msg}`);
    }
    const data  = await resp.json();
    // Thinking models return parts[] where early parts are thought-traces (no .text or thought=true).
    // We want the last part that has actual text output.
    const parts = data?.candidates?.[0]?.content?.parts ?? [];
    const textPart = [...parts].reverse().find((p) => typeof p.text === 'string' && !p.thought);
    return textPart?.text?.trim() ?? '';
  } catch (err) {
    clearTimeout(timer);
    throw err;
  }
}

/** Strip optional markdown code fences the model sometimes wraps output in. */
function stripFences(raw) {
  return raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
}

/**
 * Extract the first valid JSON array from `text`.
 * Handles preamble text ("Here are the steps:"), markdown fences, etc.
 */
function findJsonArray(text) {
  // Fast path: the whole text IS the JSON
  try {
    const p = JSON.parse(stripFences(text));
    if (Array.isArray(p)) return p;
  } catch {}
  // Scan from first [ to last ] — handles preamble/postamble text
  const start = text.indexOf('[');
  const end   = text.lastIndexOf(']');
  if (start === -1 || end <= start) return null;
  try {
    const p = JSON.parse(text.slice(start, end + 1));
    if (Array.isArray(p)) return p;
  } catch {}
  return null;
}

/**
 * Find and return the LAST JSON object in `text` that contains `requiredKey`.
 *
 * More robust than a regex because it properly handles:
 *   - Multi-line JSON
 *   - Escaped quotes inside strings
 *   - Reasoning/preamble text before the JSON
 *   - Brace characters inside string values
 *
 * Returns null if no valid matching JSON is found.
 */
function findJson(text, requiredKey) {
  // Fast path: the whole text IS the JSON (most common case)
  try {
    const p = JSON.parse(stripFences(text));
    if (p && typeof p === 'object' && requiredKey in p) return p;
  } catch {}

  // Scan text for {...} blocks using a simple state machine that
  // skips over string contents to avoid being fooled by braces in values.
  let depth = 0;
  let start = -1;
  let last  = null;
  let i     = 0;

  while (i < text.length) {
    const c = text[i];

    if (c === '"') {
      // Skip the entire string so braces inside strings don't count
      i++;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; } // escaped char
        if (text[i] === '"')  { break; }             // end of string
        i++;
      }
    } else if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          const p = JSON.parse(text.slice(start, i + 1));
          if (p && typeof p === 'object' && requiredKey in p) last = p;
        } catch {}
        start = -1;
      }
    }
    i++;
  }
  return last;
}

// ── getStepExplanation ───────────────────────────────────────────────────────

/**
 * Ask Gemini for a single friendly sentence explaining the current step.
 * Fire-and-forget — does not block highlighting.
 */
export async function getStepExplanation(apiKey, userGoal, currentStep) {
  if (!apiKey?.trim()) return ruleFallback(userGoal, currentStep);

  const prompt =
    `User goal: "${userGoal}"\n` +
    `Current step: "${currentStep}"\n` +
    `Write exactly ONE sentence (≤ 15 words) telling the user, in plain friendly ` +
    `language, what the assistant is doing right now.`;

  try {
    const text = await geminiPost(apiKey, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 60, temperature: 0.35, topP: 0.8 },
    });
    if (!text) throw new Error('empty response');
    console.log('[NeuroAdapt] LLM explanation:', text);
    return text;
  } catch (err) {
    if (err.name === 'AbortError') console.warn('[NeuroAdapt] getStepExplanation timed out.');
    else console.warn('[NeuroAdapt] getStepExplanation failed:', err.message);
    return ruleFallback(userGoal, currentStep);
  }
}

// ── identifyElement ──────────────────────────────────────────────────────────

/**
 * Pick the best-matching element from the deterministic pre-filter candidates.
 *
 * @param {string} apiKey
 * @param {string} hint          Natural-language step description
 * @param {Array}  candidates    Serialised nodes from the ranker (top-N)
 * @param {object} [ctx]         Page context
 * @param {string} [ctx.pageUrl]
 * @param {string} [ctx.pageTitle]
 * @returns {Promise<{ref:string|null, confidence:number, reason:string}|null>}
 */
export async function identifyElement(apiKey, hint, candidates, { pageUrl = '', pageTitle = '', stepMeta = null } = {}) {
  if (!apiKey?.trim() || !candidates?.length) return null;

  // Build element list: use htmlSnippet as primary representation when available.
  // This gives Gemini actual HTML markup to reason about instead of fragmented
  // key-value pairs, dramatically improving selection accuracy.
  const elementList = candidates.map((el) => {
    // score > 0: keyword-ranked; score === 0: visible but unranked (viewport supplement)
    const score  = el.score > 0 ? ` [score:${el.score}]` : ' [visible]';
    const fold   = el.inViewport === false ? ' [below-fold]' : '';
    const zone   = el.zone ? ` [zone:${el.zone}]` : '';
    const sec    = el.parentHeading ? ` [section:"${el.parentHeading}"]` : '';

    if (el.htmlSnippet) {
      let dataStr = '';
      if (el.dataAttrs) {
        dataStr = ' ' + Object.entries(el.dataAttrs).map(([k, v]) => `${k}="${v}"`).join(' ');
      }
      return `[${el.ref}]${score}${fold}${zone}${sec} ${el.htmlSnippet}${dataStr}`;
    }

    // Fallback for candidates that don't carry htmlSnippet (older content scripts)
    const parts = [`[${el.ref}] <${el.tag}>`];
    if (el.role && el.role !== el.tag) parts.push(`role="${el.role}"`);
    if (el.type)                       parts.push(`type="${el.type}"`);
    if (el.label)                      parts.push(`label:"${el.label}"`);
    if (el.ariaLabel && el.ariaLabel !== el.label) parts.push(`aria:"${el.ariaLabel}"`);
    if (el.placeholder)                parts.push(`placeholder:"${el.placeholder}"`);
    if (el.name)                       parts.push(`name:"${el.name}"`);
    if (el.id)                         parts.push(`id:"${el.id}"`);
    if (el.href)                       parts.push(`href:"${el.href.slice(0, 60)}"`);
    return parts.join(' ') + score + fold + zone + sec;
  }).join('\n');

  const targetLabel = stepMeta?.targetLabel?.trim();
  const altLine = stepMeta?.alternatives?.length
    ? `Also acceptable labels: ${stepMeta.alternatives.join(' | ')}`
    : '';

  const contextLines = [
    pageUrl       ? `Page URL: ${pageUrl}`                              : '',
    pageTitle     ? `Page title: "${pageTitle}"`                        : '',
    targetLabel   ? `Target element label (EXACT match preferred): "${targetLabel}"` : '',
    stepMeta?.elementType ? `Expected element type: ${stepMeta.elementType}` : '',
    stepMeta?.zone        ? `Expected page zone: ${stepMeta.zone}`           : '',
    altLine,
  ].filter(Boolean).join('\n');

  const prompt =
`You are a precise web element identifier for an accessibility navigation assistant.
${contextLines ? `\n${contextLines}\n` : ''}
User intent: "${hint}"

Candidate elements:
- [score:N] = keyword-ranked (N is a hint, not the final answer — trust the HTML over the score)
- [visible] = in viewport but not keyword-matched — CONSIDER THESE EQUALLY for semantic matches
${elementList}

Matching rules (apply in order):
1. Find the element whose visible text, aria-label, placeholder, or data-* attribute best matches the "Target element label" and "User intent"
2. [visible] elements must be considered as seriously as scored ones — they may be the correct answer
3. Prefer the expected element type (button for click, input for typing)
4. Prefer elements in the expected zone (header for nav actions, main for form fields)
5. If multiple elements match equally, prefer the one in-viewport and higher on the page
6. Never pick an element just because it has a high score — read the HTML snippet

Return ONLY valid JSON on one line, no markdown:
{"ref":"na-el-N","confidence":0-100,"reason":"one phrase"}
If genuinely nothing matches: {"ref":null,"confidence":0,"reason":"brief"}`;

  dbg('IDENTIFY_PROMPT', { hint, candidateCount: candidates.length, contextLines, elementList });

  try {
    const raw = await geminiPost(apiKey, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 200,
        temperature: 0,
        thinkingConfig: { thinkingBudget: 1024 },
      },
    });

    const result = findJson(raw, 'ref');
    if (!result) throw new Error('No JSON object in response');

    if (typeof result.ref === 'string' || result.ref === null) {
      console.log(
        `[NeuroAdapt] LLM identified: ${result.ref} (${result.confidence}%) — ${result.reason}`
      );
      dbg('IDENTIFY_RESULT', result);
      return result;
    }
    throw new Error('Unexpected response shape');

  } catch (err) {
    if (err.name === 'AbortError') console.warn('[NeuroAdapt] identifyElement timed out.');
    else console.warn('[NeuroAdapt] identifyElement failed:', err.message);
    return null;
  }
}

// ── generateSteps ────────────────────────────────────────────────────────────

/**
 * Break a user goal into 2–5 concrete, element-findable steps.
 *
 * @param {string} apiKey
 * @param {string} goal
 * @param {object} [ctx]
 * @param {string} [ctx.pageUrl]
 * @param {string} [ctx.pageTitle]
 * @param {object} [ctx.pageContext]  Live page context from NA_GET_PAGE_CONTEXT
 * @returns {Promise<Array|null>}
 */
export async function generateSteps(apiKey, goal, { pageUrl = '', pageTitle = '', pageContext = null } = {}) {
  if (!apiKey?.trim() || !goal?.trim()) return null;

  // Build rich page context: actual UI labels from the live page are far more
  // accurate than URL/title for generating steps that match real element text.
  const contextParts = [];
  if (pageUrl)   contextParts.push(`Current page URL: ${pageUrl}`);
  if (pageTitle) contextParts.push(`Current page title: "${pageTitle}"`);

  if (pageContext) {
    if (pageContext.headings?.length)
      contextParts.push(`Page headings: ${pageContext.headings.join(' | ')}`);
    if (pageContext.buttons?.length)
      contextParts.push(`Visible buttons/links on page: ${pageContext.buttons.join(' | ')}`);
    if (pageContext.inputs?.length)
      contextParts.push(`Visible input fields: ${pageContext.inputs.join(' | ')}`);
    if (pageContext.tabs?.length)
      contextParts.push(`Visible tabs/menu items: ${pageContext.tabs.join(' | ')}`);
    if (pageContext.links?.length)
      contextParts.push(`Visible links: ${pageContext.links.slice(0, 10).join(' | ')}`);
  }

  const contextBlock = contextParts.join('\n');

  const prompt =
`You are a web navigation assistant. Break the user's goal into 2-7 concrete, actionable steps across all pages the user will visit.
${contextBlock ? `\n${contextBlock}\n` : ''}
User goal: "${goal}"

CRITICAL RULES:
- For steps on the CURRENT PAGE: use EXACT text from "Visible buttons/links on page" and "Visible input fields" above
- If you see "Sign in" in the buttons list, use "Sign in" as targetLabel — NEVER "Login" or "Log In"
- For steps on FUTURE PAGES (after navigation): use your best knowledge of what that page will show
- Each step references ONE specific UI element — its targetLabel is the visible text/placeholder
- "hint" = human-readable instruction for the user
- "targetLabel" = the EXACT label the element shows (button text, input placeholder, link text)
- "alternatives" = 2-4 other common phrasings of the SAME element across different sites/versions
- "elementType": button | input | link | select | textarea
- "zone": header | main | modal | nav | footer | content
- "action": click | type | select | check

Return ONLY a JSON array, no markdown. Example for a 2-step flow:
[
  {
    "hint": "Enter your email address",
    "targetLabel": "Email",
    "action": "type",
    "alternatives": ["Email address", "Username", "Enter email"],
    "elementType": "input",
    "zone": "main"
  },
  {
    "hint": "Click the Sign in button",
    "targetLabel": "Sign in",
    "action": "click",
    "alternatives": ["Log in", "Login", "Sign In"],
    "elementType": "button",
    "zone": "main"
  }
]`;

  dbg('STEPS_PROMPT', { goal, contextBlock, hasPageContext: !!pageContext });

  try {
    const raw   = await geminiPost(apiKey, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 1200,
        temperature: 0,
        thinkingConfig: { thinkingBudget: 1024 },
      },
    });
    const parsed = findJsonArray(raw);
    if (!parsed) throw new Error('No JSON array in response');

    // Accept structured step objects
    if (parsed.length && parsed.every((s) => typeof s.hint === 'string')) {
      console.log('[NeuroAdapt] LLM generated structured steps:', parsed.length);
      dbg('STEPS_RESULT', parsed);
      return parsed;
    }
    // Backward compatibility: plain string array → wrap into step objects
    if (parsed.length && parsed.every((s) => typeof s === 'string')) {
      console.log('[NeuroAdapt] LLM returned plain steps (legacy format), wrapping.');
      return parsed.map((hint) => ({
        hint, targetLabel: hint, action: 'click', alternatives: [], elementType: null, zone: null,
      }));
    }
    throw new Error('Invalid steps format from LLM');

  } catch (err) {
    if (err.name === 'AbortError') console.warn('[NeuroAdapt] generateSteps timed out.');
    else console.warn('[NeuroAdapt] generateSteps failed:', err.message);
    return null;
  }
}

// ── validateSelection ────────────────────────────────────────────────────────

/**
 * Second-pass validation for low-confidence element selections.
 *
 * When identifyElement() returns confidence < 45%, call this to ask Gemini
 * whether the selection is correct or whether one of the other candidates
 * is a better match. This catches cases where the deterministic ranker put
 * the right element below the LLM's top pick.
 *
 * @param {string} apiKey
 * @param {string} hint         Original step hint
 * @param {string} selectedRef  Ref of the element identifyElement() chose
 * @param {Array}  candidates   All serialised candidates from the ranker
 * @param {object} [ctx]
 * @returns {Promise<{confirmed:boolean, alternativeRef:string|null, confidence:number, reason:string}|null>}
 */
export async function validateSelection(apiKey, hint, selectedRef, candidates, { pageUrl = '', pageTitle = '' } = {}) {
  if (!apiKey?.trim() || !selectedRef || !candidates?.length) return null;

  const selectedEl = candidates.find((c) => c.ref === selectedRef);
  if (!selectedEl) return null;

  const selectedDesc = selectedEl.htmlSnippet
    || `<${selectedEl.tag}> label:"${selectedEl.label}"`;

  const altList = candidates
    .filter((c) => c.ref !== selectedRef)
    .slice(0, 8)
    .map((c) => `[${c.ref}] ${c.htmlSnippet || `<${c.tag}> label:"${c.label}"`}`)
    .join('\n');

  const contextLines = [
    pageUrl   ? `Page URL: ${pageUrl}`       : '',
    pageTitle ? `Page title: "${pageTitle}"` : '',
  ].filter(Boolean).join('\n');

  const prompt =
`You are validating an automated element selection for an accessibility navigation tool.
${contextLines ? `\n${contextLines}\n` : ''}
User intent: "${hint}"

Previously selected element:
[${selectedRef}] ${selectedDesc}

Other candidates:
${altList || '(none)'}

Question: Is [${selectedRef}] the BEST match for the user intent, or is one of the alternatives clearly better?

Return ONLY a JSON object on one line — no markdown:
{"confirmed":true,"alternativeRef":null,"confidence":85,"reason":"one sentence"}
or if a better match exists:
{"confirmed":false,"alternativeRef":"na-el-N","confidence":75,"reason":"one sentence"}`;

  dbg('VALIDATE_PROMPT', { hint, selectedRef, altCount: candidates.length - 1 });

  try {
    const raw    = await geminiPost(apiKey, {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        maxOutputTokens: 200,
        temperature: 0,
        thinkingConfig: { thinkingBudget: 512 },
      },
    });
    const result = findJson(raw, 'confirmed');
    if (!result) throw new Error('No JSON in validation response');
    console.log(
      `[NeuroAdapt] Validation: confirmed=${result.confirmed} alt=${result.alternativeRef} — ${result.reason}`
    );
    dbg('VALIDATE_RESULT', result);
    return result;
  } catch (err) {
    if (err.name === 'AbortError') console.warn('[NeuroAdapt] validateSelection timed out.');
    else console.warn('[NeuroAdapt] validateSelection failed:', err.message);
    return null;
  }
}

// ── testApiKey ───────────────────────────────────────────────────────────────

/**
 * Verify that an API key is valid by making a minimal Gemini request.
 * @param {string} apiKey
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function testApiKey(apiKey) {
  if (!apiKey?.trim()) return { ok: false, error: 'No API key provided' };
  try {
    const text = await geminiPost(apiKey, {
      contents: [{ parts: [{ text: 'Reply with the single word: ok' }] }],
      generationConfig: { maxOutputTokens: 5, temperature: 0 },
    });
    console.log('[NeuroAdapt] API key test response:', text);
    return { ok: true };
  } catch (err) {
    console.warn('[NeuroAdapt] API key test failed:', err.message);
    return { ok: false, error: err.message };
  }
}

// ── Rule-based fallback explanation ─────────────────────────────────────────

function ruleFallback(userGoal, currentStep) {
  const step = currentStep.toLowerCase();
  if (/find|look|search|locate/.test(step))
    return `Scanning the page to find "${currentStep}"`;
  if (/click|press|tap|select/.test(step))
    return `Getting ready to click "${currentStep}"`;
  if (/fill|enter|type|input/.test(step))
    return `Looking for the field where you can ${currentStep.toLowerCase()}`;
  if (/submit|confirm|complete/.test(step))
    return `Almost there — finding the final ${currentStep.toLowerCase()} button`;
  return `Working on step: "${currentStep}"`;
}
