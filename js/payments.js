/* ============================================================
   CLICKFUD — Paystack online payment (TEST mode)

   Thin client for the paystack-initialize / paystack-verify Edge
   Functions. This file never sees a secret key, never collects card
   details itself, and never decides on its own that a payment
   succeeded — it only starts the redirect and, on return, asks the
   server to verify. See supabase/migration_governance.sql section 15
   and supabase/functions/paystack-* for the authoritative side of this.
   ============================================================ */
window.App = window.App || {};

App.Payments = (function () {
  // Survives a closed tab / lost network / app reload mid-verification —
  // the URL's own ?reference= gets cleared the moment we start verifying
  // (so a page refresh doesn't re-trigger it), but a real payment that
  // hasn't been definitively confirmed OR rejected yet must still be
  // findable afterwards. Only ever removed once verifyReturn() gets a
  // definitive answer (paid, or Paystack itself says it failed) — never
  // just because our own request to check couldn't get through.
  const PENDING_KEY = 'cfe_pending_paystack_ref';
  // A reference this old has almost certainly already been resolved by
  // paystack-webhook one way or another (or the checkout was truly
  // abandoned) — stop retrying it on every single future app open and
  // let webhook/support be the recourse, rather than nagging forever.
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

  // ---- Unfinished checkout (student left Paystack without paying) ----
  // Saved just before leaving for Paystack: the Paystack link itself (so
  // "Continue payment" reopens the SAME payment — never a second charge),
  // what the cart looked like, and everything typed at checkout, so
  // coming back doesn't mean filling it all in again. Cleared once the
  // payment is confirmed or the student cancels it. Same 24h limit.
  const UNFINISHED_KEY = 'cfe_unfinished_checkout';
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

  function pendingReferenceFromUrl() {
    const params = new URLSearchParams(window.location.search);
    return params.get('reference') || params.get('trxref') || null;
  }

  function clearReferenceFromUrl() {
    const url = new URL(window.location.href);
    url.searchParams.delete('reference');
    url.searchParams.delete('trxref');
    history.replaceState({}, '', url.pathname + url.search + url.hash);
  }

  // groups: [{ storeId, items: [{menuItemId, qty, isAddon, addons, specialInstructions}], deliveryLocation }]
  // resume: { checkout, total } — what to restore if they come back unpaid.
  async function startPaystackCheckout(groups, promoCode, resume) {
    const callbackUrl = window.location.origin + window.location.pathname;
    const { data, error } = await App.sb.functions.invoke('paystack-initialize', {
      body: { groups, promoCode: promoCode || null, callbackUrl },
    });
    if (error) return { error: 'Unable to start payment. Please try again.' };
    if (data.error) return { error: data.error };
    // Remembered BEFORE leaving for Paystack — not only when Paystack
    // redirects back. The student may come back to THIS window some other
    // way (the installed app hands Paystack to a separate browser; they
    // close Paystack's tab; they reopen the app later), and this window
    // must still be able to find and confirm the payment (see js/app.js
    // checkPendingPayment). The reference alone proves nothing — only
    // paystack-verify / the signed webhook can mark it paid.
    if (data.reference) savePendingReference(data.reference);
    if (data.reference && resume) {
      saveUnfinishedCheckout({
        reference: data.reference, url: data.authorization_url,
        customerId: App.Store.state.profile && App.Store.state.profile.id,
        total: resume.total, checkout: resume.checkout, cart: cartSignature(App.Store.state.cart),
      });
    }
    window.location.href = data.authorization_url;
    return { pending: true };
  }

  function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  // A failure reaching paystack-verify itself (network drop, Supabase
  // Edge Function cold start timing out, offline for a moment right after
  // an external redirect — all real, all previously indistinguishable
  // from "Paystack says this payment failed") is NOT the same thing as
  // Paystack actually returning a definitive answer. Only a real,
  // reached, definitive response (ok:true, or ok:false with an actual
  // error from the function) is returned as-is; a transport-level failure
  // retries with backoff instead of being reported as a payment failure.
  //
  // Returns one of:
  //   { ok: true, orderIds }            paid — orders exist
  //   { ok: false, pending: true }      Paystack hasn't reached a final answer yet
  //   { ok: false, transient: true }    couldn't reach our function — ask again later
  //   { ok: false, error }              a definitive "no" (declined, not this account's, unknown)
  // maxAttempts: 4 for the one-off check on return from Paystack; 1 for the
  // lightweight background re-checks, which simply try again next time.
  async function verifyReturn(reference, attempt, maxAttempts) {
    attempt = attempt || 1;
    const MAX_ATTEMPTS = maxAttempts || 4;
    const { data, error } = await App.sb.functions.invoke('paystack-verify', { body: { reference } });
    if (!error) return data;

    // A real HTTP answer from the function (403 not your payment, 404
    // unknown reference, 401 signed out) is definitive — only a 5xx or no
    // response at all is worth retrying. These used to all be retried and
    // then reported as "a connection issue".
    if (error.name === 'FunctionsHttpError' && error.context) {
      const status = error.context.status;
      let body = null;
      try { body = await error.context.json(); } catch (e) {}
      if (status && status < 500) return Object.assign({ ok: false, error: (body && body.error) || 'Unable to verify this payment.' }, body || {}, { ok: false, httpStatus: status });
    }

    if (attempt >= MAX_ATTEMPTS) {
      return { ok: false, error: 'Unable to verify your payment right now.', transient: true };
    }
    await sleep(Math.min(8000, 1000 * Math.pow(2, attempt - 1)));
    return verifyReturn(reference, attempt + 1, MAX_ATTEMPTS);
  }

  function pendingReferenceSavedAt() {
    try { const raw = localStorage.getItem(PENDING_KEY); return raw ? JSON.parse(raw).savedAt : null; } catch (e) { return null; }
  }

  // ---- Saved cards ("wallet") ----
  // RLS only ever lets a customer see/delete/set-default their OWN rows —
  // rows are only ever created server-side by paystack-verify right after
  // a real, verified Paystack transaction (see migration_governance.sql
  // section 37). Nothing here can insert a row or read anyone else's.
  async function fetchPaymentMethods() {
    const { data, error } = await App.sb.from('payment_methods').select('*')
      .order('is_default', { ascending: false }).order('created_at', { ascending: false });
    if (error) return [];
    return data;
  }

  async function setDefaultPaymentMethod(id) {
    const { error } = await App.sb.from('payment_methods').update({ is_default: true }).eq('id', id);
    return { error: error ? 'Unable to set this as your default card.' : null };
  }

  async function deletePaymentMethod(id) {
    const { error } = await App.sb.from('payment_methods').delete().eq('id', id);
    return { error: error ? 'Unable to remove this card.' : null };
  }

  // Charges a previously-saved card server-side via Paystack's
  // charge_authorization endpoint (paystack-charge-saved) — no redirect.
  // The function re-derives pricing/promo/stock/payout-splits itself from
  // live data, exactly like paystack-initialize; the browser only ever
  // says WHICH saved card and WHICH cart, never an amount. On any failure
  // it reports fallbackToCheckout so the caller can drop back to the
  // normal redirect-checkout flow instead of leaving the customer stuck.
  async function chargeSavedCard(paymentMethodId, groups, promoCode, idempotencyKey) {
    const { data, error } = await App.sb.functions.invoke('paystack-charge-saved', {
      body: { paymentMethodId, groups, promoCode: promoCode || null, idempotencyKey: idempotencyKey || null },
    });
    if (error) {
      // No response from the function at all (dropped connection) — the
      // card may or may not have been charged, so this must NOT fall back
      // to a fresh Paystack checkout (that would be a second, separate
      // payment). Retrying with the same idempotencyKey is safe instead.
      if (App.Connectivity.isNetworkError(error) || !navigator.onLine) {
        App.Connectivity.reportNetworkFailure();
        return { ok: false, transient: true, error: "We lost connection, so we couldn't confirm your card payment. Reconnect and tap Place Order again — you won't be charged twice." };
      }
      // A real non-2xx answer from the function: use its own body. This
      // matters — e.g. a 500 "Payment succeeded but we couldn't create
      // your order" must never be treated as "card not charged, redirect
      // to a new checkout", which would take a second payment.
      if (error.name === 'FunctionsHttpError' && error.context && error.context.json) {
        try {
          const body = await error.context.json();
          if (body && (body.error || body.ok === false)) return Object.assign({ ok: false }, body);
        } catch (e) { /* unreadable body — fall through */ }
      }
      return { ok: false, error: 'Unable to charge your saved card. Please try again or pay online.', fallbackToCheckout: true };
    }
    return data;
  }

  return {
    pendingReferenceFromUrl, clearReferenceFromUrl, startPaystackCheckout, verifyReturn,
    savePendingReference, clearPendingReference, getPendingReference, pendingReferenceSavedAt,
    fetchPaymentMethods, setDefaultPaymentMethod, deletePaymentMethod, chargeSavedCard,
    saveUnfinishedCheckout, getUnfinishedCheckout, clearUnfinishedCheckout, cartSignature,
  };
})();
