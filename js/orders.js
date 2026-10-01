/* ============================================================
   CLICKFUD — order lifecycle: create, status machine, ETA,
   cancellation rules, COD calculator
   ============================================================ */
window.App = window.App || {};

App.Orders = (function () {
  const S = App.Store;

  async function fetchAll() {
    // Explicit customer_id filter (RLS already limits a customer to their
    // own orders — this returns exactly the same rows). Without it Postgres
    // re-evaluated the "orders select" policy against EVERY order in the
    // table: ~3.5s per call at 100k orders in load testing, vs ~0.2ms with
    // it (idx_orders_customer).
    const uid = S.state.profile && S.state.profile.id;
    if (!uid) { S.set({ orders: [] }); return; }
    const { data, error } = await App.sb.from('orders').select('*').eq('customer_id', uid).order('created_at', { ascending: false });
    if (error) { console.error(error); return; }
    S.set({ orders: data || [] });
  }

  function historyEntry(status) {
    return { status, at: new Date().toISOString() };
  }

  // discountOverride lets a multi-store checkout (App.Pages.Customer.placeOrder)
  // pass this store's already-validated share of one combined promo discount,
  // instead of each split order re-validating/re-consuming the promo code on
  // its own — promoCode is then only a display label, never re-applied here.
  // Inserts the order row, protected against duplicates by clientRequestId
  // (one UUID per checkout attempt per shop, reused on every retry of that
  // same attempt — see js/pages/customer.js orderRequestKey()). If an
  // earlier attempt's insert actually committed but its response was lost
  // (connection dropped mid-request), the unique index from
  // supabase/offline_order_idempotency.sql rejects the repeat with 23505
  // and the ALREADY-EXISTING order is returned instead of a second one.
  async function insertOrderIdempotent(payload, clientRequestId) {
    const withKey = clientRequestId ? Object.assign({}, payload, { client_request_id: clientRequestId }) : payload;
    let { data, error } = await App.sb.from('orders').insert(withKey).select().single();

    if (error && clientRequestId && /client_request_id/.test(error.message || '') && (error.code === 'PGRST204' || error.code === '42703')) {
      // The migration hasn't been run on this database yet — still place
      // the order (unprotected), exactly as before this change.
      console.warn('orders.client_request_id missing — run supabase/offline_order_idempotency.sql');
      ({ data, error } = await App.sb.from('orders').insert(payload).select().single());
    }

    if (error && error.code === '23505' && clientRequestId) {
      const existing = await App.sb.from('orders').select('*')
        .eq('customer_id', payload.customer_id).eq('client_request_id', clientRequestId).maybeSingle();
      if (existing.data) return { data: existing.data, recovered: true };
    }
    return { data, error };
  }

  async function createOrder({ items, storeId, deliveryLocation, paymentMethod, promoCode, discountOverride, deliveryFee: feeInput, clientRequestId }) {
    if (!S.state.profile) return { error: 'Please sign in to place an order.' };
    if (!items || items.length === 0) return { error: 'Your cart is empty.' };
    if (!storeId) return { error: 'Unable to place order. No store selected.' };
    const store = App.Stores.getById(storeId);
    if (!store) return { error: 'This store is no longer available.' };
    if (!App.Stores.isOpenNow(store)) return { error: App.Stores.closedMessage(store) };

    for (const it of items) {
      if (it.isAddon) {
        // Shop add-ons (drinks/snacks/sides) live in their own table, scoped
        // to a store the same way menu_items is — never trust the client's
        // notion of which shop an add-on belongs to.
        const addon = S.state.addons.find(a => a.id === it.menuItemId);
        if (!addon || !addon.is_available) return { error: `"${it.name}" is currently unavailable.` };
        if (addon.store_id !== storeId) return { error: 'Your cart has items from more than one store. Please check out separately.' };
      } else {
        const menuItem = S.state.menu.find(m => m.id === it.menuItemId);
        if (!menuItem || !menuItem.available) return { error: `"${it.name}" is currently unavailable.` };
        if (menuItem.stock < it.qty) return { error: `Only ${menuItem.stock} left of "${it.name}".` };
        // Every item in a single order must come from the same store — a cart
        // spanning stores would mean a driver/kitchen ticket with no single
        // owner, so this is rejected rather than silently mixed.
        if (menuItem.store_id !== storeId) return { error: 'Your cart has items from more than one store. Please check out separately.' };
      }
    }
    if (deliveryLocation && deliveryLocation.fulfilment !== 'collection' && (!deliveryLocation.campus || !deliveryLocation.building)) {
      return { error: 'Please complete your delivery details.' };
    }
    if (!['cod', 'card'].includes(paymentMethod)) return { error: 'Please choose a payment method.' };

    // Price is re-derived from the live product/add-on record rather than
    // trusted from the client cart, so a stale cached price can't affect
    // what actually gets charged. For a real menu item (not an add-on),
    // this includes the developer's own per-item platform fee — one
    // combined price to the customer, exactly like the card/Paystack path
    // (see paystack-initialize) computes it, so a menu item never shows a
    // different price depending on how the customer pays.
    function livePrice(it) {
      if (it.isAddon) return Number(S.state.addons.find(a => a.id === it.menuItemId).price);
      const record = S.state.menu.find(m => m.id === it.menuItemId);
      return Number(record.price) + Number(record.platform_fee_amount || 0);
    }

    const subtotal = items.reduce((sum, it) => sum + livePrice(it) * it.qty + (it.addonsTotal || 0) * it.qty, 0);
    const deliveryFee = Number(feeInput) || 0;
    let discount = 0, appliedPromo = null, promoCodeLabel = null;
    if (discountOverride !== undefined && discountOverride !== null) {
      discount = round2(Math.max(0, Number(discountOverride) || 0));
      promoCodeLabel = promoCode || null;
    } else if (promoCode) {
      const result = App.Promotions.validateCode(promoCode, items);
      if (result.error) return { error: result.error };
      discount = result.discount;
      appliedPromo = result.promo;
      promoCodeLabel = appliedPromo.code;
    }
    const total = Math.max(0, subtotal + deliveryFee - discount);
    if (!App.Utils.isValidPrice(total)) return { error: 'Unable to place order. Invalid order total.' };

    // Recorded for visibility only — unlike a card order (where Paystack's
    // Transaction Split actually moves this amount to the platform), cash
    // for a COD order goes straight to the shop in person. There is no
    // automatic collection mechanism for that portion here; this is just
    // an honest record of what the fee would have been, for reconciliation.
    const platformFeeAmount = round2(items.reduce((sum, it) => {
      if (it.isAddon) return sum;
      const menuItem = S.state.menu.find(m => m.id === it.menuItemId);
      return sum + Number(menuItem?.platform_fee_amount || 0) * it.qty;
    }, 0));

    const payload = {
      customer_id: S.state.profile.id,
      store_id: storeId,
      items: items.map(it => ({
        // price is snapshotted per unit INCLUDING any add-ons, so downstream
        // views (receipt, kitchen ticket, order detail) can just do price*qty.
        menuItemId: it.menuItemId, name: it.name, price: round2(livePrice(it) + (it.addonsTotal || 0)), qty: it.qty,
        image: it.image, addons: it.addons || [], specialInstructions: App.Utils.sanitizeText(it.specialInstructions, 200),
        isAddon: !!it.isAddon,
      })),
      subtotal: round2(subtotal),
      delivery_fee: round2(deliveryFee),
      discount: round2(discount),
      promo_code: promoCodeLabel,
      total: round2(total),
      payment_method: paymentMethod,
      payment_status: paymentMethod === 'card' ? 'paid' : 'pending',
      platform_fee_amount: platformFeeAmount,
      delivery_location: deliveryLocation,
      // Auto-accepted straight into the kitchen's real queue — no manual
      // "Start Preparing" click gates this anymore (a burst of orders used
      // to mean a kitchen had to click Accept on every single one before
      // any of them could even start; see migration_governance.sql section
      // 38). 'received' is still logged in the history a moment earlier so
      // the tracker's step-by-step display is unchanged.
      status: 'preparing',
      status_history: [historyEntry('received'), historyEntry('preparing')],
    };

    const { data, error } = await insertOrderIdempotent(payload, clientRequestId);
    if (error) {
      // No response at all — the order may or may not have reached the
      // database. Never reported as success; the caller keeps the same
      // clientRequestId so retrying can't create a second order.
      if (App.Connectivity.isNetworkError(error)) {
        App.Connectivity.reportNetworkFailure();
        return { error: "We lost connection, so we couldn't confirm your order. Reconnect and tap Place Order again — if it already went through, you'll see that same order, not a new one.", networkError: true };
      }
      return { error: 'Unable to place order. ' + error.message };
    }

    S.upsertIn('orders', data);
    // Stock decrement happens server-side via a trigger (customers can't
    // legally UPDATE menu_items themselves under RLS) — realtime delivers
    // the resulting menu_items change back to every open tab automatically.
    // Not fired when discountOverride was used — the caller (a multi-store
    // checkout split across several createOrder calls) increments usage
    // exactly once itself, so one customer action can't consume the code
    // multiple times just because it spanned multiple stores.
    if (appliedPromo) await App.Promotions.incrementUsage(appliedPromo.id);
    await App.Notifications.create(S.state.profile.id, `Order ${data.order_number} received — the kitchen is preparing it now!`, 'order_received');
    await sendPush(S.state.profile.id, '🛒 Order confirmed!', `Your order ${data.order_number} has been received.`, 'order-placed');
    // Only this store's items leave the cart — any other store's items
    // (from a multi-store checkout) stay put until their own order succeeds.
    S.removeCartItemsByStore(storeId);
    return { data };
  }

  // Real OS-level push notification, sent via the send-push Edge Function
  // (the only place the VAPID private key is used). Fire-and-forget by
  // design — a push failure must never block placing/updating an order,
  // same trust model as App.Notifications.create above it.
  async function sendPush(userId, title, body, tag) {
    try {
      const { error } = await App.sb.functions.invoke('send-push', { body: { userId, title, body, tag } });
      if (error) console.error('send-push failed', error);
    } catch (e) {
      console.error('send-push failed', e);
    }
  }

  function round2(n) { return Math.round(n * 100) / 100; }

  // Orders now go straight to 'preparing' on creation (auto-accept, see
  // migration_governance.sql section 38) — restricting this to 'received'
  // alone, like before, would mean no order could ever be cancelled at
  // all. The real, authoritative gate is server-side (paystack-cancel-
  // order Edge Function) and must allow the exact same two statuses.
  function canCancel(order) { return order.status === 'received' || order.status === 'preparing'; }

  // Routed through the paystack-cancel-order Edge Function rather than a
  // direct table update — a paid "card" order now involves a real
  // Paystack refund (minus a cancellation fee), which has to happen
  // server-side with the secret key. COD orders still cancel for free;
  // the function itself decides which case applies. There is no
  // client-side RLS path left for a customer to cancel an order directly
  // (see migration_governance.sql section 17) specifically so this can't
  // be bypassed to get a free cancellation on a paid order.
  async function cancelOrder(order) {
    if (!canCancel(order)) return { error: 'This order can no longer be cancelled.' };
    const { data, error } = await App.sb.functions.invoke('paystack-cancel-order', { body: { orderId: order.id } });
    if (error) return { error: 'Unable to cancel this order right now. Please try again.' };
    if (!data || data.error) return { error: (data && data.error) || 'Unable to cancel this order right now.' };
    S.upsertIn('orders', data.order);
    return { data: data.order, feeAmount: data.feeAmount, refundAmount: data.refundAmount };
  }

  async function updateStatus(order, status, extra) {
    const history = [...(order.status_history || []), historyEntry(status)];
    const patch = Object.assign({ status, status_history: history }, extra || {});
    const { data, error } = await App.sb.from('orders').update(patch).eq('id', order.id).select().single();
    if (error) return { error: error.message };
    S.upsertIn('orders', data);
    return { data };
  }

  // Deliberately no customer-facing notification/push for this transition
  // — "your order was received" (createOrder, above) and "your order is
  // ready" (markReady, below) are the only two updates a customer needs
  // mid-order; "now preparing" was extra noise between them.
  async function startPreparing(order) {
    return updateStatus(order, 'preparing');
  }

  async function markReady(order) {
    const r = await updateStatus(order, 'ready');
    if (!r.error) {
      await App.Notifications.create(order.customer_id, `Order ${order.order_number} is ready!`, 'ready');
      await sendPush(order.customer_id, '✅ Your order is ready!', `${order.order_number} is ready for collection.`, 'order-ready');
    }
    return r;
  }

  async function setPriority(order, priority) {
    const { data, error } = await App.sb.from('orders').update({ priority }).eq('id', order.id).select().single();
    if (error) return { error: error.message };
    S.upsertIn('orders', data);
    return { data };
  }

  async function dispatchToDrivers(order) {
    const { data: drivers, error } = await App.sb.from('profiles').select('id').eq('role', 'driver').eq('driver_status', 'available');
    if (error) return { error: error.message };
    for (const d of (drivers || [])) {
      await App.Notifications.create(d.id, `New delivery available: order ${order.order_number}.`, 'delivery_available');
    }
    return { ok: true, count: (drivers || []).length };
  }

  async function acceptDelivery(order) {
    if (order.status !== 'ready' || order.assigned_driver) return { error: 'This delivery is no longer available.' };
    const eta = new Date(Date.now() + App.CONST.ETA_MINUTES * 60000).toISOString();
    const r = await updateStatus(order, 'out_for_delivery', { assigned_driver: S.state.profile.id, eta });
    if (!r.error) {
      await App.Notifications.create(order.customer_id, `Driver is on the way! Estimated arrival: ${App.CONST.ETA_MINUTES} minutes.`, 'out_for_delivery');
      await sendPush(order.customer_id, '🛵 Your order is on the way!', `Your driver is on the way. Estimated arrival: ${App.CONST.ETA_MINUTES} minutes.`, 'order-out-for-delivery');
    }
    return r;
  }

  async function markDelivered(order, cashTendered) {
    if (order.status !== 'out_for_delivery') return { error: 'This order is not out for delivery.' };
    const extra = { payment_status: 'paid' };
    if (cashTendered !== undefined && cashTendered !== null) extra.cash_tendered = Number(cashTendered);
    const r = await updateStatus(order, 'delivered', extra);
    if (!r.error) await App.Notifications.create(order.customer_id, `Order ${order.order_number} has been delivered. Enjoy your meal!`, 'delivered');
    return r;
  }

  async function confirmPayment(order, cashReceived) {
    const extra = { payment_status: 'paid' };
    if (cashReceived !== undefined && cashReceived !== null) extra.cash_tendered = Number(cashReceived);
    const { data, error } = await App.sb.from('orders').update(extra).eq('id', order.id).select().single();
    if (error) return { error: error.message };
    S.upsertIn('orders', data);
    return { data };
  }

  function calcChange(total, tendered) {
    total = Number(total) || 0;
    tendered = Number(tendered) || 0;
    const change = round2(tendered - total);
    return { change: Math.max(0, change), insufficient: tendered < total, exact: Math.abs(tendered - total) < 0.005 };
  }

  return {
    fetchAll, createOrder, insertOrderIdempotent, canCancel, cancelOrder, updateStatus,
    startPreparing, markReady, setPriority, dispatchToDrivers,
    acceptDelivery, markDelivered, confirmPayment, calcChange, round2,
  };
})();
