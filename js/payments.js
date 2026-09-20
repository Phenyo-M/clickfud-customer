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
  async function startPaystackCheckout(groups, promoCode) {
    const callbackUrl = window.location.origin + window.location.pathname;
    const { data, error } = await App.sb.functions.invoke('paystack-initialize', {
      body: { groups, promoCode: promoCode || null, callbackUrl },
    });
    if (error) return { error: 'Unable to start payment. Please try again.' };
    if (data.error) return { error: data.error };
    window.location.href = data.authorization_url;
    return { pending: true };
  }

  async function verifyReturn(reference) {
    const { data, error } = await App.sb.functions.invoke('paystack-verify', { body: { reference } });
    if (error) return { ok: false, error: 'Unable to verify your payment. Please contact support.' };
    return data;
  }

  return { pendingReferenceFromUrl, clearReferenceFromUrl, startPaystackCheckout, verifyReturn };
})();
