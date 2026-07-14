'use strict';

/**
 * Multi-page accuracy fixtures.
 *
 * Each step's `guessedStep` simulates what generateSteps() plans sight-unseen
 * for a page it hasn't navigated to yet (its own prompt literally says "For
 * steps on FUTURE PAGES: use your best knowledge of what that page will
 * show"). `page` is the REAL page that step actually runs on, deliberately
 * worded differently from the generic guess and seeded with decoy elements
 * that share keywords with the guess, so a naive keyword match has a real
 * chance of picking the wrong one — only grounding in the actual page
 * content (refineStepForPage) or LLM semantic reasoning (identifyElement)
 * should reliably land on the correct element.
 *
 * Most of these fixtures still have a *correct* deterministic baseline (the
 * guessed label happens to score highest even before refining) — they test
 * that the ranker/pruner fixes hold up, and that refineStepForPage doesn't
 * regress a baseline that was already right. `shipping-speed-decoy` is
 * deliberately different: its correct answer ("Get it tomorrow") shares no
 * keywords at all with the guess or its alternatives, while a wrong button
 * ("Get it in 5 days") fuzzy-matches on "day"/"days" and wins the
 * deterministic ranking outright. It exists to give refineStepForPage actual
 * test coverage of the case it's for — rescuing a confidently-wrong guess —
 * not just re-confirming a guess that was already fine.
 */

const LOGIN_PAGE_HTML = `
  <header>
    <input id="promo-email" placeholder="Subscribe with your email for offers" name="promo" />
    <button id="promo-subscribe">Subscribe</button>
  </header>
  <main>
    <h1>Client Portal Access</h1>
    <form>
      <label for="uid">Client ID or Registered Email</label>
      <input type="text" id="uid" name="uid" />
      <label for="pwd">Secret Passphrase</label>
      <input type="password" id="pwd" name="pwd" />
      <button type="submit" id="submit-portal">Enter Portal</button>
      <a href="/forgot" id="forgot-link">Forgot passphrase?</a>
    </form>
    <button id="cta-new-account">Create New Account</button>
  </main>
  <footer>
    <a href="/support" id="contact-support">Contact Support</a>
    <a href="/about" id="about-link">About Us</a>
  </footer>`;

const SIGNUP_TYPE_HTML = `
  <header>
    <a href="/login" id="nav-signin">Sign in instead</a>
  </header>
  <main>
    <h1>Choose your account type</h1>
    <button id="acct-personal">I'm shopping for myself</button>
    <button id="acct-business">I run a business</button>
    <a href="/learn" id="learn-more">Learn more about accounts</a>
  </main>`;

const SIGNUP_PROFILE_HTML = `
  <header>
    <input id="site-search" placeholder="Search help articles" name="q" />
  </header>
  <main>
    <h1>Create your profile</h1>
    <label for="handle">Pick a nickname</label>
    <input id="handle" name="handle" />
    <label for="mail">Where should we send updates?</label>
    <input id="mail" name="mail" type="email" />
    <label>
      <input type="checkbox" id="newsletter-opt" name="newsletter" />
      Email me weekly deals
    </label>
    <button id="skip-profile">Skip for now</button>
    <button id="finish-signup">Start shopping</button>
  </main>`;

const CART_HTML = `
  <header>
    <a href="/shop" id="continue-shopping">Continue shopping</a>
  </header>
  <main>
    <h1>Your bag</h1>
    <p>1 item</p>
    <input id="coupon-code" placeholder="Coupon code" name="coupon" />
    <button id="apply-coupon">Apply</button>
    <button id="go-checkout">Take my money</button>
  </main>`;

const PAYMENT_HTML = `
  <header>
    <button id="paypal-instead">Use PayPal instead</button>
  </header>
  <main>
    <h1>Payment</h1>
    <label for="cc">Card digits</label>
    <input id="cc" name="cc" />
    <label>
      <input type="checkbox" id="save-card" name="save-card" />
      Save card for later
    </label>
    <button id="finalize-order">Ship it</button>
  </main>`;

const NOTIFICATION_PREFS_HTML = `
  <main>
    <h1>Notification Preferences</h1>
    <label for="field-a">Email notifications</label>
    <input id="field-a" name="field-a" placeholder="Where to send updates" />
    <label>
      <input type="checkbox" id="field-b" name="field-b" />
      Keep me posted
    </label>
    <button id="save-prefs">Save preferences</button>
  </main>`;

const SHIPPING_HTML = `
  <main>
    <h1>Choose delivery method</h1>
    <button id="opt-a">Get it in 5 days</button>
    <button id="opt-b">Get it tomorrow</button>
    <button id="opt-c">I'll wait, that's fine</button>
  </main>`;

const PRODUCT_PAGE_HTML = `
  <main>
    <h1>Wireless Headphones</h1>
    <button id="opt-a">Add to Cart</button>
    <button id="opt-b">Buy Now</button>
  </main>`;

const CONTACT_DETAILS_HTML = `
  <main>
    <h1>Contact Details</h1>
    <input id="field-a" type="email" name="field-a" />
    <button type="submit" id="field-b">Continue</button>
  </main>`;

const NEWSLETTER_SIBLING_HTML = `
  <main>
    <h1>Preferences</h1>
    <div><input type="checkbox" id="field-b" name="opt2" /><label>Enable dark mode</label></div>
    <div><input type="checkbox" id="field-a" name="opt1" /><label>Subscribe to newsletter</label></div>
  </main>`;

const SHOP_FILTERS_HTML = `
  <main>
    <h1>Shop</h1>
    <select id="field-b">
      <option>Filter by price: Low to High</option>
      <option>Filter by price: High to Low</option>
    </select>
    <select id="field-a" name="price-range"><option>USD</option><option>EUR</option></select>
  </main>`;

const AGREEMENT_HTML = `
  <main>
    <h1>Preferences</h1>
    <label><input type="checkbox" id="field-a" name="agree" />I agree to the terms</label>
    <label><input type="radio" id="field-b" name="pref" />Prefer email contact</label>
  </main>`;

const CHECKOUT_MULTISTEP_HTML = `
  <main>
    <section><h2>Shipping Address</h2><button id="field-a" type="submit">Continue</button></section>
    <section><h2>Payment Details</h2><button id="field-b" type="submit">Continue</button></section>
    <section><h2>Review Order</h2><button id="field-c" type="submit">Continue</button></section>
  </main>`;

const SOCIAL_SETTINGS_HTML = `
  <main>
    <h1>Account Settings</h1>
    <input id="field-a" placeholder="Pinterest handle" name="field-a" />
    <input id="field-b" placeholder="PIN" name="field-b" />
  </main>`;

const NEWSLETTER_TOGGLE_HTML = `
  <main>
    <h1>Preferences</h1>
    <label class="toggle-switch">
      <input type="checkbox" id="subscribe" style="opacity:0;position:absolute;" />
      <span class="toggle-slider"></span>
      Subscribe to newsletter
    </label>
    <button id="no-thanks">No thanks</button>
  </main>`;

module.exports = [
  {
    name: 'login-portal',
    steps: [
      {
        page: { url: 'https://acme.test/portal', title: 'Client Portal Access', html: LOGIN_PAGE_HTML },
        guessedStep: {
          hint: 'Enter your email address',
          targetLabel: 'Email',
          action: 'type',
          alternatives: ['Email address', 'Username', 'Enter email'],
          elementType: 'input',
          zone: 'main',
        },
        correctSelector: '#uid',
      },
      {
        page: { url: 'https://acme.test/portal', title: 'Client Portal Access', html: LOGIN_PAGE_HTML },
        guessedStep: {
          hint: 'Click the Sign in button',
          targetLabel: 'Sign in',
          action: 'click',
          alternatives: ['Log in', 'Login', 'Sign In'],
          elementType: 'button',
          zone: 'main',
        },
        correctSelector: '#submit-portal',
      },
    ],
  },

  {
    name: 'signup-account-type',
    steps: [
      {
        page: { url: 'https://shoply.test/join/type', title: 'Choose your account type', html: SIGNUP_TYPE_HTML },
        guessedStep: {
          hint: 'Select a personal account',
          targetLabel: 'Personal',
          action: 'click',
          alternatives: ['Personal account', 'Individual', 'For myself'],
          elementType: 'button',
          zone: 'main',
        },
        correctSelector: '#acct-personal',
      },
      {
        page: { url: 'https://shoply.test/join/profile', title: 'Create your profile', html: SIGNUP_PROFILE_HTML },
        guessedStep: {
          hint: 'Enter your email address',
          targetLabel: 'Email address',
          action: 'type',
          alternatives: ['Email', 'Your email', 'Username'],
          elementType: 'input',
          zone: 'main',
        },
        correctSelector: '#mail',
      },
      {
        page: { url: 'https://shoply.test/join/profile', title: 'Create your profile', html: SIGNUP_PROFILE_HTML },
        guessedStep: {
          hint: 'Submit registration button',
          targetLabel: 'Submit',
          action: 'click',
          alternatives: ['Create account', 'Register', 'Sign up'],
          elementType: 'button',
          zone: 'main',
        },
        correctSelector: '#finish-signup',
      },
    ],
  },

  {
    name: 'checkout-unusual-wording',
    steps: [
      {
        page: { url: 'https://gearup.test/cart', title: 'Your bag', html: CART_HTML },
        guessedStep: {
          hint: 'Click the checkout button',
          targetLabel: 'Checkout',
          action: 'click',
          alternatives: ['Buy now', 'Proceed to checkout', 'Place order'],
          elementType: 'button',
          zone: 'main',
        },
        correctSelector: '#go-checkout',
      },
      {
        page: { url: 'https://gearup.test/pay', title: 'Payment', html: PAYMENT_HTML },
        guessedStep: {
          hint: 'Place order button',
          targetLabel: 'Place order',
          action: 'click',
          alternatives: ['Confirm payment', 'Pay now', 'Complete purchase'],
          elementType: 'button',
          zone: 'main',
        },
        correctSelector: '#finalize-order',
      },
    ],
  },

  {
    // Exercises a "check" step (not "type"): the genuine checkbox is worded
    // nothing like the hint ("Keep me posted"), while a plain text field
    // elsewhere on the page happens to be captioned with the hint's exact
    // words ("Email notifications"). A keyword-only match would grab the
    // text field purely on label strength — only recognizing that a
    // checkbox step structurally cannot resolve to a text input should
    // save it.
    name: 'notification-prefs-checkbox',
    steps: [
      {
        page: { url: 'https://acme.test/prefs', title: 'Notification Preferences', html: NOTIFICATION_PREFS_HTML },
        guessedStep: {
          hint: 'Turn on email notifications',
          targetLabel: 'Email notifications',
          action: 'check',
          alternatives: ['Enable notifications', 'Notify me', 'Email alerts'],
          elementType: 'checkbox',
          zone: 'main',
        },
        correctSelector: '#field-b',
      },
    ],
  },

  {
    // The one fixture where the deterministic baseline is EXPECTED to fail:
    // "Get it in 5 days" fuzzy-matches "day"/"days" from the "Next day
    // delivery" alternative and wins the keyword ranking outright, even
    // though the actually-correct button ("Get it tomorrow") shares no
    // keywords with the guess or any of its alternatives at all. Only
    // grounding against the real page — understanding that "tomorrow" means
    // fastest — recovers the right answer. See test/runAccuracy.js: this is
    // the case that gives refineStepForPage real test coverage, since every
    // other scenario's baseline guess was already correct.
    name: 'shipping-speed-decoy',
    steps: [
      {
        page: { url: 'https://gearup.test/shipping', title: 'Choose delivery method', html: SHIPPING_HTML },
        guessedStep: {
          hint: 'Choose the fastest shipping option',
          targetLabel: 'Express shipping',
          action: 'click',
          alternatives: ['Fast shipping', 'Next day delivery', 'Expedited shipping'],
          elementType: 'button',
          zone: 'main',
        },
        correctSelector: '#opt-b',
      },
    ],
  },

  {
    // Regression test for the buy/cart synonym-cluster split (SYNONYM_CLUSTERS
    // in engine/ranker.js). "Add to Cart" and "Buy Now" are two distinct,
    // simultaneously-visible actions on a real product page. Neither label
    // exactly matches the deliberately ambiguous single-token hint "Buy", so
    // both candidates are scored purely through the fuzzy synonym-matching
    // loop. Before the fix, "add to cart" was listed as a literal synonym
    // phrase of "buy", so both buttons tied on label similarity and the
    // ranker fell back to DOM order — silently picking the wrong (first)
    // button. After the fix, only "Buy Now" matches.
    name: 'buy-now-vs-add-to-cart',
    steps: [
      {
        page: { url: 'https://gearup.test/product/42', title: 'Wireless Headphones', html: PRODUCT_PAGE_HTML },
        guessedStep: {
          hint: 'Click the Buy Now button',
          targetLabel: 'Buy',
          action: 'click',
          alternatives: [],
          elementType: 'button',
          zone: 'main',
        },
        correctSelector: '#opt-b',
      },
    ],
  },

  {
    // Regression test for isRendered()'s opacity:0 filter (engine/pruner.js).
    // Custom checkbox/toggle widgets commonly hide the native <input>
    // visually via opacity:0 while a styled sibling (here .toggle-slider)
    // acts as the visible control — a standard "visually hidden but still
    // focusable/interactive" technique, not a genuinely-invisible element.
    // Before the fix, isRendered() dropped the checkbox outright (unlike
    // display:none/visibility:hidden, opacity:0 doesn't block interaction),
    // so this widget never reached the ranker as a candidate at all.
    name: 'hidden-checkbox-toggle',
    steps: [
      {
        page: { url: 'https://acme.test/preferences', title: 'Preferences', html: NEWSLETTER_TOGGLE_HTML },
        guessedStep: {
          hint: 'Subscribe to the newsletter',
          targetLabel: 'Subscribe to newsletter',
          action: 'check',
          alternatives: [],
          elementType: 'checkbox',
          zone: 'main',
        },
        correctSelector: '#subscribe',
      },
    ],
  },

  {
    // Regression test for labelSimilarity()'s substring matching
    // (engine/ranker.js). The primary phrase-match check used raw
    // `allText.includes(phrase)` with no word-boundary anchoring, so a short
    // synonym-cluster phrase like "pin" (from the pincode cluster) matched
    // as a substring inside unrelated words — "Pinterest handle" contains
    // "pin" even though it has nothing to do with PIN codes. Both fields
    // share the same tag/type and neutral ids (#field-a/#field-b) so neither
    // structural signals nor id/name leakage can decide the pick — it hinges
    // entirely on label similarity. The decoy is placed first in the DOM so
    // a tie (the pre-fix bug) resolves to the wrong one.
    name: 'pin-substring-decoy',
    steps: [
      {
        page: { url: 'https://acme.test/settings/social', title: 'Account Settings', html: SOCIAL_SETTINGS_HTML },
        guessedStep: {
          hint: 'Type your PIN code',
          targetLabel: 'PIN code',
          action: 'type',
          alternatives: [],
          elementType: 'input',
          zone: 'main',
        },
        correctSelector: '#field-b',
      },
    ],
  },

  {
    // Regression test for the hard-type-keyword loop in scoreNode()
    // (engine/ranker.js). "email"/"phone" are SOFT_TYPE_KEYWORDS, whose loop
    // already evaluates all candidates correctly (only breaks on success) —
    // so this doesn't actually exercise the bug (kept as a sanity check that
    // soft-keyword resolution stays correct). The real bug needs two HARD
    // type keywords, see 'continue-button-or-link' below.
    name: 'phone-or-email-type-conflict',
    steps: [
      {
        page: { url: 'https://acme.test/contact', title: 'Contact Details', html: CONTACT_DETAILS_HTML },
        guessedStep: {
          hint: 'Enter your phone or email',
          targetLabel: 'Phone or email',
          action: 'type',
          alternatives: [],
          elementType: 'input',
          zone: 'main',
        },
        correctSelector: '#field-a',
      },
    ],
  },

  {
    // Regression test for the hard-type-keyword loop in scoreNode()
    // (engine/ranker.js). The loop checked only the FIRST hard type keyword
    // found (Set/token order = hint word order) and broke immediately, even
    // if it failed to match. Hint "Radio or checkbox" checks "radio" first:
    // the genuine <input type="checkbox"> target fails that check and gets
    // wrongly penalized -10, never reaching "checkbox" (which it does
    // satisfy) — while the radio decoy matches "radio" immediately either
    // way. Neither candidate's label text overlaps the hint's content
    // tokens (["radio","checkbox"], since both fall back to raw tokens once
    // PURE_TYPE_DESCRIPTORS strips them from "content"), so label similarity
    // stays 0 for both — only the type-keyword handling decides the pick.
    name: 'radio-or-checkbox-type-conflict',
    steps: [
      {
        page: { url: 'https://acme.test/preferences', title: 'Preferences', html: AGREEMENT_HTML },
        guessedStep: {
          hint: 'Check the Radio or checkbox option',
          targetLabel: 'Radio or checkbox',
          action: 'check',
          alternatives: [],
          elementType: 'checkbox',
          zone: 'main',
        },
        correctSelector: '#field-a',
      },
    ],
  },

  {
    // Regression test for resolveLabel()'s adjacent-sibling fallback
    // (engine/pruner.js). The checkbox has no id/for-based label association
    // and isn't wrapped by a <label> — the label is a plain FOLLOWING
    // sibling (a common real-world pattern), which the fallback chain
    // couldn't see (it only checked previousElementSibling). Without it,
    // resolution falls all the way through to the generic `name="opt1"`
    // attribute, which shares no words with the hint, so the confidence
    // score lands below MIN_CONFIDENCE even though this is the only
    // candidate on the page.
    name: 'checkbox-label-after-sibling',
    steps: [
      {
        page: { url: 'https://acme.test/preferences2', title: 'Preferences', html: NEWSLETTER_SIBLING_HTML },
        guessedStep: {
          hint: 'Subscribe to the newsletter',
          targetLabel: 'Subscribe to newsletter',
          action: 'check',
          alternatives: [],
          elementType: 'checkbox',
          zone: 'main',
        },
        correctSelector: '#field-a',
      },
    ],
  },

  {
    // Regression test for resolveLabel()'s own-text fallback treating a
    // <select>'s textContent (the concatenation of every <option>'s text)
    // as a usable label (engine/pruner.js). Unlike buttons/links, a
    // <select>'s "own text" is never a real label — it's whatever options
    // happen to be inside it, which can coincidentally contain unrelated
    // hint keywords ("Price: Low to High" contains "price" twice) and steal
    // false credit from the actual price-related dropdown elsewhere on the
    // page. Both candidates are <select> elements so structural signals are
    // equal — only the label text differs.
    name: 'select-option-soup-decoy',
    steps: [
      {
        page: { url: 'https://acme.test/shop', title: 'Shop', html: SHOP_FILTERS_HTML },
        guessedStep: {
          hint: 'Filter results by price',
          targetLabel: 'Filter by price',
          action: 'select',
          alternatives: [],
          elementType: 'dropdown',
          zone: 'main',
        },
        correctSelector: '#field-a',
      },
    ],
  },

  {
    // Regression test for the duplicate-label heading-disambiguation bonus
    // (engine/ranker.js, scoreNode's "DUPLICATE LABEL PENALTY" section). Three
    // identically-labeled "Continue" buttons sit in three different sections
    // of a multi-section checkout page — a common real-world pattern
    // (multi-step forms, accordions, review pages). A hint that names the
    // right section by content ("Continue to payment") should win by a
    // clear, noise-safe margin, not a narrow one — parentHeading already
    // contributed a little via the general label-similarity blob before this
    // fix, but this scenario locks in that the margin stays healthy.
    name: 'checkout-duplicate-continue-buttons',
    steps: [
      {
        page: { url: 'https://acme.test/checkout', title: 'Checkout', html: CHECKOUT_MULTISTEP_HTML },
        guessedStep: {
          hint: 'Continue to payment',
          targetLabel: 'Continue to payment',
          action: 'click',
          alternatives: [],
          elementType: 'button',
          zone: 'main',
        },
        correctSelector: '#field-b',
      },
    ],
  },
];
