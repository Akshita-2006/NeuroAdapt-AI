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
];
