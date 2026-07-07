/**
 * NeuroAdapt Engine — Target Ranker v3
 *
 * Exposes: window.NeuroAdaptEngine.TargetRanker
 *
 * Score breakdown (max 100):
 *   Label similarity   0 – 50  synonym-aware phrase-level matching
 *   ARIA label bonus   0 –  8  aria-label specifically matches intent
 *   Tag / type         0 – 20  structural correctness (–10 wrong-type penalty)
 *   Context signals    0 – 15  form membership, submit role, autofocus, uniqueness
 *   Viewport           0 – 10  in-viewport bonus; near-viewport smaller bonus
 *   Attribute match    0 –  5  id / name match
 *   Prominence         0 –  5  element width → main input vs icon button
 *   Duplicate penalty  0 – –8  elements sharing an identical label on the page
 *
 * Critical fix (v3): synonym expansion now works for multi-word phrases.
 *   The prior bug: "_tokenize() removes noise words before synonym lookup,
 *   so 'sign in' → 'sign' and PHRASE_TO_CLUSTER.get('sign') = undefined."
 *   Fix: parseHint() pre-scans the raw normalized hint for ALL known
 *   synonym phrases BEFORE tokenization and injects their canonical keys
 *   directly into contentTokens.
 */

window.NeuroAdaptEngine = window.NeuroAdaptEngine || {};

(() => {

  // ══════════════════════════════════════════════════════════════════════════
  // SYNONYM CLUSTERS
  // ══════════════════════════════════════════════════════════════════════════

  const SYNONYM_CLUSTERS = {
    login:         ['sign in','log in','login','signin','log into','enter','access account','hello sign in','sign in to your account','login to your account','member login','user login','log in to your account','already have an account','have an account'],
    register:      ['sign up','register','create account','create an account','join','get started','new account','open account','create new account','register now','join now','create profile','new to','new user','create your account'],
    logout:        ['sign out','log out','logout','signout','log off','exit','sign out of'],
    submit:        ['submit','send','save','confirm','done','complete','apply','finish','go','submit form','send message'],
    next:          ['next','continue','proceed','forward','next step','move on','continue to','next page','go to next'],
    back:          ['back','previous','prev','return','go back'],
    cancel:        ['cancel','close','dismiss','abort','discard','never mind','no thanks','skip'],
    search:        ['search','find','look up','query','search for','search here'],
    buy:           ['buy','purchase','order','add to cart','add to bag','shop now','buy now','checkout','check out','add to basket','buy it now','proceed to checkout','continue to checkout','go to checkout','place order','complete order','confirm order','view cart','view bag','cart','bag'],
    play:          ['play','watch','watch now','play video','start video'],
    download:      ['download','save file','export','get file'],
    upload:        ['upload','attach','import','add file','choose file','browse files','select file'],
    delete:        ['delete','remove','trash','erase','clear'],
    edit:          ['edit','modify','change','update','revise','manage'],
    share:         ['share','share this','send to'],
    help:          ['help','support','contact us','get help','faq','contact support'],
    home:          ['home','homepage','go home'],
    profile:       ['profile','account','my account','my profile','user profile','account settings'],
    menu:          ['menu','navigation','nav','hamburger','open menu','main menu','toggle menu'],
    notifications: ['notifications','alerts','bell','notify'],
    settings:      ['settings','preferences','options','configure'],
    password:      ['password','pass','passcode','secret','enter password','your password','current password','new password'],
    username:      ['username','user name','email','email address','user id','userid','mobile','phone number','enter email','your email'],
    name:          ['full name','your name','first name','last name','surname','name'],
    address:       ['address','street','location','city','state','pincode','zip','postal code','zip code'],
    otp:           ['otp','otp number','one time password','one time passcode','verification code','verify code','enter otp','confirm otp','6 digit code','4 digit code','sms code','enter code','verification pin','enter verification code','mobile verification code','otp code'],
    verify:        ['verify','verification','confirm email','confirm phone','validate','confirm your email','confirm your number','verify your account','verify mobile','verify email'],
    agree:         ['agree','accept','i agree','accept terms','agree to terms','terms and conditions','privacy policy','i accept','agree and continue'],
    mobile:        ['mobile number','mobile','phone','phone number','cell phone','contact number','enter mobile','your mobile','phone no','mobile no','enter phone','your phone'],
    dob:           ['date of birth','birth date','dob','birthday','date of birth','your birthday'],
    google:        ['sign in with google','continue with google','google','login with google','google sign in'],
    facebook:      ['sign in with facebook','continue with facebook','facebook','login with facebook'],
    apple:         ['sign in with apple','continue with apple','apple','login with apple'],
    amount:        ['amount','price','value','total','cost','enter amount','payment amount'],
    promo:         ['promo code','coupon','discount code','voucher','promo','coupon code','apply coupon'],
    pincode:       ['pincode','pin','zip','postal','zip code','postal code','area code'],
    gender:        ['gender','sex','male','female','select gender'],
    captcha:       ['captcha','verify you are human','robot check','security check','i am not a robot'],
    quantity:      ['quantity','qty','number of items','how many','count'],
    language:      ['language','select language','choose language'],
    country:       ['country','select country','choose country'],
    terms:         ['terms','terms of service','terms and conditions','privacy','privacy policy'],
    wishlist:      ['wishlist','wish list','save for later','add to wishlist','add to wish list','save item','favorite','favourites','favorites'],
    review:        ['write a review','leave a review','add review','post review','review','rate this','give feedback','rating'],
    payment:       ['payment','pay','pay now','make payment','complete payment','card number','credit card','debit card','card details','enter card','account number','bank account','ifsc','sort code','routing number'],
    date:          ['date','select date','choose date','check in','check out','arrival','departure','from date','to date','travel date'],
    time:          ['time','select time','choose time','departure time','arrival time','slot','time slot'],
    comment:       ['comment','reply','write a comment','add comment','leave a comment','post comment','message','type your message'],
    like:          ['like','thumbs up','upvote','heart','love','react'],
    follow:        ['follow','subscribe','subscribe to','follow this','connect'],
    filter:        ['filter','sort','sort by','filter by','refine','narrow down'],
  };

  function _norm(str) {
    return (str || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // Build phrase → canonical map (normalised phrase → cluster key)
  const PHRASE_TO_CLUSTER = new Map();
  for (const [key, phrases] of Object.entries(SYNONYM_CLUSTERS)) {
    PHRASE_TO_CLUSTER.set(key, key);
    for (const phrase of phrases) {
      PHRASE_TO_CLUSTER.set(_norm(phrase), key);
    }
  }

  /**
   * Given a normalised token or phrase, return ALL synonym phrases in its
   * cluster. Returns [token] if no cluster found.
   */
  function getSynonymPhrases(token) {
    const canonical = PHRASE_TO_CLUSTER.get(token);
    if (!canonical) return [token];
    const cluster = SYNONYM_CLUSTERS[canonical] ?? [];
    return [canonical, ...cluster].map(_norm);
  }

  // Pre-computed sorted list of all known multi-word phrases (longest first)
  // used for the pre-scan in parseHint().
  const ALL_PHRASES_SORTED = [...PHRASE_TO_CLUSTER.keys()]
    .filter((p) => p.includes(' '))
    .sort((a, b) => b.length - a.length);

  // ══════════════════════════════════════════════════════════════════════════
  // TYPE MAP
  // ══════════════════════════════════════════════════════════════════════════

  const TYPE_MAP = {
    button:   (n) => n.tag === 'button' || n.role === 'button' ||
                     (n.tag === 'input' && ['submit','button','reset','image'].includes(n.type)),
    submit:   (n) => n.tag === 'button' || (n.tag === 'input' && n.type === 'submit') ||
                     n.element?.getAttribute?.('type') === 'submit',
    link:     (n) => n.tag === 'a',
    anchor:   (n) => n.tag === 'a',
    input:    (n) => (n.tag === 'textarea' || n.role === 'textbox') ||
                     (n.tag === 'input' && !['checkbox','radio','submit','button','reset','image','file'].includes(n.type)),
    field:    (n) => (['textarea','select'].includes(n.tag) || n.role === 'textbox') ||
                     (n.tag === 'input' && !['checkbox','radio','submit','button','reset','image','file'].includes(n.type)),
    textbox:  (n) => n.tag === 'textarea' || n.role === 'textbox' ||
                     (n.tag === 'input' && (!n.type || n.type === 'text' || n.type === 'email' || n.type === 'search')),
    dropdown: (n) => n.tag === 'select' || n.role === 'combobox' || n.role === 'listbox',
    select:   (n) => n.tag === 'select',
    checkbox: (n) => n.type === 'checkbox' || n.role === 'checkbox',
    radio:    (n) => n.type === 'radio'    || n.role === 'radio',
    email:    (n) => n.type === 'email' ||
                     (n.tag === 'input' && (
                       n.name?.toLowerCase().includes('email') ||
                       n.ariaLabel?.toLowerCase().includes('email') ||
                       n.placeholder?.toLowerCase().includes('email')
                     )),
    phone:    (n) => n.type === 'tel' ||
                     (n.tag === 'input' && (
                       n.name?.toLowerCase().match(/phone|mobile|tel/) ||
                       n.placeholder?.toLowerCase().match(/phone|mobile/)
                     )),
    mobile:   (n) => TYPE_MAP.phone(n),
    number:   (n) => n.type === 'number',
    password: (n) => n.type === 'password',
    search:   (n) => n.type === 'search' || n.role === 'searchbox' || n.role === 'combobox' ||
                     (n.tag === 'input' && (
                       n.name?.toLowerCase().includes('search') ||
                       n.ariaLabel?.toLowerCase().includes('search') ||
                       n.placeholder?.toLowerCase().includes('search')
                     )),
    textarea: (n) => n.tag === 'textarea' || n.role === 'textbox',
    tab:      (n) => n.role === 'tab',
    menu:     (n) => n.role === 'menuitem' || n.role === 'menu',
    cancel:   (n) => n.tag === 'button' || n.role === 'button',
    close:    (n) => n.tag === 'button' || n.role === 'button',
  };

  const TYPE_KEYWORDS = new Set(Object.keys(TYPE_MAP));

  // Keywords describing a *semantic* field flavor (inferred from name/aria/
  // placeholder text) rather than a hard structural constraint. Many real
  // login/username fields are type="text" despite being conceptually an
  // "email" field, so a mismatch here shouldn't be treated as strongly wrong
  // as e.g. a "button" hint landing on a checkbox.
  const SOFT_TYPE_KEYWORDS = new Set(['email', 'phone', 'mobile', 'search']);

  // Element types that can never receive typed text, no matter how well
  // their accessible label matches a "type" step's hint. A checkbox captioned
  // "Email me weekly deals" is not an email field just because its label
  // contains the word "email" — it structurally cannot be one.
  const TEXT_ENTRY_ELEMENT_TYPES = new Set(['input', 'field', 'textbox']);
  function isNonTextEnterable(n) {
    if (n.tag === 'textarea' || n.role === 'textbox') return false;
    if (n.tag === 'input') return ['checkbox', 'radio', 'submit', 'button', 'reset', 'image', 'file'].includes(n.type);
    return n.tag === 'button' || n.tag === 'a' || n.role === 'button' || n.role === 'link' ||
           n.role === 'checkbox' || n.role === 'radio';
  }

  const PURE_TYPE_DESCRIPTORS = new Set([
    'button','link','anchor','input','field','textbox','dropdown',
    'select','checkbox','radio','textarea','tab','menu','form',
    'box','control','widget','area','icon','element',
  ]);

  // ══════════════════════════════════════════════════════════════════════════
  // SCORING WEIGHTS  (change these without touching logic)
  // ══════════════════════════════════════════════════════════════════════════

  const WEIGHTS = {
    labelExact:       50,
    labelStrong:      42,   // similarity >= 0.8
    labelPartialMax:  35,   // scaled by similarity ratio
    ariaBonus:         8,
    tagMatch:         20,
    tagPenalty:      -10,
    tagNoConstraint:   3,
    metaTypeBonus:     8,   // elementType from stepMeta when hint has no type constraint
    metaTypePenalty:  -10,  // stepMeta.elementType (e.g. "input" for a type action) structurally
                            // incompatible with this node (e.g. a checkbox/button can't be typed into)
    contextMax:       15,
    viewportIn:       10,
    viewportNear:      4,
    attrMatch:         5,
    prominenceHigh:    5,
    prominenceMid:     2,
    duplicatePenalty: -8,
    zoneMatch:         8,
  };

  // ══════════════════════════════════════════════════════════════════════════
  // TEXT HELPERS
  // ══════════════════════════════════════════════════════════════════════════

  const NOISE = new Set([
    'a','an','the','this','that','these','those',
    'is','are','was','were','be','been','being',
    'to','of','in','on','at','by','for','with','from',
    'and','or','but','not','nor','so',
    'it','its','my','your','their','our','his','her','me',
    'click','press','tap','find','fill','type','go','navigate',
    'look','locate','hit','toggle','focus','scroll','open',
    'choose','pick','use','get','set','put','make','do',
    'have','take','give','show','please','want','need',
    'help','where','how','what','which','who',
  ]);

  function _tokenize(str) {
    return _norm(str).split(' ').filter((w) => w.length > 1 && !NOISE.has(w));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // HINT PARSER  — v3: pre-scans for multi-word phrases before noise removal
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Parse a target hint into structured tokens for scoring.
   *
   * The critical fix: before running _tokenize() (which strips noise words),
   * scan the normalized raw hint for all known multi-word synonym phrases.
   * Matched phrases contribute their canonical cluster key to contentTokens
   * directly, bypassing noise-word removal entirely.
   *
   * Example: "Click the Sign In button"
   *   1. normalise → "click the sign in button"
   *   2. pre-scan phrases: "sign in" found → phraseCanonicals = {"login"}
   *   3. tokenize → ["sign", "button"] (noise removes "click","the","in")
   *   4. strip type descriptors → ["sign"]
   *   5. merge → ["sign", "login"]
   *   6. getSynonymPhrases("login") → ["login","sign in","log in","signin",...]
   *      → correctly matches "Sign in", "Log in", "Login", etc.
   */
  function parseHint(hint) {
    const normalizedHint = _norm(hint);

    // Step 1: Pre-scan for multi-word synonym phrases before tokenization.
    // ALL_PHRASES_SORTED is longest-first to avoid "log" matching before "log in".
    // Track consumed tokens so individual words from a matched phrase don't
    // accidentally become type constraints (e.g. "number" in "mobile number"
    // must NOT constrain the element to <input type="number">).
    const phraseCanonicals = new Set();
    const consumedTokens   = new Set();
    for (const phrase of ALL_PHRASES_SORTED) {
      if (normalizedHint.includes(phrase)) {
        const canonical = PHRASE_TO_CLUSTER.get(phrase);
        if (canonical) {
          phraseCanonicals.add(canonical);
          for (const word of phrase.split(' ')) consumedTokens.add(word);
        }
      }
    }

    // Step 2: Standard tokenization path (for words not covered by phrases)
    const tokens    = _tokenize(hint);
    const typeHints = new Set(
      tokens.filter((t) => TYPE_KEYWORDS.has(t) && !consumedTokens.has(t))
    );
    const content   = tokens.filter((t) => !PURE_TYPE_DESCRIPTORS.has(t));
    const contentTokens = content.length ? content : tokens;

    // Step 3: Merge canonical phrase keys into content tokens (deduplicated).
    // These are guaranteed to resolve in PHRASE_TO_CLUSTER, so
    // getSynonymPhrases(canonical) will return the full synonym list.
    const merged = [...new Set([...contentTokens, ...phraseCanonicals])];

    return { contentTokens: merged, typeHints };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // LABEL SIMILARITY  (synonym-aware, phrase-level)
  // ══════════════════════════════════════════════════════════════════════════

  function labelSimilarity(node, contentTokens) {
    if (!contentTokens.length) return { sim: 0, exact: false };

    const dataAttrText = node.dataAttrs
      ? Object.values(node.dataAttrs).map((v) => v.replace(/[-_]/g, ' ')).join(' ')
      : null;

    const allText = _norm([
      node.label,
      node.ariaLabel,
      node.placeholder,
      node.id?.replace(/[-_]/g, ' '),
      node.name?.replace(/[-_]/g, ' '),
      node.parentHeading,
      dataAttrText,
      node.value,                        // input[type=submit] value="Sign In"
      node.href?.replace(/[-_/]/g, ' '), // link href text (e.g. /sign-in → sign in)
    ].filter(Boolean).join(' '));

    // Exact match on primary label — the node's own label IS the hint, not
    // just a longer string that happens to contain it somewhere.
    const hintPhrase = contentTokens.join(' ');
    if (_norm(node.label) === hintPhrase) return { sim: 1.0, exact: true };

    let matched = 0;
    for (const token of contentTokens) {
      const synonymPhrases = getSynonymPhrases(token);
      const hit = synonymPhrases.some((phrase) => allText.includes(phrase));
      if (hit) {
        matched++;
      } else {
        const words = allText.split(' ').filter((w) => w.length >= 3);
        if (words.some((w) => w.startsWith(token) || (token.startsWith(w) && token.length >= 4))) {
          matched += 0.5;
        }
      }
    }

    return { sim: matched / contentTokens.length, exact: false };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PER-NODE SCORING
  // ══════════════════════════════════════════════════════════════════════════

  function scoreNode(node, parsedHint, meta = {}) {
    let score = 0;
    const reasons = [];
    const { contentTokens, typeHints } = parsedHint;

    if (!contentTokens.length) return { score: 0, reasons: ['empty hint'] };

    // A node that structurally can't take typed text is disqualified from
    // label/aria credit entirely when the step's planned action is "type" —
    // its label text describes what clicking/checking it does, not what data
    // it holds. Gated on `action` (not just elementType) because elementType
    // "input" is ambiguous — it's also reported for checkbox/radio steps
    // (action "check"/"select"), which must NOT be disqualified here.
    const categoricalMismatch = meta.action === 'type' &&
      meta.elementType && TEXT_ENTRY_ELEMENT_TYPES.has(meta.elementType) && isNonTextEnterable(node);

    // ── 1. LABEL SIMILARITY (0–50) ─────────────────────────────────────────
    const { sim, exact } = categoricalMismatch ? { sim: 0, exact: false } : labelSimilarity(node, contentTokens);

    if (exact) {
      score += WEIGHTS.labelExact;
      reasons.push(`exact/full match +${WEIGHTS.labelExact}`);
    } else if (sim >= 0.8) {
      score += WEIGHTS.labelStrong;
      reasons.push(`strong match (${(sim * 100).toFixed(0)}%) +${WEIGHTS.labelStrong}`);
    } else if (sim > 0) {
      const pts = Math.round(sim * WEIGHTS.labelPartialMax);
      score += pts;
      reasons.push(`partial match (${(sim * 100).toFixed(0)}%) +${pts}`);
    } else if (categoricalMismatch) {
      reasons.push(`not a text-enterable element for a type action +0`);
    }

    // ── 2. ARIA-LABEL SPECIFICITY BONUS (0–8) ──────────────────────────────
    if (node.ariaLabel && !categoricalMismatch) {
      const ariaText = _norm(node.ariaLabel);
      const ariaMatches = contentTokens.filter((t) =>
        getSynonymPhrases(t).some((p) => ariaText.includes(p))
      );
      if (ariaMatches.length) {
        const pts = Math.round((ariaMatches.length / contentTokens.length) * WEIGHTS.ariaBonus);
        score += pts;
        reasons.push(`aria-label match +${pts}`);
      }
    }

    // ── 3. TAG / TYPE SEMANTICS (0–20, –10 penalty) ────────────────────────
    // Two independent signals can constrain the expected element type:
    //   a) explicit type keywords parsed out of the hint text itself
    //      ("button", "email", "checkbox", ...)
    //   b) stepMeta.elementType, the structural type implied by the planned
    //      action (e.g. action:"type" ⇒ elementType:"input") — this is a
    //      real constraint even when the hint text has no type keyword in
    //      it ("Email", "Username"), since you categorically cannot type
    //      into a button or checkbox no matter how well its label matches.
    // (a) is tried first; if it resolves definitively via a hard keyword,
    // that's authoritative. Otherwise fall back to (b), which can match,
    // mismatch (penalized), or be absent entirely (neutral).
    let tagResolved = false;
    for (const typeKey of typeHints) {
      if (SOFT_TYPE_KEYWORDS.has(typeKey)) continue; // soft keywords resolved via (b) below
      if (TYPE_MAP[typeKey]?.(node)) {
        score += WEIGHTS.tagMatch;
        reasons.push(`tag matches type "${typeKey}" +${WEIGHTS.tagMatch}`);
      } else {
        score += WEIGHTS.tagPenalty;
        reasons.push(`wrong element type ${WEIGHTS.tagPenalty}`);
      }
      tagResolved = true;
      break;
    }

    if (!tagResolved) {
      let softMatched = false;
      for (const typeKey of typeHints) {
        if (!SOFT_TYPE_KEYWORDS.has(typeKey)) continue;
        if (TYPE_MAP[typeKey]?.(node)) {
          const pts = Math.round(WEIGHTS.tagMatch / 2);
          score += pts;
          reasons.push(`tag matches type "${typeKey}" +${pts}`);
          softMatched = true;
          break;
        }
      }
      if (!softMatched) {
        const metaTypeFn = meta.elementType ? TYPE_MAP[meta.elementType] : null;
        // elementType "input" is ambiguous — it's reported both for text
        // fields (action "type") and for checkbox/radio steps (action
        // "check"/"select", no better enum value exists for those). Only
        // treat a checkbox/radio failing an "input" match as neutral when we
        // don't positively know it's a text-entry step; every other
        // elementType mismatch (e.g. a checkbox failing a "button" match) is
        // unambiguous and still penalized.
        const isAmbiguousCheckboxCase = meta.elementType && TEXT_ENTRY_ELEMENT_TYPES.has(meta.elementType) &&
          (node.type === 'checkbox' || node.type === 'radio' || node.role === 'checkbox' || node.role === 'radio') &&
          meta.action !== 'type';

        if (!metaTypeFn) {
          score += WEIGHTS.tagNoConstraint;
          reasons.push(`interactive (no type constraint) +${WEIGHTS.tagNoConstraint}`);
        } else if (metaTypeFn(node)) {
          score += WEIGHTS.metaTypeBonus;
          reasons.push(`element type from step metadata "${meta.elementType}" +${WEIGHTS.metaTypeBonus}`);
        } else if (isAmbiguousCheckboxCase) {
          score += WEIGHTS.tagNoConstraint;
          reasons.push(`interactive (no type constraint) +${WEIGHTS.tagNoConstraint}`);
        } else {
          score += WEIGHTS.metaTypePenalty;
          reasons.push(`element type mismatch from step metadata "${meta.elementType}" ${WEIGHTS.metaTypePenalty}`);
        }
      }
    }

    // ── 4. CONTEXT SIGNALS (0–15) ──────────────────────────────────────────
    let ctxPts = 0;
    const el = node.element;
    if (el) {
      if (el.closest?.('form, [role="form"]')) {
        ctxPts += 5;
        reasons.push('in form +5');
      }
      if (el.type === 'submit' || el.getAttribute?.('type') === 'submit') {
        ctxPts += 6;
        reasons.push('type=submit +6');
      }
      if (el.hasAttribute?.('autofocus')) {
        ctxPts += 5;
        reasons.push('autofocus +5');
      }
      if (meta.isUniqueTag) {
        ctxPts += 4;
        reasons.push('only element of type +4');
      }
    }
    score += Math.min(ctxPts, WEIGHTS.contextMax);

    // ── 5. VIEWPORT (0–10) ─────────────────────────────────────────────────
    if (node.inViewport) {
      score += WEIGHTS.viewportIn;
      reasons.push(`in viewport +${WEIGHTS.viewportIn}`);
    } else if (node.rect.top > 0 && node.rect.top < 2000) {
      score += WEIGHTS.viewportNear;
      reasons.push(`near viewport +${WEIGHTS.viewportNear}`);
    }

    // ── 6. ATTRIBUTE MATCH (0–5) ───────────────────────────────────────────
    const attrText = _norm(
      `${node.id?.replace(/[-_]/g, ' ') ?? ''} ${node.name?.replace(/[-_]/g, ' ') ?? ''}`
    );
    if (attrText.trim()) {
      const hit = contentTokens.some((t) =>
        getSynonymPhrases(t).some((p) => attrText.includes(p))
      );
      if (hit) { score += WEIGHTS.attrMatch; reasons.push(`id/name match +${WEIGHTS.attrMatch}`); }
    }

    // ── 7. PROMINENCE (0–5) ────────────────────────────────────────────────
    if (node.rect.width >= 300) {
      score += WEIGHTS.prominenceHigh;
      reasons.push(`prominent (${node.rect.width}px) +${WEIGHTS.prominenceHigh}`);
    } else if (node.rect.width >= 150) {
      score += WEIGHTS.prominenceMid;
      reasons.push(`medium (${node.rect.width}px) +${WEIGHTS.prominenceMid}`);
    }

    // ── 8. DUPLICATE LABEL PENALTY ─────────────────────────────────────────
    if (meta.isDuplicateLabel && score > 0) {
      score += WEIGHTS.duplicatePenalty;
      reasons.push(`duplicate label on page ${WEIGHTS.duplicatePenalty}`);
    }

    // ── 9. ZONE PREFERENCE (0–8) ───────────────────────────────────────────
    if (meta.preferredZone && node.zone && node.zone === meta.preferredZone) {
      score += WEIGHTS.zoneMatch;
      reasons.push(`zone match "${node.zone}" +${WEIGHTS.zoneMatch}`);
    }

    return { score: Math.min(100, Math.max(0, score)), reasons };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // TargetRanker CLASS
  // ══════════════════════════════════════════════════════════════════════════

  class TargetRanker {
    constructor() {
      console.log('[NeuroAdapt] TargetRanker v4 ready (synonym phrase pre-scan + dataAttrs + zone preference).');
    }

    /**
     * Score every element in prunedTree against targetHint.
     * Returns array sorted descending by score, zero-score items excluded.
     */
    rank(prunedTree, targetHint, stepMeta = {}) {
      if (!prunedTree?.length) {
        console.warn('[NeuroAdapt] TargetRanker.rank(): empty tree.');
        return [];
      }
      if (!targetHint?.trim()) {
        console.warn('[NeuroAdapt] TargetRanker.rank(): empty hint.');
        return [];
      }

      const hint  = parseHint(targetHint);
      const start = performance.now();

      // Pre-compute uniqueness signals
      const tagTypeCount  = new Map();
      const labelCount    = new Map();
      for (const node of prunedTree) {
        const tagKey   = `${node.tag}:${node.type ?? node.role ?? ''}`;
        const labelKey = _norm(node.label);
        tagTypeCount.set(tagKey,   (tagTypeCount.get(tagKey)   ?? 0) + 1);
        labelCount.set(labelKey,   (labelCount.get(labelKey)   ?? 0) + 1);
      }

      const results = prunedTree.map((node) => {
        const tagKey         = `${node.tag}:${node.type ?? node.role ?? ''}`;
        const labelKey       = _norm(node.label);
        const isUniqueTag      = (tagTypeCount.get(tagKey)   ?? 0) === 1;
        const isDuplicateLabel = (labelCount.get(labelKey)  ?? 0) > 2 && labelKey.length > 0;
        const { score, reasons } = scoreNode(node, hint, {
          isUniqueTag,
          isDuplicateLabel,
          preferredZone: stepMeta.preferredZone ?? null,
          elementType:   stepMeta.elementType   ?? null,
          action:        stepMeta.action        ?? null,
        });
        return { node, element: node.element, score, reasons };
      });

      const ranked = results
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score);

      const elapsed = (performance.now() - start).toFixed(1);
      console.log(`[NeuroAdapt] Ranked ${ranked.length} candidates for "${targetHint}" in ${elapsed}ms`);

      if (ranked[0]) {
        const t = ranked[0];
        console.log(
          `[NeuroAdapt]  ▶ #1 "${t.node.label}" <${t.node.tag}> score=${t.score}\n` +
          `     ${t.reasons.join(' | ')}`
        );
        if (ranked[1]) {
          const r2 = ranked[1];
          console.log(`[NeuroAdapt]  ▶ #2 "${r2.node.label}" <${r2.node.tag}> score=${r2.score}`);
        }
      }

      return ranked;
    }

    best(prunedTree, targetHint, minScore = 40, stepMeta = {}) {
      const ranked = this.rank(prunedTree, targetHint, stepMeta);
      return ranked.length && ranked[0].score >= minScore ? ranked[0] : null;
    }
  }

  window.NeuroAdaptEngine.TargetRanker = TargetRanker;
})();
