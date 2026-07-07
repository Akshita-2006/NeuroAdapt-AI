/**
 * NeuroAdapt Engine — DOM MutationObserver (v2)
 *
 * Exposes: window.NeuroAdaptEngine.Observer
 *
 * Changes from v1:
 *  - Filters NeuroAdapt's own DOM mutations (badge, glow ring) so that
 *    inserting/removing the highlight badge does not trigger a re-rank loop.
 *  - pauseAround() now stores the root and correctly re-attaches the observer.
 *  - Debounce raised to 400 ms for better SPA compatibility.
 */

window.NeuroAdaptEngine = window.NeuroAdaptEngine || {};

(() => {
  const DEBOUNCE_MS = 400;

  /**
   * Returns true if a DOM node is one of NeuroAdapt's own injected elements.
   * These mutations must never trigger a re-rank — doing so creates an
   * infinite loop (highlight → mutation → re-rank → highlight → …).
   *
   * Detection rules (any match → owned):
   *   1. id starts with "na-"        (e.g. na-step-badge)
   *   2. data-neuroadapt attribute present
   *   3. ALL class names start with "na-"  (e.g. na-highlight, na-highlight--pulse)
   */
  function isNaOwnedNode(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    if (node.id?.startsWith('na-'))          return true;
    if (node.dataset?.neuroadapt != null)    return true;
    if (node.classList?.length > 0) {
      return [...node.classList].every((c) => c.startsWith('na-'));
    }
    return false;
  }

  class Observer {
    constructor(onUpdate) {
      if (typeof onUpdate !== 'function') {
        throw new TypeError('[NeuroAdapt] Observer requires an onUpdate callback.');
      }
      this._onUpdate         = onUpdate;
      this._mo               = null;
      this._root             = null; // stored so pauseAround() can reconnect
      this._debounceTimer    = null;
      this._pendingMutations = [];
      console.log('[NeuroAdapt] Observer v2 ready.');
    }

    /**
     * Start watching `root` for element additions and removals.
     * Safe to call multiple times — disconnects the previous observer first.
     */
    observe(root = document.body) {
      this.disconnect();
      this._root = root;
      this._attach();
      console.log('[NeuroAdapt] Observer watching:', root.tagName || 'document.body');
    }

    disconnect() {
      clearTimeout(this._debounceTimer);
      this._pendingMutations = [];
      this._mo?.disconnect();
      this._mo = null;
    }

    /**
     * Pause observation, run `fn` (which may mutate the DOM), then resume.
     * Prevents any mutations made by `fn` from triggering the re-rank callback.
     */
    pauseAround(fn) {
      this._mo?.disconnect();
      try {
        fn();
      } finally {
        if (this._root) this._attach();
      }
    }

    // ── Private ───────────────────────────────────────────────────────────────

    _attach() {
      this._mo = new MutationObserver((mutations) => {
        const structural = mutations.filter((m) => {
          if (m.type !== 'childList') return false;

          const nodes    = [...m.addedNodes, ...m.removedNodes];
          const elements = nodes.filter((n) => n.nodeType === Node.ELEMENT_NODE);

          if (!elements.length) return false;

          // Skip if EVERY element in this mutation batch belongs to NeuroAdapt.
          // Mixed batches (NeuroAdapt + page content) are still forwarded.
          if (elements.every(isNaOwnedNode)) return false;

          return true;
        });

        if (!structural.length) return;

        this._pendingMutations.push(...structural);
        clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => {
          const batch = this._pendingMutations.splice(0);
          console.log(
            `[NeuroAdapt] Observer: ${batch.length} structural mutation(s) — triggering re-prune.`
          );
          this._onUpdate(batch);
        }, DEBOUNCE_MS);
      });

      this._mo.observe(this._root, {
        childList: true,
        subtree:   true,
      });
    }
  }

  window.NeuroAdaptEngine.Observer = Observer;
})();
