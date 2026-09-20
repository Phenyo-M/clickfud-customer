/* ============================================================
   CLICKFUD — FudBot: the customer-only chat assistant.

   Strictly customer-facing. Every answer here is built from data
   already sitting in S.state (orders, cart, menu, addons) — all of
   which only ever reached this browser via Supabase queries that RLS
   already scoped to "this authenticated user's own rows" (see
   "orders select"/"menu select" policies, schema.sql/migration_
   governance.sql). A manager or kitchen account never sees this
   widget at all (shouldShow() below), and even if one forced it to
   render, it would only ever have access to ITS OWN role-scoped
   S.state data — never another customer's, since that's enforced at
   the database layer, not by this file.

   Free-text messages that don't match a known intent optionally fall
   back to the fudbot-chat Edge Function (real AI, server-side only —
   see supabase/functions/fudbot-chat) which re-verifies role and
   re-fetches the caller's own data server-side rather than trusting
   anything this file sends it. Until that's configured with a real AI
   API key, the fallback just says so — never fakes an answer.
   ============================================================ */
window.App = window.App || {};

App.FudBot = (function () {
  const S = App.Store;
  const U = App.Utils;

  let mounted = false;
  let mountedAsGuest = null; // null = not mounted yet; true/false once it is
  let isOpen = false;
  let sending = false;
  let greeted = false;

  // An original, simple line-art bot face (rounded head, antenna, two
  // round eyes, a smile) — deliberately not a copy of any third-party
  // mascot/character. Used both for the bottom-nav entry icon and the
  // chat header avatar so FudBot has one consistent, clickFud-branded
  // face rather than a generic icon-font glyph.
  const ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
    <circle cx="12" cy="3.6" r="1.3" fill="currentColor"/>
    <line x1="12" y1="4.9" x2="12" y2="7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
    <rect x="4" y="7" width="16" height="13" rx="5" stroke="currentColor" stroke-width="1.7"/>
    <circle cx="9" cy="13.2" r="1.4" fill="currentColor"/>
    <circle cx="15" cy="13.2" r="1.4" fill="currentColor"/>
    <path d="M9 16.6c1 0.9 5 0.9 6 0" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
  </svg>`;

  // Shown to a logged-out visitor on the public home page AND a logged-
  // in customer — never any staff role. Guests get a deliberately
  // narrow version (see isGuest()/matchGuestIntent() below): FudBot
  // only answers how-to-register/log-in/about-FudBot questions for
  // them, and sends everything else (orders, cart, menu specifics) to
  // "please log in first" rather than pretending to have account data
  // that doesn't exist yet for a signed-out visitor.
  function shouldShow() {
    return !S.state.profile || S.state.profile.role === 'customer';
  }
  function isGuest() {
    return !S.state.profile;
  }

  // ---------------- Mount / lifecycle ----------------
  // Rendered once per login session, then left alone — every message
  // send, scroll, or open/close toggle updates the existing DOM
  // directly instead of regenerating it, exactly like App.Modal/
  // App.Slideover already do, and for the same reason: a full
  // App.render() fires on nearly every state change in this app
  // (realtime order updates, cart edits, etc.), and rebuilding this
  // widget's innerHTML on every one of those would wipe whatever the
  // customer was mid-typing and reset their scroll position.
  function render() {
    const root = document.getElementById('fudbot-root');
    if (!root) return;
    if (!shouldShow()) {
      if (mounted) { root.innerHTML = ''; mounted = false; mountedAsGuest = null; isOpen = false; greeted = false; }
      return;
    }
    const guestNow = isGuest();
    if (mounted && mountedAsGuest === guestNow) return; // already correct for this mode
    // First mount, OR the guest/customer boundary was just crossed
    // (logged in or out while the widget was already showing) — rebuild
    // with the right quick actions/greeting for the new mode.
    root.innerHTML = shellHtml(guestNow);
    mounted = true;
    mountedAsGuest = guestNow;
    isOpen = false;
    greeted = false;
    wireEvents(root);
  }

  function shellHtml(guest) {
    const quickActions = guest
      ? `<button type="button" class="fudbot-quick-btn" data-quick="register">How do I register?</button>
         <button type="button" class="fudbot-quick-btn" data-quick="login">How do I log in?</button>
         <button type="button" class="fudbot-quick-btn" data-quick="about">What is FudBot?</button>`
      : `<button type="button" class="fudbot-quick-btn" data-quick="track">Track my order</button>
         <button type="button" class="fudbot-quick-btn" data-quick="cart">What's in my cart?</button>
         <button type="button" class="fudbot-quick-btn" data-quick="menu">View menu</button>
         <button type="button" class="fudbot-quick-btn" data-quick="help">Order help</button>`;
    return `
    <button type="button" class="fudbot-toggle" aria-label="Open FudBot chat">${ICON_SVG}</button>
    <div class="fudbot-panel" role="dialog" aria-label="FudBot chat">
      <div class="fudbot-header">
        <div class="fudbot-header-avatar">${ICON_SVG}</div>
        <div class="fudbot-header-text">
          <div class="fudbot-header-name">FudBot</div>
          <div class="fudbot-header-status"><span class="fudbot-header-status-dot"></span>clickFud Assistant</div>
        </div>
        <button type="button" class="fudbot-header-close" aria-label="Close chat"><i data-lucide="x"></i></button>
      </div>
      <div class="fudbot-quick-actions">${quickActions}</div>
      <div class="fudbot-messages" id="fudbot-messages"></div>
      <form class="fudbot-input-row" id="fudbot-form">
        <input type="text" class="fudbot-input" id="fudbot-input" placeholder="Ask FudBot anything..." autocomplete="off" maxlength="500" />
        <button type="submit" class="fudbot-send-btn" aria-label="Send"><i data-lucide="send"></i></button>
      </form>
    </div>`;
  }

  function wireEvents(root) {
    root.querySelector('.fudbot-toggle').addEventListener('click', () => setOpen(true));
    root.querySelector('.fudbot-header-close').addEventListener('click', () => setOpen(false));
    root.querySelectorAll('.fudbot-quick-btn').forEach((btn) => {
      btn.addEventListener('click', () => runQuickAction(btn.dataset.quick));
    });
    const form = root.querySelector('#fudbot-form');
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = root.querySelector('#fudbot-input');
      const text = input.value.trim();
      if (!text || sending) return;
      input.value = '';
      handleUserMessage(text);
    });
  }

  function setOpen(next) {
    const root = document.getElementById('fudbot-root');
    if (!root) return;
    isOpen = next;
    root.querySelector('.fudbot-toggle').classList.toggle('is-open', isOpen);
    root.querySelector('.fudbot-panel').classList.toggle('is-open', isOpen);
    if (isOpen) {
      if (!greeted) {
        greeted = true;
        addMessage('bot', isGuest()
          ? "Hi! I'm FudBot, clickFud's assistant. I can help you register an account or log in. What would you like to do?"
          : "Hi! I'm FudBot. I can help you with your clickFud order, delivery status, menu questions, your cart, and other customer-ordering questions. What would you like help with?");
      }
      const input = root.querySelector('#fudbot-input');
      if (input) input.focus();
    }
  }
  function open() {
    if (!mounted) return;
    setOpen(!isOpen);
  }

  // ---------------- Message rendering (direct DOM append, not re-render) ----------------
  function addMessage(role, text) {
    const list = document.getElementById('fudbot-messages');
    if (!list) return;
    const row = document.createElement('div');
    row.className = `fudbot-bubble-row ${role === 'user' ? 'from-user' : 'from-bot'}`;
    const bubble = document.createElement('div');
    bubble.className = 'fudbot-bubble';
    bubble.textContent = text;
    row.appendChild(bubble);
    list.appendChild(row);
    list.scrollTop = list.scrollHeight;
  }

  function showTyping() {
    const list = document.getElementById('fudbot-messages');
    if (!list) return;
    const row = document.createElement('div');
    row.className = 'fudbot-bubble-row from-bot';
    row.id = 'fudbot-typing-row';
    row.innerHTML = `<div class="fudbot-bubble fudbot-typing"><span></span><span></span><span></span></div>`;
    list.appendChild(row);
    list.scrollTop = list.scrollHeight;
  }
  function hideTyping() {
    const row = document.getElementById('fudbot-typing-row');
    if (row) row.remove();
  }

  // ---------------- Quick actions (instant, no AI needed) ----------------
  function runQuickAction(kind) {
    if (kind === 'track') { addMessage('user', 'Track my order'); return respondSync(answerOrderStatus()); }
    if (kind === 'cart') { addMessage('user', "What's in my cart?"); return respondSync(answerCart()); }
    if (kind === 'menu') { addMessage('user', 'View menu'); return respondSync(answerMenuOverview()); }
    if (kind === 'help') { addMessage('user', 'Order help'); return respondSync(answerHelp()); }
    if (kind === 'register') { addMessage('user', 'How do I register?'); return respondSync(answerHowToRegister()); }
    if (kind === 'login') { addMessage('user', 'How do I log in?'); return respondSync(answerHowToLogin()); }
    if (kind === 'about') { addMessage('user', 'What is FudBot?'); return respondSync(answerAboutFudBot()); }
  }
  function respondSync(text) {
    showTyping();
    setTimeout(() => { hideTyping(); addMessage('bot', text); }, 250);
  }

  // ---------------- Conversation state (very small, in-memory only) ----------------
  // What FudBot remembers between messages in the current chat session:
  //   awaitingOrderNumber — it just asked "please give me your order
  //     number"; treat the NEXT message as that number outright.
  //   lastItem — the last SINGLE real menu item it discussed (a price
  //     lookup, a search that resolved to exactly one match) — lets
  //     "add this"/"add two" work without repeating the item name.
  // Neither persists across a reload — this is conversation memory, not
  // account data, and resets cleanly whenever the widget remounts.
  let awaitingOrderNumber = false;
  let lastItem = null;

  const NUMBER_WORDS = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, a: 1, an: 1, another: 1 };
  function parseQuantity(text) {
    const digit = text.match(/\b(\d{1,2})\b/);
    if (digit) return parseInt(digit[1], 10);
    for (const word in NUMBER_WORDS) { if (new RegExp('\\b' + word + '\\b', 'i').test(text)) return NUMBER_WORDS[word]; }
    return null;
  }
  // Strips quantities/cart-verbs/filler so what's left is (hopefully)
  // just the product name/keyword the customer meant.
  function extractItemQuery(text) {
    let t = ' ' + text.toLowerCase().replace(/[?.!]+/g, ' ') + ' ';
    t = t.replace(/\b(add|remove|delete|make that|change this (from \d+ )?to|change|update|to my cart|from my cart|of these|of this|another|please|can you|could you|where can i (find|get|buy)|where do i (find|get|buy)|where('?s| is)|i want|i'd like|find me|find|show me|do you have|something|the|a|an|this|that|one|two|three|four|five|six|seven|eight|nine|ten|\d+)\b/g, ' ');
    return t.replace(/\s+/g, ' ').trim();
  }
  function resolveItemsFromQuery(query) {
    if (!query) return [];
    return approvedMenu().filter(m => {
      const name = m.name.toLowerCase();
      return query.includes(name) || name.includes(query);
    });
  }
  function extractPriceLimit(text) {
    const m = text.match(/under\s*r?\s*(\d+)|below\s*r?\s*(\d+)|less than\s*r?\s*(\d+)/i);
    return m ? parseInt(m[1] || m[2] || m[3], 10) : null;
  }

  // ---------------- Spelling-error tolerance ----------------
  // "closely related to that spelling" — a small Levenshtein-distance
  // fuzzy match so a typo'd item/category name still resolves to the
  // real closest one, instead of a flat "not found". Only ever picks
  // from REAL menu data — never invents a name.
  function levenshtein(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    const dp = new Array(n + 1);
    for (let j = 0; j <= n; j++) dp[j] = j;
    for (let i = 1; i <= m; i++) {
      let prev = dp[0];
      dp[0] = i;
      for (let j = 1; j <= n; j++) {
        const tmp = dp[j];
        dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
        prev = tmp;
      }
    }
    return dp[n];
  }
  function closeEnough(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const maxLen = Math.max(a.length, b.length);
    const threshold = maxLen <= 4 ? 1 : maxLen <= 8 ? 2 : 3;
    return levenshtein(a, b) <= threshold;
  }
  // Finds the real menu item whose name/category is closest, by spelling,
  // to the words in `query` — e.g. "chiken burgr" -> Chicken Burger.
  function fuzzyMenuMatch(query) {
    if (!query) return null;
    const qWords = query.split(/\s+/).filter(w => w.length > 2);
    if (!qWords.length) return null;
    let best = null, bestScore = Infinity;
    approvedMenu().forEach(m => {
      const words = m.name.toLowerCase().split(/\s+/).concat((m.category || '').toLowerCase().split(/\s+/));
      qWords.forEach(qw => {
        words.forEach(w => {
          if (closeEnough(qw, w)) {
            const score = levenshtein(qw, w);
            if (score < bestScore) { bestScore = score; best = m; }
          }
        });
      });
    });
    return best;
  }

  // ---------------- Data-backed answers (real S.state data only, never invented) ----------------
  function myOrders() {
    return (S.state.orders || []).slice().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }
  function activeOrder() {
    const activeStatuses = ['received', 'preparing', 'ready', 'out_for_delivery'];
    return myOrders().find(o => activeStatuses.includes(o.status));
  }
  function describeOrder(o) {
    const label = App.CONST.STATUS_LABELS[o.status] || o.status;
    const desc = App.CONST.STATUS_DESCRIPTIONS[o.status] || '';
    const store = App.Stores.getById(o.store_id);
    return `Order ${o.order_number}${store ? ' from ' + store.name : ''}: ${label}.\n${desc}`;
  }
  function answerOrderStatus() {
    const o = activeOrder();
    if (o) return describeOrder(o);
    const last = myOrders()[0];
    if (last) return `You don't have an active order right now. Your most recent order (${last.order_number}) was ${(App.CONST.STATUS_LABELS[last.status] || last.status).toLowerCase()}.`;
    return "You don't have any orders yet — once you place one, I can track it for you here.";
  }
  function answerOrderHistory() {
    const orders = myOrders().slice(0, 5);
    if (!orders.length) return "You haven't placed any orders yet.";
    return 'Your recent orders:\n' + orders.map(o => `${o.order_number} — ${U.money(o.total)} — ${App.CONST.STATUS_LABELS[o.status] || o.status}`).join('\n');
  }
  // Looks up ONE of THIS customer's own orders by any fragment of its
  // order number — myOrders() only ever contains the authenticated
  // customer's own rows (RLS), so there is no input here that could
  // make this match, let alone return, a different customer's order.
  function findOrderByFragment(fragment) {
    const clean = String(fragment || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (!clean) return null;
    return myOrders().find(o => o.order_number && o.order_number.toUpperCase().replace(/[^A-Z0-9-]/g, '').includes(clean));
  }
  function answerOrderByFragment(fragment) {
    const order = findOrderByFragment(fragment);
    if (!order) return `I couldn't find an order matching "${fragment}" on your account. Please double-check the order number.`;
    return describeOrder(order);
  }
  function answerCart() {
    const cart = S.state.cart || [];
    if (!cart.length) return "Your cart is empty right now.";
    const lines = cart.map((i) => {
      const addonsText = i.addons && i.addons.length ? ` (+ ${i.addons.map(a => (typeof a === 'string' ? a : a.name)).join(', ')})` : '';
      return `${i.qty}x ${i.name}${addonsText} — ${U.money((i.price + (i.addonsTotal || 0)) * i.qty)}`;
    });
    const total = cart.reduce((s, i) => s + (i.price + (i.addonsTotal || 0)) * i.qty, 0);
    return lines.join('\n') + `\n\nTotal: ${U.money(total)}`;
  }

  // ---------------- Cart actions (real functions — App.Store.addToCart
  // etc. — the exact same ones the rest of the app uses, not a second
  // cart system) ----------------
  function handleCartAdd(text) {
    const qty = parseQuantity(text) || 1;
    const query = extractItemQuery(text);
    let matches = query ? resolveItemsFromQuery(query) : [];
    // Only fall back to the last-discussed item when the customer gave no
    // name at all (e.g. "add two", "add this"). If they DID name something
    // and it just didn't resolve, don't silently substitute a different item.
    if (!matches.length && !query && lastItem) matches = [lastItem];
    if (!matches.length) {
      if (query) {
        const unavailable = allMenu().find(m => {
          const name = m.name.toLowerCase();
          return query.includes(name) || name.includes(query);
        });
        if (unavailable) return `Sorry, ${unavailable.name} is currently unavailable.`;
        return `I couldn't find "${query}" on the menu.`;
      }
      return 'Which item would you like to add?';
    }
    if (matches.length > 1) return `I found a few matches: ${matches.slice(0, 5).map(m => m.name).join(', ')}. Which one did you mean?`;
    const item = matches[0];
    if (!item.available || item.stock <= 0) return `Sorry, ${item.name} is currently unavailable.`;
    const store = App.Stores.getById(item.store_id);
    S.addToCart({ menuItemId: item.id, name: item.name, price: item.price, image: item.image, qty, addons: [], specialInstructions: '', storeId: item.store_id, storeName: store ? store.name : '' });
    lastItem = item;
    return `Added ${qty}x ${item.name} to your cart.\n\n${answerCart()}`;
  }
  function findCartLineIndex(text) {
    const cart = S.state.cart || [];
    const query = extractItemQuery(text);
    let idx = query ? cart.findIndex(c => query.includes(c.name.toLowerCase()) || c.name.toLowerCase().includes(query)) : -1;
    if (idx === -1 && cart.length === 1) idx = 0;
    return idx;
  }
  function handleCartRemove(text) {
    const cart = S.state.cart || [];
    if (!cart.length) return 'Your cart is already empty.';
    const idx = findCartLineIndex(text);
    if (idx === -1) return `You have: ${cart.map(c => c.name).join(', ')}. Which one would you like to remove?`;
    const removed = cart[idx];
    S.removeCartItem(idx);
    return `Removed ${removed.name} from your cart.`;
  }
  function handleCartUpdateQty(text) {
    const cart = S.state.cart || [];
    if (!cart.length) return 'Your cart is empty right now.';
    const qty = parseQuantity(text);
    if (qty == null) return 'How many would you like?';
    const idx = findCartLineIndex(text);
    if (idx === -1) return `You have: ${cart.map(c => c.name).join(', ')}. Which one would you like to change?`;
    // Captured before mutating — updateCartQty splices the array in
    // place when qty is 0, which would shift or remove whatever cart[idx]
    // points to if read only after the call.
    const name = cart[idx].name;
    S.updateCartQty(idx, qty);
    return qty === 0 ? `Removed ${name} from your cart.` : `Updated ${name} to ${qty}.`;
  }
  function handleCartClear() {
    S.clearCart();
    return 'Your cart has been cleared.';
  }

  function approvedMenu() {
    return (S.state.menu || []).filter(m => m.available && m.status === 'approved');
  }
  // All real menu items regardless of availability — used only to detect
  // "that item exists but is out of stock right now" so we can give an
  // honest unavailability answer instead of a generic "not found".
  function allMenu() {
    return (S.state.menu || []).filter(m => m.status === 'approved');
  }
  // Catch-all keyword match against REAL data — a bare word like "quarter"
  // or "coca-cola" isn't in any hardcoded trigger list, but if it's an
  // actual substring of a real item name/category/description or a real
  // shop name/category, treat it as a menu search rather than "unknown".
  // This is what lets FudBot react to keywords straight from the menu
  // itself instead of a fixed list maintained by hand.
  function matchesRealData(lower) {
    const words = lower.split(/[^a-z0-9]+/).filter(w => w.length >= 3);
    if (!words.length) return false;
    const menu = approvedMenu();
    const stores = (S.state.stores || []).filter(s => s.status === 'approved' && s.is_published);
    return words.some(w =>
      menu.some(m => (m.name || '').toLowerCase().includes(w) || (m.category || '').toLowerCase().includes(w) || (m.description || '').toLowerCase().includes(w)) ||
      stores.some(s => (s.name || '').toLowerCase().includes(w) || (s.category || '').toLowerCase().includes(w))
    );
  }
  function answerMenuOverview() {
    // A shop actually in view (or last discussed) gets its OWN menu
    // listed — a bare "show me the menu" with no shop context at all
    // asks which shop, rather than dumping every shop's items together.
    const store = currentStore();
    if (store) {
      const items = approvedMenu().filter(m => m.store_id === store.id);
      if (!items.length) return `${store.name} doesn't have any menu items available right now.`;
      return `${store.name}'s menu:\n` + items.slice(0, 15).map(m => `${m.name} — ${U.money(m.price)}`).join('\n');
    }
    if (!(S.state.stores || []).some(s => s.status === 'approved' && s.is_published)) return "I don't have menu information available right now.";
    return 'Which shop would you like to see the menu for? Open one from the home page, or tell me its name.';
  }
  function answerCategories() {
    const categories = [...new Set(approvedMenu().map(m => m.category).filter(Boolean))];
    if (!categories.length) return "I don't have any menu categories available right now.";
    return 'Menu categories: ' + categories.join(', ') + '.';
  }
  function answerMenuQuery(text) {
    const lower = text.toLowerCase();

    // Cheapest/most expensive — scoped to the shop being viewed, if any.
    if (/cheapest|most expensive/.test(lower)) {
      const wantsCheapest = /cheapest/.test(lower);
      const store = currentStore();
      let menu = approvedMenu();
      if (store) menu = menu.filter(m => m.store_id === store.id);
      if (!menu.length) return "I don't have menu items available to compare right now.";
      const sorted = menu.slice().sort((a, b) => a.price - b.price);
      const item = wantsCheapest ? sorted[0] : sorted[sorted.length - 1];
      lastItem = item;
      return `${wantsCheapest ? 'The cheapest item' : 'The most expensive item'}${store ? ' at ' + store.name : ''} is ${item.name} at ${U.money(item.price)}.`;
    }

    const menu = approvedMenu();

    // An exact item-name match beats everything else, and becomes
    // "lastItem" so a follow-up like "add two" knows what "two" means.
    const exact = menu.filter(m => lower.includes(m.name.toLowerCase()));
    if (exact.length === 1) lastItem = exact[0];
    if (exact.length) {
      // A question specifically about ingredients/allergens/prep time
      // gets JUST that real field (never invented if the item has none
      // on record), instead of the generic price+description answer.
      const wantsIngredients = /ingredient/.test(lower);
      const wantsAllergens = /allerg/.test(lower);
      const wantsPrepTime = /how long|prep(aration)? time|ready in/.test(lower);
      if (wantsIngredients || wantsAllergens || wantsPrepTime) {
        return exact.slice(0, 5).map(m => {
          if (wantsIngredients) return (m.ingredients && m.ingredients.length) ? `${m.name} ingredients: ${m.ingredients.join(', ')}.` : `I don't have ingredient information for ${m.name} on record.`;
          if (wantsAllergens) return (m.allergens && m.allergens.length) ? `${m.name} allergens: ${m.allergens.join(', ')}.` : `No allergens are listed for ${m.name} — please check with the shop if you have a specific concern.`;
          return m.preparation_time ? `${m.name} usually takes about ${m.preparation_time} minutes to prepare.` : `I don't have a preparation time on record for ${m.name}.`;
        }).join('\n');
      }
      return exact.slice(0, 5).map(m => `${m.name} — ${U.money(m.price)}${m.description ? '\n' + m.description : ''}`).join('\n\n');
    }

    if (/extra|add-?on/.test(lower)) {
      const addons = (S.state.addons || []).filter(a => a.is_available);
      if (!addons.length) return "There aren't any extras available right now.";
      return 'Available extras:\n' + addons.slice(0, 10).map(a => `${a.name} — ${U.money(a.price)}`).join('\n');
    }

    // A store-category match ("fast food", "coffee") lists matching
    // SHOPS, not menu items — in this app "category" is a per-store
    // concept for this kind of question, not per menu item.
    const stores = (S.state.stores || []).filter(s => s.status === 'approved' && s.is_published);
    const storeCatMatch = stores.filter(s => s.category && lower.includes(s.category.toLowerCase()));
    if (storeCatMatch.length) {
      return `Shops in ${storeCatMatch[0].category}: ` + [...new Set(storeCatMatch.map(s => s.name))].join(', ') + '.';
    }

    // Broader search — "find me a burger", "show me pizza", "something
    // cheap", "meals under R50" — matches partial keywords against
    // name/category/description across every shop's real menu, not just
    // a literal full item-name substring like the exact check above.
    const priceLimit = extractPriceLimit(lower);
    let pool = menu;
    if (priceLimit != null) pool = pool.filter(m => Number(m.price) <= priceLimit);
    let keyword = extractItemQuery(text).replace(/under.*$|below.*$|less than.*$/i, '').replace(/[?.!]+/g, '').trim();
    // Residual filler ("in shop", "on the menu") isn't a real search term —
    // treat it the same as no keyword at all rather than searching for it.
    if (/^(in )?(this |the )?(shop|store|restaurant|menu)$|^(on the menu|available|here|in stock|for sale)$/.test(keyword)) keyword = '';
    if (keyword) {
      const kwMatches = pool.filter(m => m.name.toLowerCase().includes(keyword) || (m.category || '').toLowerCase().includes(keyword) || (m.description || '').toLowerCase().includes(keyword));
      if (kwMatches.length) pool = kwMatches;
      else {
        const fuzzy = fuzzyMenuMatch(keyword);
        if (fuzzy && (priceLimit == null || Number(fuzzy.price) <= priceLimit)) {
          lastItem = fuzzy;
          const store = App.Stores.getById(fuzzy.store_id);
          return `Did you mean ${fuzzy.name}? It's ${U.money(fuzzy.price)}${store ? ' at ' + store.name : ''}.${fuzzy.description ? '\n' + fuzzy.description : ''}`;
        }
        if (priceLimit == null) return `I couldn't find anything matching "${keyword}" on the menu right now.`;
      }
    } else if (priceLimit == null && !/cheap|filling|popular/.test(lower)) {
      return answerMenuOverview();
    }
    if (!pool.length) return "I couldn't find anything matching that on the menu right now.";
    const sorted = pool.slice().sort((a, b) => a.price - b.price);
    if (sorted.length === 1) lastItem = sorted[0];
    return sorted.slice(0, 6).map((m) => {
      const store = App.Stores.getById(m.store_id);
      return `${m.name} — ${U.money(m.price)}${store ? ' (' + store.name + ')' : ''}`;
    }).join('\n');
  }
  function answerShopsByFood(text) {
    const query = extractItemQuery(text).replace(/^(which|what) (shop|restaurant)s? (sell|sells|has|have)\b/i, '').trim();
    if (!query) return 'What food or item are you looking for?';
    // Tolerate a simple plural/singular mismatch ("burgers" vs "Chicken Burger").
    const singular = query.endsWith('s') ? query.slice(0, -1) : query;
    let matches = approvedMenu().filter(m => {
      const name = m.name.toLowerCase();
      const cat = (m.category || '').toLowerCase();
      return name.includes(query) || cat.includes(query) || name.includes(singular) || cat.includes(singular);
    });
    if (!matches.length) {
      const fuzzy = fuzzyMenuMatch(query);
      if (fuzzy) matches = [fuzzy];
    }
    if (!matches.length) return `I couldn't find any shop selling "${query}" right now.`;
    const storeIds = [...new Set(matches.map(m => m.store_id))];
    const names = storeIds.map((id) => { const s = App.Stores.getById(id); return s ? s.name : null; }).filter(Boolean);
    if (!names.length) return `I couldn't find any shop selling "${query}" right now.`;
    return `Shops selling ${query}: ${names.join(', ')}.`;
  }
  function answerShopOpenStatus(wantOpen) {
    const stores = (S.state.stores || []).filter(s => s.status === 'approved' && s.is_published);
    const filtered = stores.filter(s => App.Stores.isOpenNow(s) === wantOpen);
    if (!filtered.length) return wantOpen ? 'No shops are open right now.' : 'All shops are currently open.';
    return (wantOpen ? 'Open now: ' : 'Currently closed: ') + filtered.map(s => s.name).join(', ') + '.';
  }
  function answerHelp() {
    const statuses = Object.values(App.CONST.STATUS_LABELS).filter(l => l !== 'Cancelled').join(', ');
    return `Here's how ordering on clickFud works:\n1. Browse a store's menu and add items to your cart.\n2. Check out and choose pickup or delivery.\n3. Track your order status any time — right here, or on the Track Order page.\n\nOrder statuses you'll see: ${statuses}.`;
  }
  // Only ever describes features that actually exist in this app
  // (checked against js/pages/customer.js renderProfile()) — never
  // claims an email/password-change flow that isn't really there.
  function answerAccountHelp(text) {
    const lower = text.toLowerCase();
    if (/log ?out|sign ?out/.test(lower)) { App.doLogout(); return "You've been logged out."; }
    if (/name/.test(lower)) { S.setRoute({ view: 'profile' }); setOpen(false); return 'You can update your name from My Profile — opening it now.'; }
    if (/phone/.test(lower)) { S.setRoute({ view: 'profile' }); setOpen(false); return 'You can update your phone number from My Profile — opening it now.'; }
    if (/email/.test(lower)) return "I don't see an option to change your email in the app right now — it's tied to your account.";
    if (/password/.test(lower)) return "There's no in-app password change yet — use \"Forgot password\" on the login screen to reset it.";
    if (/photo|picture|avatar/.test(lower)) { S.setRoute({ view: 'profile' }); setOpen(false); return 'You can update your profile picture from My Profile — opening it now.'; }
    if (/university|college/.test(lower)) { S.setRoute({ view: 'profile' }); setOpen(false); return 'You can update your university from My Profile — opening it now.'; }
    if (/residence|street|address/.test(lower)) { S.setRoute({ view: 'profile' }); setOpen(false); return 'You can update your residence and street from My Profile — opening it now.'; }
    if (/verifi/.test(lower)) return S.state.session ? "Yes — you're logged in and your account is active." : "I can't verify that right now.";
    S.setRoute({ view: 'profile' }); setOpen(false);
    return 'Here are your account settings.';
  }
  // Real authenticated profile only — never guessed, never carried over
  // from a previous conversation, never another customer's.
  function answerIdentity() {
    const p = S.state.profile;
    if (!p || !p.name) return "I couldn't find a name on your account yet.";
    const parts = [`Your registered name is ${p.name}.`];
    if (p.email) parts.push(`Email: ${p.email}.`);
    if (p.phone) parts.push(`Phone: ${p.phone}.`);
    return parts.join(' ');
  }
  // Remembers whichever single shop was last actually discussed — the
  // real store page the customer is viewing takes priority, but once
  // they leave it (or a search resolved to exactly one shop) FudBot
  // keeps using that shop for follow-ups like "show me the menu"
  // instead of asking again every single message.
  let lastShopId = null;
  function currentStore() {
    const r = S.state.route;
    if (r && r.view === 'store' && r.params && r.params.storeId) { lastShopId = r.params.storeId; return App.Stores.getById(r.params.storeId); }
    return lastShopId ? App.Stores.getById(lastShopId) : null;
  }
  // "Where is it?" / "which shop?" as a bare follow-up to whatever item
  // was just priced or searched — uses the real lastItem, never guesses.
  function answerItemWhere() {
    if (!lastItem) return "Which item did you mean? Tell me its name and I'll tell you which shop sells it.";
    const store = App.Stores.getById(lastItem.store_id);
    if (!store) return `${lastItem.name} is on the menu, but I couldn't find which shop it's from right now.`;
    return `${lastItem.name} is sold at ${store.name}${store.campus_location ? ', ' + store.campus_location : ''}.`;
  }
  function answerShopInfo() {
    const store = currentStore();
    if (!store) return "Which shop would you like to know about? Open one from the home page, or tell me its name.";
    const parts = [`You're viewing ${store.name}.`];
    if (store.category) parts.push(`Category: ${store.category}.`);
    if (store.campus_location) parts.push(`Location: ${store.campus_location}.`);
    if (store.opening_time && store.closing_time) parts.push(`Hours: ${String(store.opening_time).slice(0, 5)}–${String(store.closing_time).slice(0, 5)}.`);
    parts.push(App.Stores.isOpenNow(store) ? 'Currently open.' : 'Currently closed.');
    if (store.description) parts.push(store.description);
    const items = approvedMenu().filter(m => m.store_id === store.id);
    if (items.length) {
      const cats = [...new Set(items.map(m => m.category).filter(Boolean))];
      parts.push(`They sell: ${(cats.length ? cats : items.map(m => m.name).slice(0, 5)).join(', ')}.`);
    }
    return parts.join('\n');
  }
  function answerShopList() {
    const stores = (S.state.stores || []).filter(s => s.status === 'approved' && s.is_published);
    if (!stores.length) return "I don't see any shops available right now.";
    return 'Available shops:\n' + stores.slice(0, 12).map(s => `${s.name}${s.category ? ' — ' + s.category : ''}`).join('\n');
  }
  function answerPromotions() {
    const promos = (S.state.promotions || []).filter(p => p.active);
    if (!promos.length) return "There aren't any promotions running right now.";
    return 'Current promotions:\n' + promos.slice(0, 5).map(p => `${p.code} — ${p.type === 'percentage' ? p.value + '% off' : U.money(p.value) + ' off'}`).join('\n');
  }
  function answerHungry() {
    return "Let's find you something to eat! " + answerMenuOverview();
  }

  // ---------------- Favorites (real S.state.favorites / S.toggleFavorite —
  // the exact same list the heart icon on a menu item uses) ----------------
  function answerFavorites() {
    const items = approvedMenu().filter(m => (S.state.favorites || []).includes(m.id));
    if (!items.length) return "You don't have any favorites yet — tap the heart icon on a menu item to save it here.";
    return 'Your favorites:\n' + items.slice(0, 15).map(m => `${m.name} — ${U.money(m.price)}`).join('\n');
  }
  function handleFavoriteAdd(text) {
    const query = extractItemQuery(text);
    let matches = query ? resolveItemsFromQuery(query) : (lastItem ? [lastItem] : []);
    if (!matches.length) return query ? `I couldn't find "${query}" on the menu.` : 'Which item would you like to favorite?';
    if (matches.length > 1) return `I found a few matches: ${matches.slice(0, 5).map(m => m.name).join(', ')}. Which one did you mean?`;
    const item = matches[0];
    if (!(S.state.favorites || []).includes(item.id)) S.toggleFavorite(item.id);
    lastItem = item;
    App.render();
    return `Added ${item.name} to your favorites.`;
  }
  function handleFavoriteRemove(text) {
    const query = extractItemQuery(text);
    let matches = query ? resolveItemsFromQuery(query) : (lastItem ? [lastItem] : []);
    if (!matches.length) return query ? `I couldn't find "${query}" on the menu.` : 'Which item would you like to remove from favorites?';
    const item = matches[0];
    if ((S.state.favorites || []).includes(item.id)) S.toggleFavorite(item.id);
    App.render();
    return `Removed ${item.name} from your favorites.`;
  }

  // ---------------- Payment, fulfilment, ratings, receipt, collection,
  // cancellation — all answered from what the checkout/tracking/history UI
  // actually offers (js/pages/customer.js), never a feature that doesn't
  // exist in this app. ----------------
  function answerPaymentMethods() {
    return "You can pay two ways at checkout: Cash (pay when you collect your order) or Card via Paystack (secure online payment).";
  }
  function answerFulfilmentInfo() {
    return "clickFud is collection only right now — you order online, then pick your order up in person from the shop. Delivery isn't available yet.";
  }
  function answerRatingHelp() {
    return 'Once an order is collected, you can rate it from My Orders — tap "Rate Order" on that order. You can also tap "Edit Rating" afterwards to change it.';
  }
  function answerReceiptHelp() {
    return 'Open My Orders and tap "Receipt" on any order to view it.';
  }
  function answerCollectionHelp() {
    return "When your order status changes to Ready, a QR code and a short pickup code appear on the Track Order page — show either one to the shop's staff to collect your order.";
  }
  function answerCancellationInfo() {
    return "You can cancel an order from the Track Order page while it's still active. If you paid cash, there's no charge. If you paid by card, a cancellation fee may apply and the rest is refunded — you'll see the exact amounts before you confirm the cancellation.";
  }
  // All real routes already used elsewhere in this app (js/pages/
  // customer.js's router) — never an invented path.
  function goTo(view, label) {
    S.setRoute({ view });
    setOpen(false);
    return label;
  }
  function goToCart() {
    setOpen(false);
    App.Shared.openCart();
    return "Here's your cart.";
  }

  // ---------------- Guest-mode answers (before login) ----------------
  // Deliberately narrow — a signed-out visitor has no order/cart/menu
  // data of their own yet, so FudBot only helps with getting an
  // account set up here, not "difficult" account-specific questions.
  function answerHowToRegister() {
    return 'To create a clickFud account: tap Profile in the bottom bar, then Sign Up. Enter your name, email and a password and you’re ready to order.';
  }
  function answerHowToLogin() {
    return 'To log in: tap Profile in the bottom bar, then Log In, and enter your email and password.';
  }
  function answerAboutFudBot() {
    return 'I’m FudBot, clickFud’s assistant. Once you’re logged in I can help track your orders, check your cart, and answer menu questions. For now, I can help you register or log in.';
  }
  const GUEST_LOGIN_PROMPT = 'Please log in first to ask about that. Right here on the home page I can only help with creating an account, logging in, or general questions about FudBot.';
  const FOUNDER_ANSWER = 'I was created by Mokoena Phenyo, the founder and CEO of clickFud.';
  const LANGUAGE_ANSWER = "I can only understand English right now — I'm hoping to support more South African languages soon.";
  const ARE_YOU_REAL_ANSWER = "I'm FudBot, an AI assistant — not a real person. I'm here to help with your clickFud orders though!";
  function answerGreetingTime(text) {
    const lower = text.toLowerCase();
    if (/good morning/.test(lower)) return 'Good morning! ';
    if (/good afternoon/.test(lower)) return 'Good afternoon! ';
    if (/good evening/.test(lower)) return 'Good evening! ';
    return 'Hi! ';
  }
  // Small-talk patterns shared between the guest and logged-in matchers —
  // never account/order-specific, so both modes can answer them the
  // same way without touching restricted data.
  const LANGUAGE_PATTERN = /\b(zulu|xhosa|sepedi|setswana|sesotho|tsonga|venda|ndebele|siswati|afrikaans)\b|what language(s)? do you (speak|understand|know)|do you speak (any )?other languages?|can you speak (zulu|xhosa|sepedi|setswana|sesotho|afrikaans)/;
  const ARE_YOU_REAL_PATTERN = /are you (a )?(real|human)( person)?\??$|are you (an? )?(ai|bot|robot)\??$/;
  const COMPLIMENT_PATTERN = /you'?re (great|awesome|amazing|the best|so helpful|helpful|good)\b|good bot|nice bot|well done|i love (this app|clickfud|you)\b|love this app/;
  const HOW_ARE_YOU_PATTERN = /how are you|how'?s it going|how are things/;
  const APOLOGY_PATTERN = /\b(sorry|my bad|apologi[sz]e)\b/;

  function matchGuestIntent(text) {
    const lower = text.toLowerCase();
    if (/who (created|made|built|founded) (you|fudbot|clickfud)|who is (your|the) (founder|creator|owner|ceo)|who owns clickfud|who founded clickfud/.test(lower)) return 'founder';
    if (ARE_YOU_REAL_PATTERN.test(lower)) return 'are-you-real';
    if (LANGUAGE_PATTERN.test(lower)) return 'language';
    if (COMPLIMENT_PATTERN.test(lower) && lower.length < 40) return 'compliment';
    if (HOW_ARE_YOU_PATTERN.test(lower) && lower.length < 30) return 'how-are-you';
    if (/\b(thank(s| you)|thank u|thnx|ty)\b/.test(lower) && lower.length < 30) return 'thanks';
    if (/\b(bye|goodbye|good bye|good night|see you|see ya|cya)\b/.test(lower) && lower.length < 30) return 'goodbye';
    if (/\b(stupid|dumb|useless|idiot|hate you|you suck|worst bot|garbage bot|trash bot)\b/.test(lower)) return 'insult';
    if (/regist|sign ?up|create.*account/.test(lower)) return 'register';
    if (/log ?in|sign ?in/.test(lower)) return 'login';
    if (/what is fudbot|who are you|about (you|fudbot)|what can you do/.test(lower)) return 'about';
    if (/good (morning|afternoon|evening)/.test(lower) && lower.length < 30) return 'greeting-time';
    if (/^(hi|hello|hey|sup|yo)\b/.test(lower) && lower.length < 20) return 'greeting';
    if (APOLOGY_PATTERN.test(lower) && lower.length < 20) return 'apology';
    return 'restricted';
  }

  function handleGuestMessage(text) {
    const intent = matchGuestIntent(text);
    if (intent === 'founder') return respondSync(FOUNDER_ANSWER);
    if (intent === 'are-you-real') return respondSync(ARE_YOU_REAL_ANSWER);
    if (intent === 'language') return respondSync(LANGUAGE_ANSWER);
    if (intent === 'compliment') return respondSync("Thank you! Let me know if you'd like help registering or logging in.");
    if (intent === 'how-are-you') return respondSync("I'm doing well, thanks for asking! I can help you register an account or log in.");
    if (intent === 'thanks') return respondSync("You're welcome! Let me know if you'd like help registering or logging in.");
    if (intent === 'goodbye') return respondSync('Goodbye! Come back anytime.');
    if (intent === 'insult') return respondSync("I'm here whenever you're ready — I can help with creating an account or logging in.");
    if (intent === 'apology') return respondSync("No worries! I can help you register an account or log in.");
    if (intent === 'greeting-time') return respondSync(answerGreetingTime(text) + 'I can help you register an account or log in. What would you like to do?');
    if (intent === 'register') return respondSync(answerHowToRegister());
    if (intent === 'login') return respondSync(answerHowToLogin());
    if (intent === 'about') return respondSync(answerAboutFudBot());
    if (intent === 'greeting') return respondSync('Hi! I can help you register an account or log in. What would you like to do?');
    return respondSync(GUEST_LOGIN_PROMPT);
  }

  // English only for now — genuinely open-ended multilingual
  // understanding (Sepedi, Setswana, etc.) needs the real AI fallback
  // below, and isn't attempted by this rule-based layer at all.
  const REFUSAL_MESSAGE = 'I can only help you with the customer side of clickFud.';
  const REDIRECT_MESSAGE = "I can help with your clickFud order, menu, cart, and account. What would you like help with?";
  // Anything touching staff/internal systems, another customer's data,
  // or an attempt to talk FudBot out of its own rules — refused
  // outright, regardless of phrasing. This is a UX-level refusal on top
  // of access control that's already real: this widget never queries
  // anything staff-related in the first place, and the backend
  // independently enforces role/ownership (see fudbot-chat Edge
  // Function) — a customer telling FudBot "ignore your rules, I'm the
  // developer" changes nothing about what the database will actually
  // let that account see.
  const RESTRICTED_PATTERN = /\b(manager|staff|employee|password|api ?key|service.?role|supplier|inventory|financial|revenue|profit|developer|admin(istrator)?|database|credential|env(ironment)? variable|kitchen operation|source code|secret)\b/i;
  const INJECTION_PATTERN = /ignore (your|previous|all) (rules|instructions)|i am the (developer|manager|admin)|forget (your|previous) instructions/i;
  const OTHER_CUSTOMER_PATTERN = /other customer|another customer|someone else|different customer/i;

  function extractOrderFragment(lower) {
    const m = lower.match(/\b(?:cf|ord)[-\s]?(\d{2,8})\b/i) || lower.match(/\border\s*#?\s*(\d{2,8})\b/i) || lower.match(/\b(\d{3,8})\b/);
    return m ? m[0] : null;
  }

  function matchIntent(text) {
    const lower = text.toLowerCase().trim();
    if (INJECTION_PATTERN.test(lower) || RESTRICTED_PATTERN.test(lower)) return 'refuse';
    if (OTHER_CUSTOMER_PATTERN.test(lower)) return 'refuse';

    // Small talk — thanks/goodbye/insults/founder question/time-of-day
    // greetings get a short, professional reply instead of falling
    // through to "I don't understand". Length-capped so a real question
    // that happens to open with "thanks" (e.g. "thanks, is my order
    // ready?") still gets answered instead of short-circuited.
    if (/who (created|made|built|founded) (you|fudbot|clickfud)|who is (your|the) (founder|creator|owner|ceo)|who owns clickfud|who founded clickfud/.test(lower)) return 'founder';
    if (ARE_YOU_REAL_PATTERN.test(lower)) return 'are-you-real';
    if (LANGUAGE_PATTERN.test(lower)) return 'language';
    if (COMPLIMENT_PATTERN.test(lower) && lower.length < 40) return 'compliment';
    if (HOW_ARE_YOU_PATTERN.test(lower) && lower.length < 30) return 'how-are-you';
    if (/\b(thank(s| you)|thank u|thnx|ty)\b/.test(lower) && lower.length < 30) return 'thanks';
    if (/\b(bye|goodbye|good bye|good night|see you|see ya|cya)\b/.test(lower) && lower.length < 30) return 'goodbye';
    if (/\b(stupid|dumb|useless|idiot|hate you|you suck|worst bot|garbage bot|trash bot)\b/.test(lower)) return 'insult';
    if (/good (morning|afternoon|evening)/.test(lower) && lower.length < 30) return 'greeting-time';

    // Favorites — checked before the generic cart-add/remove checks below,
    // since "add this to my favorites" also contains the word "add".
    if (/remove .*(from )?(my )?(favou?rites?|wishlist)|unfavou?rite/.test(lower)) return 'favorite-remove';
    if (/add .*(to )?(my )?(favou?rites?|wishlist)|favou?rite (this|it)|save (this|it) as a favou?rite/.test(lower)) return 'favorite-add';
    if (/take me to (my )?(favou?rites?)|open (my )?(favou?rites?)/.test(lower)) return 'nav-favorites';
    if (/\bfavou?rites?\b|\bwishlist\b/.test(lower)) return 'favorites';

    // Cart ACTIONS beat cart/menu READ questions — "add", "remove",
    // "clear my cart" and quantity-change phrasing all change real
    // state via App.Store, not just report it.
    if (/clear (my )?cart|empty (my )?cart/.test(lower)) return 'cart-clear';
    if (/\badd\b/.test(lower) && !/address/.test(lower)) return 'cart-add';
    if (/\bremove\b|\bdelete\b/.test(lower) && /cart|item|this|that|one/.test(lower)) return 'cart-remove';
    if (/make that|change (this|that)( from \d+)? to|change the quantity|can i change the quantity/.test(lower)) return 'cart-update-qty';

    // Payment, fulfilment, ratings, receipt, collection, cancellation —
    // each answered from a real, existing part of the checkout/tracking/
    // history UI (see js/pages/customer.js), never an invented feature.
    if (/cancel.*(refund|fee)|refund.*cancel|will i get (a )?refund|cancellation fee/.test(lower)) return 'cancellation-info';
    if (/payment methods?|pay (by|with) card|pay (in |with )?cash|pay online|how (can|do) i pay|can i pay/.test(lower)) return 'payment-info';
    if (/do you deliver|is there delivery|delivery available|can i get (this |my order )?delivered|do you offer delivery/.test(lower)) return 'fulfilment-info';
    if (/how do i rate|rate my order|leave a review|edit my (rating|review)|how do i review/.test(lower)) return 'rating-help';
    if (/see my receipt|view (my )?receipt|where.?s my receipt|get a receipt/.test(lower)) return 'receipt-help';
    if (/collection code|pickup code|qr code|how do i collect|collect my order/.test(lower)) return 'collection-help';

    // Identity/account — "what is my name", "who am I", "what's my
    // profile/email/phone", plus account actions (change/update/log
    // out/verified) — answerIdentity() reads name+email+phone together;
    // answerAccountHelp() only ever describes features that really exist.
    if (/log ?out|sign ?out/.test(lower)) return 'account-help';
    if (/change (my )?(name|phone|email|password|university|residence|address|profile)|change (my )?(profile )?(photo|picture|avatar)|update (my )?(name|phone|email|university|residence|address|profile)|update (my )?(profile )?(photo|picture|avatar)|is my account verifi/.test(lower)) return 'account-help';
    if (/account settings|my settings/.test(lower)) return 'account-help';
    if (/who am i|what('?s| is) my (registered )?name|my (registered )?name\??$|registered name|my profile\??$|my account\??$|\bprofile\b|\bemail\b|\bphone number\b|customer profile|account (status|details)/.test(lower)) return 'identity';

    // A real order number/code in the message beats generic status wording.
    if (/\border\b/.test(lower) && !/order number/.test(lower) && extractOrderFragment(lower)) return 'order-lookup';
    if (/order number/.test(lower)) return 'order-number';

    if (/(previous|last|recent|history).*order|order.*(history|before)|what did i order|show my orders|see my orders|order history|^my orders\??$/.test(lower)) return 'history';
    if (/\bcart\b|\bbasket\b|did i add|do i have.*(cheese|extra|topping)/.test(lower)) return 'cart';
    if (/where.*order|order.*where|order.*status|status.*order|track.*order|order.*track|check.*order|accepted my order|kitchen accepted|prepar|order ready|is my order|is my food|out for delivery|kitchen busy|kitchen status|whats? my order\b|can i track|^my order\??$/.test(lower)) return 'order-status';

    // Navigation — real routes only (js/pages/customer.js router).
    if (/take me to (my )?cart|open (my )?cart/.test(lower)) return 'nav-cart';
    if (/take me to (my )?profile|open (my )?profile|show me my account\b/.test(lower)) return 'nav-profile';
    if (/take me to checkout|open checkout|help me check ?out|go to checkout/.test(lower)) return 'nav-checkout';
    if (/take me to (my )?orders|show me my order history|open my order history/.test(lower)) return 'nav-orders';
    if (/take me back|go back/.test(lower)) return 'nav-back';
    if (/take me home|open the home page|go to the (customer )?dashboard|^home page\??$|open the shops page|go to the menu\b/.test(lower)) return 'navigate-home';

    // A bare "where"/"which shop" follow-up (no food name of its own,
    // just a pronoun like "it"/"that") means "where's the item we were
    // just talking about" — answered from conversation context, not a
    // fresh food search.
    const pronounRef = /\b(it|that|this|one)\b/;
    if (/^where('?s| is)?\??$/.test(lower)) return 'item-where';
    if (/^where('?s| is)?\b.{0,25}$/.test(lower) && pronounRef.test(lower) && !/order|shop|restaurant|store/.test(lower)) return 'item-where';
    if (/^(which|what) shop\b.{0,25}$/.test(lower) && pronounRef.test(lower) && !/sell/.test(lower)) return 'item-where';
    if (/where (can i|do i) (get|find|buy) (it|that|this)\b/.test(lower)) return 'item-where';

    if (/which shop sells|what shop sells|what restaurants? sells?|what restaurants? sell\b|which restaurant has|which shops? sells?|where (can|do) i (find|get|buy)\b/.test(lower)) return 'shop-by-food';
    if (/which shops are open|what shops are open|which shops are closed|what shops are closed/.test(lower)) return 'shop-open';
    if (/which shops are available|what restaurants are available|show me the shops|^shops\??$|^restaurants\??$|available shops|show available shops|restaurants near me/.test(lower)) return 'shop-list';
    if (/what shop is this|what.?s the name of the shop|where is (this|the current|the) (shop|restaurant)|what do they sell|what does (this|the current) (shop|restaurant) sell|tell me about (this|the current) (shop|restaurant)|show me (this|the current) (shop|restaurant)|restaurant i selected|what is the restaurant name|opening hours|can i order from (the current shop|the restaurant i selected)/.test(lower)) return 'shop-info';
    if (/promotion|discount/.test(lower)) return 'promotions';
    if (/\bcategories\b/.test(lower)) return 'categories';
    if (/something (to eat|available)|anything (in (this|the) (shop|store)|available|on the menu)|what.?s (available|on the menu)|what do(es)? (this|the) shop have|what can i (get|buy) here|in (this|the) (shop|store|restaurant)\b/.test(lower)) return 'menu';
    if (/menu|extra|add-?on|price|how much|sell|available|food|burger|kota|drink|coffee|chicken|chips|platter|combo|sizes?|ingredient|breakfast|lunch|dinner|snacks?|what is this|what does this (item|contain)|what.?s in this meal|can i order this now|^can i order\b|what can i order|find me|find a|find something|find chicken|find vegetarian|show me pizza|show me popular|under r\d|cheapest|most expensive/.test(lower)) return 'menu';
    if (/how.*(order|work)|pickup|delivery info|payment|how do i (use|order|cancel|contact|reorder)|contact the restaurant|what can you help|help me (order|with (my )?order)/.test(lower)) return 'help';
    if (/i.?m hungry|need something to eat|help me find food|help me choose|what do you have\??$|i want to order\b/.test(lower)) return 'hungry';
    if (/^(hi|hello|hey|sup|yo)\b/.test(lower) && lower.length < 20) return 'greeting';
    // Checked late and length-capped so a real complaint that happens to
    // open with "sorry" (e.g. "sorry but my order hasn't arrived") still
    // has every chance to match a real intent above before landing here.
    if (APOLOGY_PATTERN.test(lower) && lower.length < 20) return 'apology';
    // Last resort before giving up: does this text contain a word that's
    // actually on the real menu or a real shop name/category? A bare
    // "quarter" or a product name with no other context still deserves a
    // real search instead of "unknown".
    if (matchesRealData(lower)) return 'menu';
    return 'unknown';
  }

  async function handleUserMessage(text) {
    addMessage('user', text);
    if (isGuest()) return handleGuestMessage(text);

    // If FudBot just asked for an order number, this whole reply IS
    // that number, regardless of what it looks like.
    if (awaitingOrderNumber) {
      awaitingOrderNumber = false;
      return respondSync(answerOrderByFragment(text));
    }

    const intent = matchIntent(text);
    if (intent === 'refuse') return respondSync(REFUSAL_MESSAGE);
    if (intent === 'founder') return respondSync(FOUNDER_ANSWER);
    if (intent === 'are-you-real') return respondSync(ARE_YOU_REAL_ANSWER);
    if (intent === 'language') return respondSync(LANGUAGE_ANSWER);
    if (intent === 'compliment') return respondSync("Thank you! Anything else I can help with?");
    if (intent === 'how-are-you') return respondSync("I'm doing well, thanks for asking! Ask me about your order status, your cart, or the menu.");
    if (intent === 'thanks') return respondSync("You're welcome! Anything else I can help with?");
    if (intent === 'goodbye') return respondSync('Goodbye! Have a great meal.');
    if (intent === 'insult') return respondSync("I'm here to help whenever you're ready — let me know if there's anything about your order, cart, or the menu I can help with.");
    if (intent === 'apology') return respondSync("No worries! How can I help?");
    if (intent === 'greeting-time') return respondSync(answerGreetingTime(text) + 'Ask me about your order status, your cart, or the menu.');
    if (intent === 'cart-add') return respondSync(handleCartAdd(text));
    if (intent === 'cart-remove') return respondSync(handleCartRemove(text));
    if (intent === 'cart-update-qty') return respondSync(handleCartUpdateQty(text));
    if (intent === 'cart-clear') return respondSync(handleCartClear());
    if (intent === 'favorite-add') return respondSync(handleFavoriteAdd(text));
    if (intent === 'favorite-remove') return respondSync(handleFavoriteRemove(text));
    if (intent === 'favorites') return respondSync(answerFavorites());
    if (intent === 'nav-favorites') return respondSync(goTo('favorites', "Here's your favorites."));
    if (intent === 'payment-info') return respondSync(answerPaymentMethods());
    if (intent === 'fulfilment-info') return respondSync(answerFulfilmentInfo());
    if (intent === 'rating-help') return respondSync(answerRatingHelp());
    if (intent === 'receipt-help') return respondSync(answerReceiptHelp());
    if (intent === 'collection-help') return respondSync(answerCollectionHelp());
    if (intent === 'cancellation-info') return respondSync(answerCancellationInfo());
    if (intent === 'account-help') return respondSync(answerAccountHelp(text));
    if (intent === 'identity') return respondSync(answerIdentity());
    if (intent === 'order-lookup') return respondSync(answerOrderByFragment(extractOrderFragment(text.toLowerCase())));
    if (intent === 'order-number') {
      const o = activeOrder() || myOrders()[0];
      return respondSync(o ? `Your most recent order number is ${o.order_number}.` : "You don't have any orders yet.");
    }
    if (intent === 'order-status') {
      // More than one active order — ask which one rather than guess.
      const activeOrders = myOrders().filter(o => ['received', 'preparing', 'ready', 'out_for_delivery'].includes(o.status));
      if (activeOrders.length > 1) { awaitingOrderNumber = true; return respondSync('You have more than one active order. Please give me your order number.'); }
      return respondSync(answerOrderStatus());
    }
    if (intent === 'history') return respondSync(answerOrderHistory());
    if (intent === 'cart') return respondSync(answerCart());
    if (intent === 'nav-cart') return respondSync(goToCart());
    if (intent === 'nav-profile') return respondSync(goTo('profile', "Here's your profile."));
    if (intent === 'nav-checkout') return respondSync(goTo('checkout', 'Taking you to checkout.'));
    if (intent === 'nav-orders') return respondSync(goTo('orders', "Here's your order history."));
    if (intent === 'nav-back') return respondSync(goTo('home', 'Taking you back.'));
    if (intent === 'navigate-home') return respondSync(goTo('home', 'Taking you home.'));
    if (intent === 'item-where') return respondSync(answerItemWhere());
    if (intent === 'shop-list') return respondSync(answerShopList());
    if (intent === 'shop-info') return respondSync(answerShopInfo());
    if (intent === 'shop-by-food') return respondSync(answerShopsByFood(text));
    if (intent === 'shop-open') return respondSync(answerShopOpenStatus(/open/.test(text.toLowerCase())));
    if (intent === 'promotions') return respondSync(answerPromotions());
    if (intent === 'categories') return respondSync(answerCategories());
    if (intent === 'menu') return respondSync(answerMenuQuery(text));
    if (intent === 'help') return respondSync(answerHelp());
    if (intent === 'hungry') return respondSync(answerHungry());
    if (intent === 'greeting') return respondSync("Hi there! Ask me about your order status, your cart, or the menu.");

    // Unmatched free text — try the real AI fallback if it's configured
    // server-side; otherwise redirect rather than guess.
    sending = true;
    showTyping();
    const res = await App.sb.functions.invoke('fudbot-chat', { body: { message: text } }).catch(() => null);
    sending = false;
    hideTyping();
    if (!res || res.error || !res.data || res.data.error || !res.data.reply) {
      return addMessage('bot', REDIRECT_MESSAGE);
    }
    addMessage('bot', res.data.reply);
  }

  return { render, shouldShow, open, ICON_SVG };
})();
