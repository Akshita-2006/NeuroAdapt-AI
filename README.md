# NeuroAdapt AI

NeuroAdapt AI is a Chrome extension (Manifest V3) that acts as an AI web-navigation copilot. You describe a goal in plain language ("Book a train ticket to Delhi"); the extension breaks it into steps, finds the right element on the page using a two-stage deterministic + LLM pipeline, highlights it non-intrusively, and walks you through each step to completion.

## How it works

```
User Goal → generateSteps (Gemini) → State Machine → DOM Pruner → Ranker (top candidates) → identifyElement (Gemini) → Highlighter → getStepExplanation (Gemini)
```

- **Deterministic first pass**: the DOM is pruned to actionable elements (buttons, inputs, links, ARIA roles, contenteditable, etc.) and scored against the step's target hint using label/synonym matching, context, and viewport signals.
- **LLM disambiguation**: Gemini picks the best candidate from the top-ranked elements, with page URL/title and per-candidate metadata as context.
- **Known workflows skip the LLM entirely**: common tasks (Aadhaar, PAN, banking, shopping, login, etc.) run from a pre-defined step registry, so there's no step-generation call and no hallucination risk.
- **Human-in-the-loop fallback**: if confidence is too low, the extension asks you to click the element manually and resumes automatically.
- **Reversible highlighting**: a soft glow ring and step badge are used instead of intrusive overlays, and are always cleared before the next highlight.

## Features

- Goal-based page navigation via the popup or side panel
- Pre-built workflow library for common government/finance/shopping tasks (no LLM call needed)
- Gemini-powered step generation and element identification for everything else
- Cross-frame (iframe) support with main-frame preference
- Step verification (detects errors before advancing) and automatic recovery/re-rank on low confidence
- Session history and an internal accuracy dashboard for development use

## Project Structure

```text
neuroadapt-ai/
  manifest.json              # MV3 manifest
  background.js              # Service worker — state machine, message bus, Gemini calls
  content.js                 # Content script orchestrator (runs in every frame)
  config.js                  # Gemini API key, generated from .env (gitignored, never committed)
  config.example.js          # Template for config.js
  scripts/generate-config.js # Reads .env, writes config.js
  popup.html / popup.js      # Extension popup UI
  sidepanel.html / sidepanel.js  # Copilot side panel UI
  debug-panel.html / debug-panel.js  # Developer-only accuracy/session dashboard
  engine/
    pruner.js                # DOM pruner — finds actionable elements
    observer.js               # MutationObserver wrapper (debounced re-prune)
    ranker.js                 # Deterministic candidate ranker
    highlighter.js             # Element highlight ring + step badge
    llm.js                    # Gemini API abstraction
  workflows/
    registry.js               # Pre-defined step sequences for known tasks
  styles/
    highlight.css             # Injected page styles for highlighting
    popup.css
    sidepanel.css
  icons/
  public/
```

## Prerequisites

- Google Chrome
- A Gemini API key (used for step generation, element disambiguation, and step explanations when a task isn't a known workflow)

## Setup

This extension has no bundler — it runs directly from source. The only build step is generating `config.js` (gitignored) from your local `.env`.

1. Create a `.env` file at the project root:
   ```
   GEMINI_API_KEY=your-gemini-api-key
   ```
2. Run `npm run generate-config` to produce `config.js` from it.
3. Open Chrome and go to `chrome://extensions`.
4. Turn on **Developer mode** (top-right).
5. Click **Load unpacked** and select the `neuroadapt-ai` folder.
6. Pin **NeuroAdapt AI** from the extensions toolbar.

Re-run `npm run generate-config` any time you change the key in `.env`, then reload the extension.

## Using It

1. Click the **NeuroAdapt AI** icon (or open the side panel).
2. Describe your goal in plain language.
3. Click **Start Navigation** — the extension highlights the next element to interact with and advances automatically as you complete each step.
4. If it isn't confident about an element, it asks you to click the target manually and continues from there.

## Debugging

Enable verbose logging from any page's DevTools console:

```js
window.NA_DEBUG = true
```

From the background service worker console (`chrome://extensions` → Inspect service worker):

```js
self.__naDebug = true
```

The developer debug panel (session history, per-step timings, LLM traces) is reachable via `Alt+Shift+D` in the popup and is not exposed to normal users.

## Permissions

| Permission | Reason |
|---|---|
| `activeTab` | Read the current tab and send messages |
| `scripting` | Inject content scripts |
| `storage` | Persist state and session history |
| `webNavigation` | Enumerate frames for cross-iframe ranking |
| `sidePanel` | Open and control the side panel |
| `host_permissions: <all_urls>` | Operate on any page the user navigates to |
