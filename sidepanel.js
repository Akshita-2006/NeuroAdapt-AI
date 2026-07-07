/**
 * NeuroAdapt AI — Side Panel Script (Phase 4)
 * Full copilot view: step list, live status, HITL fallback banner,
 * LLM explanation bubble (Phase 5 fills this in).
 */

console.log('[NeuroAdapt] Side panel opened.');

// ── DOM refs ──────────────────────────────────────────────────────────────
const statusDot      = document.getElementById('na-panel-status-dot');
const stepText       = document.getElementById('na-step-text');
const stepsListEl    = document.getElementById('na-steps-list');
const explanationSec = document.getElementById('na-explanation-section');
const explanationBub = document.getElementById('na-explanation-bubble');
const fallbackSec    = document.getElementById('na-panel-fallback');
const fallbackMsgEl  = document.getElementById('na-panel-fallback-msg');
const cancelBtn      = document.getElementById('na-panel-cancel-btn');
const goalInput      = document.getElementById('na-panel-goal');
const startBtn       = document.getElementById('na-panel-start-btn');

// ── Status label map ──────────────────────────────────────────────────────
const STATUS_LABELS = {
  idle:              'Ready',
  navigating:        'Navigating',
  waiting_for_human: 'Needs your help',
  complete:          'Complete',
  error:             'Error',
};

// ── Render helpers ────────────────────────────────────────────────────────
function renderSteps(steps, currentIndex) {
  stepsListEl.innerHTML = '';
  if (!steps?.length) return;

  steps.forEach((label, i) => {
    const li = document.createElement('li');
    li.className = 'na-panel__step';
    if      (i < currentIndex)  li.dataset.state = 'done';
    else if (i === currentIndex) li.dataset.state = 'active';
    else                         li.dataset.state = 'pending';
    li.textContent = label;
    stepsListEl.appendChild(li);
  });
}

function renderState(state) {
  const {
    status,
    stepsList,
    currentStepIndex,
    topScore,
    topLabel,
    llmExplanation,
    fallbackPrompt,
  } = state;

  // Status dot
  statusDot.dataset.status = status;

  // Current step text
  const idx = currentStepIndex ?? 0;
  if (stepsList?.length) {
    stepText.textContent = status === 'complete'
      ? 'All steps completed!'
      : `Step ${idx + 1} / ${stepsList.length}: ${stepsList[idx]}`;
  } else {
    stepText.textContent = STATUS_LABELS[status] ?? status;
  }

  // Step list
  renderSteps(stepsList, idx);

  // LLM explanation bubble (Phase 5 populates this)
  if (llmExplanation) {
    explanationBub.textContent = llmExplanation;
    explanationSec.hidden = false;
  } else if (topLabel && status === 'navigating') {
    // Fallback micro-explanation from the ranker result
    explanationBub.textContent =
      topScore >= 70
        ? `Found "${topLabel}" with high confidence (${topScore}/100).`
        : `Best match: "${topLabel}" — score ${topScore}/100.`;
    explanationSec.hidden = false;
  } else {
    explanationSec.hidden = true;
  }

  // HITL fallback banner
  if (status === 'waiting_for_human') {
    fallbackMsgEl.textContent = fallbackPrompt ?? 'Please click the element on the page.';
    fallbackSec.hidden = false;
  } else {
    fallbackSec.hidden = true;
  }

  // Start button label adapts to state
  if (status === 'navigating') {
    startBtn.textContent = 'Next Step →';
    startBtn.disabled    = false;
    goalInput.disabled   = true;
  } else if (status === 'waiting_for_human') {
    startBtn.textContent = 'Waiting…';
    startBtn.disabled    = true;   // prevent accidental goal restart during HITL
    goalInput.disabled   = true;
  } else {
    startBtn.textContent = 'Start';
    startBtn.disabled    = false;
    goalInput.disabled   = false;
  }
}

// ── On panel open: sync state from background ─────────────────────────────
chrome.runtime.sendMessage({ type: 'NA_GET_STATE' }, (resp) => {
  if (chrome.runtime.lastError) {
    console.warn('[NeuroAdapt] NA_GET_STATE error:', chrome.runtime.lastError.message);
    return;
  }
  if (resp?.ok) renderState(resp.state);
});

// ── Live state updates ────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'NA_STATE_UPDATE') renderState(message.state);
});

// ── Start / Next button ───────────────────────────────────────────────────
startBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) { console.warn('[NeuroAdapt] No active tab.'); return; }

  // If mid-navigation, act as "Next Step"
  const resp = await chrome.runtime.sendMessage({ type: 'NA_GET_STATE' });
  if (resp?.state?.status === 'navigating') {
    chrome.runtime.sendMessage({ type: 'NA_NEXT_STEP' });
    return;
  }

  const goal = goalInput.value.trim();
  if (!goal) { goalInput.focus(); return; }

  console.log('[NeuroAdapt] Side panel: starting goal:', goal, 'tab', tab.id);
  startBtn.disabled    = true;
  startBtn.textContent = 'Starting…';

  chrome.runtime.sendMessage(
    { type: 'NA_SET_GOAL', goal, tabId: tab.id },
    (r) => {
      startBtn.disabled = false;
      if (!r?.ok) console.error('[NeuroAdapt] NA_SET_GOAL failed:', r?.error);
    }
  );
});

// ── Cancel button ─────────────────────────────────────────────────────────
cancelBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'NA_CANCEL' });
});

