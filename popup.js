/**
 * NeuroAdapt AI — Popup Script (Phase 4)
 * Sends NA_SET_GOAL / NA_CANCEL / NA_NEXT_STEP to the background state machine
 * and mirrors state changes via NA_STATE_UPDATE.
 */

console.log('[NeuroAdapt] Popup opened.');

// ── DOM refs ──────────────────────────────────────────────────────────────
const startBtn        = document.getElementById('na-start-btn');
const cancelBtn       = document.getElementById('na-cancel-btn');
const sidepanelBtn    = document.getElementById('na-sidepanel-btn');
const goalInput       = document.getElementById('na-goal-input');
const statusLabel     = document.getElementById('na-status-label');
const statusDot       = document.getElementById('na-status-dot');
const goalSection     = document.getElementById('na-goal-section');
const fallbackSection = document.getElementById('na-fallback-section');
const fallbackMsg     = document.getElementById('na-fallback-msg');

// ── Status label map ──────────────────────────────────────────────────────
const STATUS_LABELS = {
  idle:              'Idle',
  navigating:        'Navigating…',
  waiting_for_human: 'Waiting for you…',
  complete:          'Done ✓',
  error:             'Error',
};

// ── Render state ──────────────────────────────────────────────────────────
function renderState(state) {
  const { status, fallbackPrompt, stepsList, currentStepIndex } = state;

  statusDot.dataset.status  = status;
  statusLabel.textContent   = STATUS_LABELS[status] ?? status;

  if (status === 'waiting_for_human') {
    goalSection.hidden     = true;
    fallbackSection.hidden = false;
    fallbackMsg.textContent = fallbackPrompt ?? 'Please click the element on the page.';
  } else if (status === 'complete' || status === 'idle') {
    goalSection.hidden     = false;
    fallbackSection.hidden = true;
  } else if (status === 'navigating') {
    goalSection.hidden     = false;
    fallbackSection.hidden = true;

    // Update button label to show progress
    if (stepsList?.length) {
      const step = stepsList[currentStepIndex ?? 0];
      startBtn.textContent = `Step ${(currentStepIndex ?? 0) + 1}/${stepsList.length}: Next →`;
      startBtn.title = step;
    }
  }
}

// ── On popup open: sync current state from background ─────────────────────
chrome.runtime.sendMessage({ type: 'NA_GET_STATE' }, (resp) => {
  if (chrome.runtime.lastError) {
    console.warn('[NeuroAdapt] NA_GET_STATE error:', chrome.runtime.lastError.message);
    return;
  }
  if (resp?.ok) renderState(resp.state);
});

// ── Listen for live state updates ─────────────────────────────────────────
chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'NA_STATE_UPDATE') renderState(message.state);
});

// ── Start / Next button ───────────────────────────────────────────────────
startBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;

  const goal = goalInput.value.trim();

  // If we're mid-navigation, this button becomes "Next Step"
  const resp = await chrome.runtime.sendMessage({ type: 'NA_GET_STATE' });
  if (resp?.state?.status === 'navigating') {
    chrome.runtime.sendMessage({ type: 'NA_NEXT_STEP' });
    return;
  }

  if (!goal) { goalInput.focus(); return; }

  console.log('[NeuroAdapt] Popup: starting goal:', goal, 'in tab', tab.id);
  startBtn.disabled    = true;
  startBtn.textContent = 'Starting…';

  chrome.runtime.sendMessage(
    { type: 'NA_SET_GOAL', goal, tabId: tab.id },
    (r) => {
      startBtn.disabled = false;
      if (!r?.ok) {
        console.error('[NeuroAdapt] NA_SET_GOAL failed:', r?.error);
        startBtn.textContent = 'Start Navigation';
      }
    }
  );
});

// ── Cancel button ─────────────────────────────────────────────────────────
cancelBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'NA_CANCEL' });
  goalSection.hidden     = false;
  fallbackSection.hidden = true;
  startBtn.textContent   = 'Start Navigation';
  startBtn.disabled      = false;
  goalInput.value        = '';
});

// ── Open side panel ───────────────────────────────────────────────────────
sidepanelBtn.addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) chrome.sidePanel.open({ tabId: tab.id });
});

