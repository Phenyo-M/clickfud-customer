/* ============================================================
   CLICKFOOD, online payment with PayFast

   Thin client for the create-payfast-payment / payfast-status Edge
   Functions. This file never sees a merchant key or passphrase, never
   collects card details itself, and never decides on its own that a
   payment succeeded: it only sends the customer to PayFast's own payment
   page and, afterwards, asks the server what PayFast confirmed (the
   server only learns that from PayFast's verified notification,
   supabase/functions/payfast-itn).
   ============================================================ */
window.App = window.App || {};

App.Payments = (function () {
  // Survives a closed tab / lost network / app reload: the payment's
  // reference is saved BEFORE leaving for PayFast and only removed once
  // the server gives a definite answer (paid, or failed).
  const PENDING_KEY = 'cf_pending_payment';
  // After this long, stop re-checking on every app open.
  const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

  function savePendingReference(reference) {
    try { localStorage.setItem(PENDING_KEY, JSON.stringify({ reference, savedAt: Date.now() })); } catch (e) {}
  }
  function clearPendingReference() {
    try { localStorage.removeItem(PENDING_KEY); } catch (e) {}
  }
  function getPendingReference() {
    try {
      const raw = localStorage.getItem(PENDING_KEY);
      if (!raw) return null;
      const { reference, savedAt } = JSON.parse(raw);
      if (!reference || !savedAt || Date.now() - savedAt > PENDING_MAX_AGE_MS) {
        clearPendingReference();
        return null;
      }
      return reference;
    } catch (e) { return null; }
  }
  function pendingReferenceSavedAt() {
    try { const raw = localStorage.getItem(PENDING_KEY); return raw ? JSON.parse(raw).savedAt : null; } catch (e) { return null; }
  }

  // ---- Unfinished checkout (left PayFast without paying) ----
  // Saved just before leaving: the signed PayFast fields (so "Continue
  // payment" reopens the SAME payment, never a second one), what the cart
  // looked like and everything typed at checkout. Same 24h limit.
  const UNFINISHED_KEY = 'cf_unfinished_checkout';
  function cartSignature(cart) {
    return JSON.stringify((cart || []).map(i => [i.menuItemId, i.qty, !!i.isAddon, (i.addons || []).map(a => a.id || a).sort(), i.specialInstructions || '']));
  }
  function saveUnfinishedCheckout(data) {
    try { localStorage.setItem(UNFINISHED_KEY, JSON.stringify(Object.assign({ savedAt: Date.now() }, data))); } catch (e) {}
  }
  function getUnfinishedCheckout() {
    try {
      const raw = localStorage.getItem(UNFINISHED_KEY);
      if (!raw) return null;
      const u = JSON.parse(raw);
      const owner = App.Store.state.profile && App.Store.state.profile.id;
      if (!u || !u.reference || !u.savedAt || Date.now() - u.savedAt > PENDING_MAX_AGE_MS) { clearUnfinishedCheckout(); return null; }
      if (u.customerId && owner && u.customerId !== owner) return null; // someone else's, on a shared phone
      return u;
    } catch (e) { return null; }
  }
  function clearUnfinishedCheckout() {
    try { localStorage.removeItem(UNFINISHED_KEY); } catch (e) {}
  }

  // PayFast sends the customer back to ?reference=… (paid or not yet
  // confirmed) or ?reference=…&payment=cancelled (they tapped cancel).
  function pendingReferenceFromUrl() {
    return new URLSearchParams(window.location.search).get('reference') || null;
  }
  function cancelledFromUrl() {
    return new URLSearchParams(window.location.search).get('payment') === 'cancelled';
  }
  function clearReferenceFromUrl() {
    const url = new URL(window.location.href);
    url.searchParams.delete('reference');
    url.searchParams.delete('payment');
    history.replaceState({}, '', url.pathname + url.search + url.hash);
  }

  function returnUrl() {
    return window.location.origin + window.location.pathname;
  }

  // Opens PayFast's payment page with the signed fields (a normal form
  // POST, so the customer's details aren't put in the address bar).
  function goToPayfast(pay) {
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = pay.processUrl;
    form.style.display = 'none';
    Object.keys(pay.fields || {}).forEach((k) => {
      const input = document.createElement('input');
      input.type = 'hidden'; input.name = k; input.value = pay.fields[k];
      form.appendChild(input);
    });
    document.body.appendChild(form);
    form.submit();
  }

  async function invokeCreate(body) {
    const { data, error } = await App.sb.functions.invoke('create-payfast-payment', { body });
    if (error) {
      if (error.name === 'FunctionsHttpError' && error.context && error.context.json) {
        try { const b = await error.context.json(); if (b && b.error) return { error: b.error }; } catch (e) {}
      }
      return { error: 'Unable to start payment. Please try again.' };
    }
    return data || { error: 'Unable to start payment. Please try again.' };
  }

  // groups: [{ storeId, items: [{menuItemId, qty, isAddon, addons, specialInstructions}], deliveryLocation }]
  // resume: { checkout, total } — what to restore if they come back unpaid.
  async function startOnlineCheckout(groups, promoCode, resume) {
    const data = await invokeCreate({ groups, promoCode: promoCode || null, returnUrl: returnUrl() });
    if (data.error) return { error: data.error };
    // Remembered BEFORE leaving: the customer may come back to this window
    // some other way (the installed app opens PayFast in a separate
    // browser, they close PayFast's tab, they reopen the app later). The
    // reference alone proves nothing; only the server can say it's paid.
    savePendingReference(data.reference);
    if (resume) {
      saveUnfinishedCheckout({
        reference: data.reference, pay: { processUrl: data.processUrl, fields: data.fields },
        customerId: App.Store.state.profile && App.Store.state.profile.id,
        total: resume.total, checkout: resume.checkout, cart: cartSignature(App.Store.state.cart),
      });
    }
    goToPayfast(data);
    return { pending: true, mode: data.mode };
  }

  // A group share ("everyone pays"). Returns { paid } if it's already paid.
  async function startGroupSharePayment(groupId) {
    const data = await invokeCreate({ groupId, returnUrl: returnUrl() });
    if (data.error) return { error: data.error };
    if (data.paid) return { paid: true };
    goToPayfast(data);
    return { pending: true };
  }

  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  // Asks the server what PayFast has confirmed for this payment. A failure
  // to REACH the server (network drop, cold start) is not an answer and
  // is retried with backoff; only the server's own reply is returned.
  //   { ok: true, orderIds }            paid, orders exist
  //   { ok: false, pending: true }      PayFast hasn't confirmed yet
  //   { ok: false, transient: true }    couldn't reach the server
  //   { ok: false, error }              a definite "no"
  async function verifyReturn(reference, attempt, maxAttempts, cancelled) {
    attempt = attempt || 1;
    const MAX_ATTEMPTS = maxAttempts || 4;
    const { data, error } = await App.sb.functions.invoke('payfast-status', { body: { reference, cancelled: !!cancelled } });
    if (!error) return data;

    if (error.name === 'FunctionsHttpError' && error.context) {
      const status = error.context.status;
      let body = null;
      try { body = await error.context.json(); } catch (e) {}
      if (status && status < 500) return Object.assign({ ok: false, error: (body && body.error) || 'Unable to check this payment.' }, body || {}, { ok: false, httpStatus: status });
    }

    if (attempt >= MAX_ATTEMPTS) {
      return { ok: false, error: 'Unable to check your payment right now.', transient: true };
    }
    await sleep(Math.min(8000, 1000 * Math.pow(2, attempt - 1)));
    return verifyReturn(reference, attempt + 1, MAX_ATTEMPTS, cancelled);
  }

  return {
    pendingReferenceFromUrl, cancelledFromUrl, clearReferenceFromUrl, startOnlineCheckout, startGroupSharePayment,
    goToPayfast, verifyReturn,
    savePendingReference, clearPendingReference, getPendingReference, pendingReferenceSavedAt,
    saveUnfinishedCheckout, getUnfinishedCheckout, clearUnfinishedCheckout, cartSignature,
  };
})();
