# NeuroAdapt AI

NeuroAdapt AI is a Chrome extension that acts like an AI accessibility copilot for the web. It analyzes the current page, detects accessibility and usability barriers, recommends a user persona, applies reversible page adaptations, and explains what changed through a floating assistant.

The app supports local heuristic analysis and real Gemini-powered reasoning when you add your Google Gemini API key in the extension popup.

## Features

- **AI page analysis**: uses a structured DOM summary instead of sending full raw HTML.
- **Gemini integration**: routes AI requests through the Manifest V3 background service worker.
- **Persona modes**: Elderly User, Visually Impaired User, First-Time Internet User, Patient, and Auto Detect.
- **First-Time User guidance**: highlights likely next actions, adds numbered step badges, guides form fields, and reduces distracting side content.
- **Reversible adaptation**: Reset restores the original page styling.
- **Floating assistant**: shows page findings, accessibility score, issues, recommendations, and guidance.
- **Before/After comparison**: switch between original and adapted page states.
- **Speech summary**: reads out the current page challenges or guidance.
- **Gemini test button**: verifies that your saved API key works before using it on a real page.

## Tech Stack

- React 18
- TypeScript
- Vite
- Tailwind CSS
- Chrome Extension Manifest V3
- Google Gemini API

## Project Structure

```text
neuroadapt-ai/
  public/
    logo.svg
  src/
    background/
      index.ts              # MV3 service worker and Gemini routing
    content/
      ContentApp.tsx        # Floating assistant and page actions
      contentStyles.ts      # Shadow DOM overlay styles
      index.tsx             # Content script mount
    popup/
      PopupApp.tsx          # Extension popup controls
      main.tsx
    shared/
      adaptation.ts         # Reversible DOM transformations
      aiSchema.ts           # Gemini JSON parsing and validation
      chrome.ts             # Chrome API helpers
      gemini.ts             # Gemini request client and prompts
      heuristics.ts         # Local interaction heuristics
      messaging.ts          # Typed extension messages
      pageInsights.ts       # Local page metrics
      pageSummary.ts        # Structured DOM extraction
      storage.ts            # Chrome/local storage helpers
      types.ts              # Shared app types
  manifest.json             # Extension manifest
  popup.html
  vite.config.ts
  vite.content.config.ts
```

## Prerequisites

- Node.js installed
- Google Chrome installed
- A Google Gemini API key if you want real AI reasoning

You can still run the extension without a Gemini key. In that case, NeuroAdapt falls back to local heuristic analysis.

## Install Dependencies

Open PowerShell in the project folder:

```powershell
cd neuroadapt-ai
npm.cmd install
```

Use `npm.cmd` on Windows because PowerShell may block the `npm.ps1` shim depending on your execution policy.

## Build The Extension

```powershell
npm.cmd run build
```

This creates the production extension files in:

```text
neuroadapt-ai\dist
```

## Load The Extension In Chrome

1. Open Chrome.
2. Go to `chrome://extensions`.
3. Turn on **Developer mode** in the top-right.
4. Click **Load unpacked**.
5. Select this folder:

```text
dist
```

6. NeuroAdapt AI should appear in the extension list.
7. Click the puzzle-piece icon in Chrome and pin **NeuroAdapt AI**.

## Add Your Gemini API Key

1. Click the pinned **NeuroAdapt AI** extension icon.
2. Find the **Gemini API Key** section.
3. Paste your Gemini API key into the **API key** field.
4. Keep the default model or change it if needed.
5. Click **Save key**.
6. Click **Test**.

If Gemini is working, you should see a success message like:

```text
Gemini working. Persona: First-Time Internet User, sc
