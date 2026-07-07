/**
 * NeuroAdapt Engine — Element Highlighter
 *
 * Exposes: window.NeuroAdaptEngine.Highlighter
 *
 * Draws attention to ONE element at a time using:
 *  - A soft outline glow on the element itself
 *  - A small floating badge anchored just outside the element (not over content)
 *
 * The badge auto-fades after 4 s so it stops being a distraction once noticed.
 */

window.NeuroAdaptEngine = window.NeuroAdaptEngine || {};

(() => {

  const BADGE_ID    = 'na-step-badge';
  const HL_CLASS    = 'na-highlight';
  const PULSE_CLASS = 'na-highlight--pulse';

  class Highlighter {
    constructor() {
      this._current      = null;
      this._fadeTimer    = null;
      this._scrollTimer  = null;
      console.log('[NeuroAdapt] Highlighter ready.');
    }

    /**
     * Highlight `element` with a glow and a small corner badge.
     *
     * @param {HTMLElement} element
     * @param {object}  [opts]
     * @param {string}  [opts.tooltip]  Short label for the badge (step name)
     * @param {boolean} [opts.scroll]   Scroll into view (default: true)
     * @param {number}  [opts.score]    Internal score — NOT shown to user
     */
    highlight(element, opts = {}) {
      if (!(element instanceof Element)) {
        console.warn('[NeuroAdapt] Highlighter.highlight(): invalid element', element);
        return;
      }

      this.clear();

      const { tooltip, scroll = true } = opts;

      // Glow ring
      element.classList.add(HL_CLASS, PULSE_CLASS);
      this._current = element;

      // Scroll smoothly — delay slightly so layout is stable
      if (scroll) {
        this._scrollTimer = setTimeout(() => {
          element.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
        }, 80);
      }

      // Small badge with step label
      if (tooltip) {
        this._showBadge(element, tooltip);
      }

      console.log(
        `[NeuroAdapt] Highlighted <${element.tagName.toLowerCase()}>` +
        ` "${(element.innerText?.trim() || element.getAttribute('aria-label') || '').slice(0, 60)}"`
      );
    }

    clear() {
      clearTimeout(this._fadeTimer);
      clearTimeout(this._scrollTimer);
      this._resizeObs?.disconnect();
      this._resizeObs = null;

      if (this._current) {
        this._current.classList.remove(HL_CLASS, PULSE_CLASS);
        this._current = null;
      }

      document.getElementById(BADGE_ID)?.remove();
    }

    // ── Private ───────────────────────────────────────────────────────────────

    _showBadge(element, label) {
      document.getElementById(BADGE_ID)?.remove();

      const badge       = document.createElement('div');
      badge.id          = BADGE_ID;
      badge.textContent = `▶ ${label}`;
      document.body.appendChild(badge);

      this._placeBadge(badge, element);

      // Re-position on resize
      this._resizeObs = new ResizeObserver(() => this._placeBadge(badge, element));
      this._resizeObs.observe(document.documentElement);

      // Auto-fade after 4 s so it doesn't linger
      this._fadeTimer = setTimeout(() => {
        badge.classList.add('na-badge--fading');
        setTimeout(() => badge.remove(), 400);
      }, 4000);
    }

    _placeBadge(badge, element) {
      const rect    = element.getBoundingClientRect();
      const scrollX = window.scrollX;
      const scrollY = window.scrollY;

      // Prefer top-right corner; shift left if it would clip the viewport
      const badgeW  = badge.offsetWidth || 120;
      const GAP     = 4;

      let top  = rect.top  + scrollY - badge.offsetHeight - GAP;
      let left = rect.right + scrollX - badgeW;

      // If above viewport top, place below the element instead
      if (top - scrollY < 4) {
        top = rect.bottom + scrollY + GAP;
      }

      // Clamp to viewport width
      const maxLeft = scrollX + window.innerWidth - badgeW - 4;
      left = Math.max(scrollX + 4, Math.min(left, maxLeft));

      badge.style.top  = `${top}px`;
      badge.style.left = `${left}px`;
    }
  }

  window.NeuroAdaptEngine.Highlighter = Highlighter;
})();
