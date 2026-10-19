/* ============================================================
   CLICKFOOD — Group orders

   The leader picks a shop and who pays, then shares a code/link. Everyone
   adds their own food (and can change or remove only their own).
     Leader pays:   the leader locks it and checks out ONCE through the
                    normal checkout (same prices, payment and rules).
     Everyone pays: locking works out each person's share on the server;
                    each person pays their own share with PayFast
                    (create-payfast-payment). When every share is paid the shop
                    gets ONE combined order (supabase/group_payments.sql).
   Every line carries "Group G-XXXXXX · For <name>" so the kitchen knows who
   each item is for. All rules are enforced in the database.
   ============================================================ */
window.App = window.App || {};
App.Pages = App.Pages || {};

App.Pages.Groups = (function () {
  const S = App.Store;
  const U = App.Utils;
  const esc = U.escapeHtml;
  const PENDING_KEY = 'cfe_pending_group_link';
  const CHECKOUT_KEY = 'cfe_group_checkout';
  const PAY_KEY = 'cfe_group_pay';            // { ref, groupId, at } while a share payment is open
  const local = {
    hub: null, hubLoading: false, hubError: null,
    groups: {}, lists: {},           // id -> { data, loading, error }
    busy: false,
  };

  // ---------------- links (?group=G-XXXXXX / ?list=L-XXXXXX) ----------------
  function parseLink() {
    const url = new URL(window.location.href);
    const g = url.searchParams.get('group'), l = url.searchParams.get('list');
    const code = (g || l || '').toUpperCase();
    if (!code) return;
    if (/^[GL]-[A-Z2-9]{6}$/.test(code)) { try { localStorage.setItem(PENDING_KEY, code); } catch (e) {} }
    url.searchParams.delete('group'); url.searchParams.delete('list');
    history.replaceState({}, '', url.pathname + url.search + url.hash);
  }
  async function checkPending() {
    let code = null;
    try { code = localStorage.getItem(PENDING_KEY); } catch (e) {}
    if (!code || local.busy || !S.state.authReady) return;
    const profile = S.state.profile;
    if (!profile) return;                                   // joins after they log in / sign up
    if (profile.role !== 'customer' || App.Auth.needsCampusSetup(profile)) return;
    try { localStorage.removeItem(PENDING_KEY); } catch (e) {}
    local.busy = true;
    const res = await (code[0] === 'G' ? joinGroup(code) : joinList(code));
    local.busy = false;
    if (res.error) return App.Toast.error(res.error);
    S.setRoute({ view: code[0] === 'G' ? 'group-order' : 'food-list', params: { id: res.data.id } });
  }
  const linkFor = (code) => `${window.location.origin}/?${code[0] === 'G' ? 'group' : 'list'}=${code}`;
  async function share(code, title) {
    const link = linkFor(code);
    const text = `${title} on ClickFood. Join with code ${code}: ${link}`;
    try { if (navigator.share) { await navigator.share({ title, text, url: link }); return; } } catch (e) { if (e && e.name === 'AbortError') return; }
    try { await navigator.clipboard.writeText(text); App.Toast.success('Link copied. Paste it in any chat.'); }
    catch (e) { App.Toast.info ? App.Toast.info(`Code: ${code}`) : App.Toast.success(`Code: ${code}`); }
  }

  // ---------------- data ----------------
  const human = (error, fallback) => {
    const m = (error && error.message) || '';
    return !m || /violates|permission|function|JWT|fetch|relation|column/i.test(m) ? fallback : m;
  };
  async function loadHub(force) {
    if (local.hubLoading || (local.hub && !force)) return;
    local.hubLoading = true; local.hubError = null;
    const { data, error } = await App.sb.rpc('my_group_orders');
    local.hubLoading = false;
    if (error) local.hubError = 'Could not load your groups. Please try again.';
    else local.hub = { groups: data || [] };
    App.render();
  }
  async function loadGroup(id, force) {
    const st = local.groups[id] || (local.groups[id] = { data: null, loading: false, error: null });
    if (st.loading || (st.data && !force)) return st;
    st.loading = true; st.error = null;
    const [g, m, it, b] = await Promise.all([
      App.sb.from('group_orders').select('*').eq('id', id).maybeSingle(),
      App.sb.from('group_order_members').select('user_id, display_name, joined_at').eq('group_id', id).order('joined_at'),
      App.sb.from('group_order_items').select('*').eq('group_id', id).order('created_at'),
      App.sb.rpc('group_payment_board', { p_group: id }),
    ]);
    st.loading = false;
    if (g.error || m.error || it.error) st.error = 'Could not load this group order. Please try again.';
    else if (!g.data) st.error = "This group order doesn't exist or you're not in it.";
    else st.data = { group: g.data, members: m.data || [], items: it.data || [], board: b.error ? null : b.data };
    App.render();
    return st;
  }
  async function loadList(id, force) {
    const st = local.lists[id] || (local.lists[id] = { data: null, loading: false, error: null });
    if (st.loading || (st.data && !force)) return st;
    st.loading = true; st.error = null;
    const [l, m, it] = await Promise.all([
      App.sb.from('food_lists').select('*').eq('id', id).maybeSingle(),
      App.sb.from('food_list_members').select('user_id, display_name, joined_at').eq('list_id', id).order('joined_at'),
      App.sb.from('food_list_items').select('*').eq('list_id', id).order('created_at'),
    ]);
    st.loading = false;
    if (l.error || m.error || it.error) st.error = 'Could not load this list. Please try again.';
    else if (!l.data) st.error = "This list doesn't exist or you're not in it.";
    else st.data = { list: l.data, members: m.data || [], items: it.data || [] };
    App.render();
    return st;
  }
  async function joinGroup(code) {
    const { data, error } = await App.sb.rpc('join_group_order', { p_code: code });
    if (error) return { error: human(error, 'Could not join. Check the code and try again.') };
    if (!data || !data.id) return { error: "That group code doesn't exist. Check it and try again." };
    return { data };
  }
  async function joinList(code) {
    const { data, error } = await App.sb.rpc('join_food_list', { p_code: code });
    return error ? { error: human(error, 'Could not join. Check the code and try again.') } : { data };
  }

  // ---------------- helpers ----------------
  const me = () => (S.state.profile || {}).id;
  const menuItem = (id) => S.state.menu.find(m => m.id === id);
  function extrasFor(row) {
    const all = App.ItemExtras.forMenuItem(row.menu_item_id) || [];
    return (row.addon_ids || []).map(id => all.find(e => e.extra_id === id)).filter(Boolean);
  }
  function linePrice(row) {
    const m = menuItem(row.menu_item_id);
    if (!m) return 0;
    return (U.menuItemPrice(m) + extrasFor(row).reduce((n, e) => n + Number(e.price), 0)) * row.qty;
  }
  const statusLabel = { open: 'Adding food', locked: 'Leader is paying', awaiting_payment: 'Waiting for payments', placed: 'Sent to the shop', cancelled: 'Cancelled', expired: 'Expired' };
  const statusClass = { open: 'badge-success', locked: 'badge-yellow', awaiting_payment: 'badge-yellow', placed: 'badge-primary', cancelled: 'badge-gray', expired: 'badge-gray' };
  const shareLabel = { pending: 'Not paid', processing: 'Paying', paid: 'Paid', failed: 'Payment failed', cancelled: 'Not paid', refund_pending: 'Refund on the way', refunded: 'Refunded', refund_failed: 'Refund failed' };
  const shareClass = { pending: 'badge-gray', processing: 'badge-yellow', paid: 'badge-success', failed: 'badge-error', cancelled: 'badge-gray', refund_pending: 'badge-yellow', refunded: 'badge-gray', refund_failed: 'badge-error' };
  const orderLabel = { received: 'Received', preparing: 'Being prepared', ready: 'Ready to collect', collected: 'Collected', delivered: 'Collected', cancelled: 'Cancelled', uncollected: 'Not collected' };
  const modeLabel = (m) => (m === 'each' ? 'Everyone pays' : 'Leader pays');
  const groupState = (g) => (g.status === 'open' && new Date(g.expires_at) <= new Date() ? 'expired' : g.status);
  const timeOf = (iso) => new Date(iso).toLocaleTimeString('en-ZA', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Johannesburg' });

  // ---------------- views ----------------
  function backBar(label) {
    return App.Nav.backButton(label, 'solo');
  }

  function renderHub() {
    loadHub(false);
    const openStores = App.Pages.Home.allStores();
    const h = local.hub;
    const groups = h ? h.groups : [];
    return `
    <div class="page-wrap" style="max-width:720px;">
      ${App.Nav.pageHead('Group order', 'home')}

      <section class="card card-pad mb-4">
        <form data-form="grp-create-order" class="grp-inline-form">
          <select class="select" name="store_id" required aria-label="Shop">
            <option value="">Choose a shop</option>
            ${openStores.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}
          </select>
          <button type="submit" class="btn btn-primary">Start</button>
        </form>
        <form data-form="grp-join" class="grp-inline-form mt-2">
          <input class="input" name="code" placeholder="Have a code? e.g. G-7KQ2MX" maxlength="8" autocapitalize="characters" aria-label="Group code" />
          <button type="submit" class="btn btn-secondary">Join</button>
        </form>
      </section>

      ${groups.length ? `<h2 class="section-title mb-2">Your groups</h2><div class="grp-cards">${groups.map(g => {
        const store = App.Stores.getById(g.store_id);
        const state = groupState(g);
        const pct = g.people ? Math.round(g.people_paid / g.people * 100) : 0;
        return `<button type="button" class="card grp-card ${['cancelled', 'expired'].includes(state) ? 'is-done' : ''}" data-action="navigate" data-view="group-order" data-id="${esc(g.id)}">
          <div class="grp-card-top"><span class="font-bold">${esc(g.title || (store ? store.name : 'Group order'))}</span><span class="badge ${statusClass[state]}">${esc(statusLabel[state])}</span></div>
          <div class="text-sm text-muted">${esc(g.code)} · ${g.leader_id === me() ? 'You lead' : 'Leader ' + esc(g.leader_name || '')} · ${g.members} ${g.members === 1 ? 'person' : 'people'} · ${modeLabel(g.pay_mode)}</div>
          ${g.pay_mode === 'each' && g.people && state !== 'cancelled' ? `<div class="grp-card-progress"><div class="budget-track"><span class="budget-fill" style="width:${pct}%"></span></div><span class="text-xs text-muted">${g.people_paid} of ${g.people} paid</span></div>` : ''}
          <span class="grp-card-cta">View group <i data-lucide="chevron-right"></i></span>
        </button>`;
      }).join('')}</div>` : ''}

      ${local.hubLoading && !h ? '<p class="text-sm text-muted mt-3">Loading your groups…</p>' : ''}
      ${local.hubError ? `<div class="card card-pad mt-3"><p class="mb-2">${esc(local.hubError)}</p><button class="btn btn-secondary btn-sm" data-action="grp-reload-hub">Try again</button></div>` : ''}
    </div>`;
  }

  function renderGroup(id) {
    const st = local.groups[id] || {};
    if (!st.data && !st.loading && !st.error) loadGroup(id);
    if (st.error) return `<div class="page-wrap" style="max-width:720px;">${backBar('groups')}<div class="card card-pad"><p class="mb-2">${esc(st.error)}</p><button class="btn btn-secondary btn-sm" data-action="grp-reload" data-id="${esc(id)}">Try again</button></div></div>`;
    if (!st.data) return `<div class="page-wrap" style="max-width:720px;">${backBar('groups')}<p class="text-muted">Loading group order…</p></div>`;
    const { group: g, members, items } = st.data;
    const b = st.data.board || {};
    const store = App.Stores.getById(g.store_id);
    const leader = g.leader_id === me();
    const state = groupState(g);
    const open = state === 'open';
    const each = g.pay_mode === 'each';
    const total = items.reduce((n, r) => n + linePrice(r), 0);
    const byPerson = members.map(m => ({ m, rows: items.filter(r => r.user_id === m.user_id) }));
    const shares = b.shares || [];
    const shareOf = (uid) => shares.find(x => x.user_id === uid);
    const myShare = shares.find(x => x.is_me);
    const storeStatus = store ? App.Stores.statusOf(store) : null;
    watchGroup(g, myShare);

    let panel = '';
    if (state === 'awaiting_payment') {
      const pct = Number(b.total) ? Math.round(Number(b.paid) / Number(b.total) * 100) : 0;
      const late = b.pay_deadline && new Date(b.pay_deadline) <= new Date();
      panel = `
      <div class="card card-pad grp-pay mb-3">
        <div class="flex justify-between items-center mb-1"><strong>${U.money(b.paid)} of ${U.money(b.total)} paid</strong><span class="text-sm text-muted">${b.people_paid} of ${b.people} people</span></div>
        <div class="budget-track"><span class="budget-fill" style="width:${pct}%"></span></div>
        ${b.pay_deadline ? `<div class="text-xs mt-1 ${late ? 'text-error' : 'text-muted'}">${late ? "Time's up" : 'Pay by ' + timeOf(b.pay_deadline)}</div>` : ''}
        ${myShare ? `
        <div class="grp-myshare">
          <div><div class="text-sm text-muted">Your share</div><div class="grp-myshare-amount">${U.money(myShare.amount)}</div></div>
          <span class="badge ${shareClass[myShare.status]}">${esc(shareLabel[myShare.status])}</span>
        </div>
        ${['pending', 'failed', 'cancelled', 'processing'].includes(myShare.status) ? `
          <button class="btn btn-primary btn-block" data-action="grp-pay" data-id="${esc(g.id)}" ${local.paying ? 'disabled' : ''}>${local.paying ? 'Opening PayFast…' : myShare.status === 'processing' ? 'Continue payment' : 'Pay ' + U.money(myShare.amount)}</button>
          ${myShare.status === 'processing' ? `<button class="btn btn-ghost btn-sm btn-block mt-1" data-action="grp-check-pay" data-id="${esc(g.id)}">I've paid, check now</button>` : ''}` : ''}` : ''}
      </div>`;
    } else if (state === 'placed') {
      panel = `<div class="card card-pad grp-done mb-3"><i data-lucide="check-circle-2"></i><div><strong>Sent to ${esc(store ? store.name : 'the shop')}</strong>
        <div class="text-sm text-muted">${b.order_number ? 'Order ' + esc(b.order_number) + ' · ' : ''}${esc(orderLabel[b.order_status] || 'Received')}</div></div></div>`;
    } else if (state === 'cancelled') {
      panel = `<div class="card card-pad mb-3"><strong>This group order was cancelled.</strong>
        ${myShare && /refund/.test(myShare.status) ? `<div class="text-sm mt-1">Your ${U.money(myShare.amount)}: <span class="badge ${shareClass[myShare.status]}">${esc(shareLabel[myShare.status])}</span></div>` : ''}
        ${leader && (b.refunds_waiting || shares.some(x => x.status === 'refund_failed')) ? `<button class="btn btn-secondary btn-sm mt-2" data-action="grp-refunds" data-id="${esc(g.id)}">Send refunds</button>` : ''}</div>`;
    } else if (state === 'locked') {
      panel = `<div class="card card-pad mb-3"><strong>${leader ? 'Locked. Pay for everyone at checkout.' : 'Locked. The leader is paying for everyone.'}</strong></div>`;
    } else if (state === 'expired') {
      panel = '<div class="card card-pad mb-3"><strong>This group order expired.</strong></div>';
    }

    return `
    <div class="page-wrap" style="max-width:720px;">
      ${backBar('groups')}
      <div class="flex justify-between items-start gap-2 mb-1" style="flex-wrap:wrap;">
        <h1 class="page-title">${esc(g.title || (store ? store.name : 'Group order'))}</h1>
        <span class="badge ${statusClass[state]}">${esc(statusLabel[state])}</span>
      </div>
      <div class="grp-meta mb-3">
        <span>Code <strong>${esc(g.code)}</strong></span><span>${members.length} ${members.length === 1 ? 'person' : 'people'}</span>
        <span class="grp-mode-chip"><i data-lucide="${each ? 'users' : 'user-check'}"></i>${modeLabel(g.pay_mode)}</span>
        ${leader && open ? `<button type="button" class="link-btn text-sm" data-action="grp-switch-mode" data-id="${esc(g.id)}" data-mode="${each ? 'leader' : 'each'}">Change</button>` : ''}
      </div>
      ${storeStatus && !['open', 'busy'].includes(storeStatus.state) && ['open', 'locked', 'awaiting_payment'].includes(state) ? `<div class="closed-banner mb-3"><i data-lucide="clock"></i><div><strong>${esc(storeStatus.label)}</strong><div class="text-sm">${esc(storeStatus.detail)}</div></div></div>` : ''}
      ${panel}

      <div class="flex gap-2 mb-3" style="flex-wrap:wrap;">
        ${open ? `<button class="btn btn-primary btn-sm" data-action="grp-add-food" data-id="${esc(g.id)}"><i data-lucide="plus"></i>Add my food</button>` : ''}
        ${open ? `<button class="btn btn-secondary btn-sm" data-action="grp-share" data-code="${esc(g.code)}" data-title="${esc(g.title || (store ? store.name : 'Group order'))}"><i data-lucide="share-2"></i>Invite friends</button>` : ''}
        <button class="btn btn-ghost btn-sm" data-action="grp-reload" data-id="${esc(g.id)}"><i data-lucide="refresh-cw"></i>Refresh</button>
      </div>

      <div class="card grp-people">
        ${byPerson.map(({ m, rows }) => {
          const sub = rows.reduce((n, r) => n + linePrice(r), 0);
          const mine = m.user_id === me();
          const sh = shareOf(m.user_id);
          return `
          <div class="grp-person">
            <div class="flex justify-between items-center gap-2"><span class="font-bold">${esc(m.display_name)}${mine ? ' (you)' : ''}${m.user_id === g.leader_id ? ' · leader' : ''}</span>
              <span class="flex items-center gap-2">${sh ? `<span class="badge ${shareClass[sh.status]}">${esc(shareLabel[sh.status])}</span>` : ''}<span class="font-semibold">${U.money(sh ? sh.amount : sub)}</span></span></div>
            ${rows.length ? rows.map(r => {
              const mi = menuItem(r.menu_item_id);
              const ex = extrasFor(r);
              return `<div class="grp-line">
                <div class="grp-line-main"><span>${r.qty}× ${esc(mi ? mi.name : 'Item no longer on the menu')}</span>
                  ${ex.length ? `<div class="text-xs text-muted">+ ${ex.map(e => esc(e.name)).join(', ')}</div>` : ''}
                  ${r.note ? `<div class="text-xs text-muted">"${esc(r.note)}"</div>` : ''}</div>
                <span class="text-sm">${U.money(linePrice(r))}</span>
                ${mine && open ? `<span class="grp-line-actions">
                  <button class="btn-icon" data-action="grp-qty" data-id="${esc(r.id)}" data-group="${esc(g.id)}" data-delta="-1" aria-label="One less"><i data-lucide="minus"></i></button>
                  <button class="btn-icon" data-action="grp-qty" data-id="${esc(r.id)}" data-group="${esc(g.id)}" data-delta="1" aria-label="One more"><i data-lucide="plus"></i></button>
                </span>` : ''}
              </div>`;
            }).join('') : `<div class="text-sm text-muted">${mine && open ? 'Tap "Add my food".' : 'Nothing added.'}</div>`}
          </div>`;
        }).join('')}
        <div class="grp-total"><span>Group total</span><span>${U.money(b.total && !open ? b.total : total)}</span></div>
      </div>

      ${leader ? `<div class="flex gap-2 mt-3" style="flex-wrap:wrap;">
        ${state === 'open' && !each ? `<button class="btn btn-primary" data-action="grp-lock-checkout" data-id="${esc(g.id)}" ${items.length ? '' : 'disabled'}>Lock and check out</button>` : ''}
        ${state === 'open' && each ? `<button class="btn btn-primary" data-action="grp-lock-each" data-id="${esc(g.id)}" ${items.length ? '' : 'disabled'}>Lock and ask everyone to pay</button>` : ''}
        ${state === 'locked' ? `<button class="btn btn-primary" data-action="grp-checkout" data-id="${esc(g.id)}">Go to checkout</button><button class="btn btn-secondary" data-action="grp-unlock" data-id="${esc(g.id)}">Reopen for changes</button>` : ''}
        ${state === 'awaiting_payment' ? `<button class="btn btn-secondary" data-action="grp-extend" data-id="${esc(g.id)}">15 more minutes</button>
          ${Number(b.people_paid) > 0 && b.people_paid < b.people ? `<button class="btn btn-secondary" data-action="grp-drop-unpaid" data-id="${esc(g.id)}">Send without unpaid people</button>` : ''}
          ${!shares.some(x => x.status !== 'pending' && x.status !== 'failed' && x.status !== 'cancelled') ? `<button class="btn btn-secondary" data-action="grp-unlock" data-id="${esc(g.id)}">Reopen for changes</button>` : ''}` : ''}
        ${['open', 'locked', 'awaiting_payment'].includes(state) ? `<button class="btn btn-ghost" data-action="grp-cancel" data-id="${esc(g.id)}" data-each="${each ? '1' : ''}">Cancel group</button>` : ''}
      </div>` : ''}
      ${!leader && open ? `<button class="btn btn-ghost btn-sm mt-3" data-action="grp-leave" data-id="${esc(g.id)}">Leave group</button>` : ''}
    </div>`;
  }

  // ---------------- payments (everyone pays) ----------------
  // Refresh the page every few seconds only while payments are being made and
  // the group is on screen; nothing runs in the background otherwise.
  function watchGroup(g, myShare) {
    const active = g.status === 'awaiting_payment';
    if (!active) { if (local.pollFor === g.id) stopWatch(); }
    else if (local.pollFor !== g.id) {
      stopWatch();
      local.pollFor = g.id;
      local.pollTimer = setInterval(() => {
        const r = S.state.route;
        if (r.view !== 'group-order' || !r.params || r.params.id !== g.id) return stopWatch();
        if (document.visibilityState === 'visible') loadGroup(g.id, true);
      }, 8000);
    }
    // my payment is open: ask the server whether PayFast confirmed it (it never trusts the app)
    if (myShare && myShare.status === 'processing') {
      const p = pendingPay();
      if (p && p.groupId === g.id && Date.now() - (local.lastCheck || 0) > 8000) { local.lastCheck = Date.now(); verifyShare(p.ref, true); }
    }
  }
  function stopWatch() { clearInterval(local.pollTimer); local.pollTimer = null; local.pollFor = null; }
  function pendingPay() { try { return JSON.parse(localStorage.getItem(PAY_KEY) || 'null'); } catch (e) { return null; } }

  async function payShare(groupId) {
    if (local.paying) return;
    local.paying = true; App.render();
    const { data, error } = await App.sb.functions.invoke('create-payfast-payment', { body: { groupId, returnUrl: window.location.origin + window.location.pathname } });
    if (error || !data || data.error) {
      local.paying = false; App.render();
      let msg = data && data.error;
      if (!msg && error && error.context && error.context.json) { try { msg = (await error.context.json()).error; } catch (e) {} }
      return App.Toast.error(msg || 'Could not start your payment. Please try again.');
    }
    if (data.paid) { local.paying = false; App.Toast.success('You have paid your share.'); return loadGroup(groupId, true); }
    try { localStorage.setItem(PAY_KEY, JSON.stringify({ ref: data.reference, groupId, at: Date.now() })); } catch (e) {}
    App.Payments.goToPayfast(data);
  }

  // Back from PayFast (or on the group page): ask the server whether
  // PayFast has confirmed the payment.
  async function verifyShare(reference, quiet, cancelled) {
    const p = pendingPay();
    const groupId = p && p.ref === reference ? p.groupId : null;
    if (!quiet && !cancelled) App.Shared.openVerifyingPaymentModal();
    const { data, error } = await App.sb.functions.invoke('payfast-status', { body: { reference, cancelled: !!cancelled } });
    if (!quiet) App.Modal.close();
    const gid = (data && data.groupId) || groupId;
    if (data && data.ok) {
      try { localStorage.removeItem(PAY_KEY); } catch (e) {}
      if (!quiet) App.Toast.success(data.placed ? 'Paid. Everyone has paid, the order was sent to the shop.' : 'Paid. Thanks!');
    } else if (data && data.pending) {
      if (!quiet) App.Toast.info(cancelled ? 'Payment cancelled. You can pay again.' : 'Waiting for PayFast to confirm your payment.');
    } else if (!error || (data && data.error)) {
      try { localStorage.removeItem(PAY_KEY); } catch (e) {}
      if (!quiet) App.Toast.error((data && data.error) || 'Payment not completed. You can try again.');
    }
    local.hub = null;
    if (gid) {
      if (!quiet) S.setRoute({ view: 'group-order', params: { id: gid } });
      return loadGroup(gid, true);
    }
  }

  function renderList(id) {
    const st = local.lists[id] || {};
    if (!st.data && !st.loading && !st.error) loadList(id);
    if (st.error) return `<div class="page-wrap" style="max-width:720px;">${backBar('groups')}<div class="card card-pad"><p class="mb-2">${esc(st.error)}</p><button class="btn btn-secondary btn-sm" data-action="grp-reload-list" data-id="${esc(id)}">Try again</button></div></div>`;
    if (!st.data) return `<div class="page-wrap" style="max-width:720px;">${backBar('groups')}<p class="text-muted">Loading list…</p></div>`;
    const { list, members, items } = st.data;
    const owner = list.owner_id === me();
    return `
    <div class="page-wrap" style="max-width:720px;">
      ${backBar('groups')}
      <h1 class="page-title mb-1">${esc(list.name)}</h1>
      <p class="text-sm text-muted mb-3">Shared list · code <strong>${esc(list.invite_code)}</strong> · ${members.map(m => esc(m.display_name)).join(', ')}</p>
      <div class="flex gap-2 mb-3" style="flex-wrap:wrap;">
        <button class="btn btn-primary btn-sm" data-action="grp-suggest" data-id="${esc(list.id)}"><i data-lucide="plus"></i>Suggest a meal</button>
        <button class="btn btn-secondary btn-sm" data-action="grp-share" data-code="${esc(list.invite_code)}" data-title="${esc(list.name)}"><i data-lucide="share-2"></i>Invite friends</button>
      </div>
      <div class="card grp-people">
        ${members.map(m => {
          const rows = items.filter(i => i.added_by === m.user_id);
          if (!rows.length) return '';
          return `<div class="grp-person"><div class="font-bold mb-1">${esc(m.display_name)}${m.user_id === me() ? ' (you)' : ''}</div>
            ${rows.map(r => {
              const mi = menuItem(r.menu_item_id);
              const store = mi ? App.Stores.getById(mi.store_id) : null;
              const reason = mi ? App.Menu.unavailableReason(mi) : 'No longer on the menu';
              return `<div class="grp-line">
                <div class="grp-line-main">${mi ? `<button type="button" class="grp-link" data-action="open-food" data-id="${esc(mi.id)}">${esc(mi.name)}</button>` : '<span class="text-muted">Item no longer available</span>'}
                  <div class="text-xs text-muted">${store ? esc(store.name) : ''}${reason ? ` · ${esc(reason)}` : ''}</div></div>
                <span class="text-sm">${mi ? U.money(U.menuItemPrice(mi)) : ''}</span>
                <span class="grp-line-actions">
                  ${mi && !reason ? `<button class="btn btn-secondary btn-sm" data-action="fav-quick-add" data-id="${esc(mi.id)}">Add to cart</button>` : ''}
                  ${r.added_by === me() ? `<button class="btn-icon" data-action="grp-unsuggest" data-id="${esc(r.id)}" data-list="${esc(list.id)}" aria-label="Remove my suggestion"><i data-lucide="x"></i></button>` : ''}
                </span>
              </div>`;
            }).join('')}</div>`;
        }).join('') || '<div class="grp-person text-sm text-muted">No meals suggested yet. Be the first.</div>'}
      </div>
      <div class="flex gap-2 mt-3">
        ${owner ? `<button class="btn btn-ghost btn-sm" data-action="grp-delete-list" data-id="${esc(list.id)}">Delete list</button>`
          : `<button class="btn btn-ghost btn-sm" data-action="grp-leave-list" data-id="${esc(list.id)}">Leave list</button>`}
      </div>
    </div>`;
  }

  // ---------------- pickers ----------------
  function orderable(storeId) {
    return S.state.menu.filter(m => m.status === 'approved' && (!storeId || m.store_id === storeId))
      .sort((a, b) => (a.category || '').localeCompare(b.category || '') || a.name.localeCompare(b.name));
  }
  function addFoodModal(groupId) {
    const st = local.groups[groupId];
    if (!st || !st.data) return;
    const items = orderable(st.data.group.store_id);
    App.Modal.open(`
      <div class="modal-header"><span class="modal-title">Add my food</span><button class="modal-close" data-action="close-modal"><i data-lucide="x"></i></button></div>
      <div class="modal-body">
        ${items.length ? `<div class="grp-pick-list">${items.map(m => {
          const reason = App.Menu.unavailableReason(m);
          return `<button type="button" class="grp-pick" data-action="grp-pick-food" data-id="${esc(m.id)}" data-group="${esc(groupId)}" ${reason ? 'disabled' : ''}>
            <span><span class="font-semibold">${esc(m.name)}</span>${reason ? `<span class="text-xs text-muted"> · ${esc(reason)}</span>` : ''}</span><span>${U.money(U.menuItemPrice(m))}</span></button>`;
        }).join('')}</div>` : '<p class="text-muted">This shop has no items yet.</p>'}
      </div>`);
  }
  function itemDetailModal(groupId, itemId) {
    const m = menuItem(itemId);
    if (!m) return;
    const extras = App.ItemExtras.forMenuItem(m.id) || [];
    App.Modal.open(`
      <div class="modal-header"><span class="modal-title">${esc(m.name)}</span><button class="modal-close" data-action="close-modal"><i data-lucide="x"></i></button></div>
      <div class="modal-body">
        <form data-form="grp-add-item" data-group="${esc(groupId)}" data-item="${esc(m.id)}">
          <div class="field"><label>How many</label><input class="input" type="number" name="qty" min="1" max="20" value="1" required /></div>
          ${extras.length ? `<div class="field"><label>Extras</label>${extras.map(e => `<label class="checkbox-row"><input type="checkbox" name="extra" value="${esc(e.extra_id)}" /> ${esc(e.name)} <span class="text-muted">(${U.money(e.price)})</span></label>`).join('')}</div>` : ''}
          <div class="field"><label>Note for the kitchen (optional)</label><input class="input" name="note" maxlength="120" placeholder="e.g. no onions" /></div>
          <div class="modal-footer" style="padding:16px 0 0;"><button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button><button type="submit" class="btn btn-primary">Add · ${U.money(U.menuItemPrice(m))}</button></div>
        </form>
      </div>`);
  }
  function suggestModal(listId, search) {
    const q = (search || '').trim().toLowerCase();
    const items = orderable(null).filter(m => !q || m.name.toLowerCase().includes(q) || (App.Stores.getById(m.store_id) || {}).name?.toLowerCase().includes(q)).slice(0, 40);
    App.Modal.open(`
      <div class="modal-header"><span class="modal-title">Suggest a meal</span><button class="modal-close" data-action="close-modal"><i data-lucide="x"></i></button></div>
      <div class="modal-body">
        <form data-form="grp-suggest-search" data-list="${esc(listId)}" class="grp-inline-form mb-3">
          <div class="search-clear-wrap"><input class="input" name="q" value="${esc(search || '')}" placeholder="Search meals or shops" aria-label="Search" /></div>
          <button type="submit" class="btn btn-secondary">Search</button>
        </form>
        <div class="grp-pick-list">${items.map(m => {
          const store = App.Stores.getById(m.store_id);
          return `<button type="button" class="grp-pick" data-action="grp-pick-suggest" data-id="${esc(m.id)}" data-list="${esc(listId)}">
            <span><span class="font-semibold">${esc(m.name)}</span><span class="text-xs text-muted"> · ${esc(store ? store.name : '')}</span></span><span>${U.money(U.menuItemPrice(m))}</span></button>`;
        }).join('') || '<p class="text-muted">No meals match.</p>'}</div>
      </div>`);
  }

  function payModeModal(storeId) {
    const store = App.Stores.getById(storeId);
    App.Modal.open(`
      <div class="modal-header"><span class="modal-title">Who pays?</span><button class="modal-close" data-action="close-modal"><i data-lucide="x"></i></button></div>
      <div class="modal-body">
        <form data-form="grp-create-mode" data-store="${esc(storeId)}">
          ${store ? `<p class="text-sm text-muted mb-3">${esc(store.name)}</p>` : ''}
          <label class="grp-mode-card"><input type="radio" name="mode" value="leader" checked />
            <span class="grp-mode-ic"><i data-lucide="user-check"></i></span>
            <span><strong>One person pays</strong><span class="text-sm text-muted">Friends add food. You pay for everyone in one payment.</span></span></label>
          <label class="grp-mode-card"><input type="radio" name="mode" value="each" />
            <span class="grp-mode-ic"><i data-lucide="users"></i></span>
            <span><strong>Everyone pays</strong><span class="text-sm text-muted">Each person pays for their own food. The shop gets one order once all have paid.</span></span></label>
          <button type="submit" class="btn btn-primary btn-block mt-3">Continue</button>
        </form>
      </div>`);
  }
  function lockEachModal(groupId) {
    App.Modal.open(`
      <div class="modal-header"><span class="modal-title">Ask everyone to pay</span><button class="modal-close" data-action="close-modal"><i data-lucide="x"></i></button></div>
      <div class="modal-body">
        <form data-form="grp-lock-each" data-id="${esc(groupId)}">
          <p class="text-sm text-muted mb-3">Food can't change after this.</p>
          <div class="field"><label>Time to pay</label>
            <select class="select" name="minutes"><option value="15">15 minutes</option><option value="30" selected>30 minutes</option><option value="60">1 hour</option></select></div>
          <button type="submit" class="btn btn-primary btn-block">Lock and ask everyone to pay</button>
        </form>
      </div>`);
  }

  // ---------------- checkout ----------------
  async function lockAndCheckout(id, alreadyLocked) {
    if (!alreadyLocked) {
      const { error } = await App.sb.rpc('set_group_order_state', { p_group: id, p_action: 'lock' });
      if (error) return App.Toast.error(human(error, 'Could not lock the group. Please try again.'));
    }
    const st = await loadGroup(id, true);
    if (!st.data) return;
    const { group: g, members, items } = st.data;
    if (g.status !== 'locked') return App.Toast.error('This group order is not ready for checkout.');
    const store = App.Stores.getById(g.store_id);
    if (App.Stores.inTestMode(store)) return App.Toast.error(App.Stores.testModeMessage(store));
    if (store && !App.Stores.isOpenNow(store)) return App.Toast.error(App.Stores.closedMessage(store));
    const nameOf = (uid) => (members.find(m => m.user_id === uid) || {}).display_name || 'Friend';
    const go = () => {
      S.clearCart();
      items.forEach(r => {
        const m = menuItem(r.menu_item_id);
        if (!m) return;
        const ex = extrasFor(r);
        S.addToCart({
          menuItemId: m.id, name: m.name, price: U.menuItemPrice(m), image: m.image, qty: r.qty,
          addons: ex.map(e => ({ id: e.extra_id, name: e.name, price: Number(e.price) })),
          addonsTotal: ex.reduce((n, e) => n + Number(e.price), 0),
          specialInstructions: `Group ${g.code} · For ${nameOf(r.user_id)}${r.note ? ' · ' + r.note : ''}`,
          storeId: m.store_id, storeName: store ? store.name : '',
        });
      });
      try { localStorage.setItem(CHECKOUT_KEY, JSON.stringify({ id: g.id, at: Date.now() })); } catch (e) {}
      App.Pages.Customer.handleAction('go-checkout', {});
    };
    if (S.state.cart.length && !S.state.cart.every(c => /^Group /.test(c.specialInstructions || ''))) {
      return App.Modal.confirm({ title: 'Replace your cart?', message: 'Checking out the group order replaces what is in your cart now.', confirmLabel: 'Continue', onConfirm: go });
    }
    go();
  }
  // Called after any order is placed: if it was a group checkout, link it.
  async function afterCheckout() {
    let pending = null;
    try { pending = JSON.parse(localStorage.getItem(CHECKOUT_KEY) || 'null'); } catch (e) {}
    if (!pending || !pending.id || local.attaching) return;
    if (Date.now() - pending.at > 24 * 3600 * 1000) { try { localStorage.removeItem(CHECKOUT_KEY); } catch (e) {} return; }
    local.attaching = true;
    const { data, error } = await App.sb.rpc('attach_group_order', { p_group: pending.id });
    local.attaching = false;
    if (!error && data && data.status === 'placed') {
      try { localStorage.removeItem(CHECKOUT_KEY); } catch (e) {}
      delete local.groups[pending.id];
      App.Toast.success('Group order placed. Everyone can see it in the group.');
    }
  }

  // ---------------- actions / forms ----------------
  function handleAction(action, ds) {
    switch (action) {
      case 'grp-reload-hub': return loadHub(true);
      case 'grp-reload': return loadGroup(ds.id, true);
      case 'grp-reload-list': return loadList(ds.id, true);
      case 'grp-share': return share(ds.code, ds.title);
      case 'grp-add-food': return addFoodModal(ds.id);
      case 'grp-pick-food': return itemDetailModal(ds.group, ds.id);
      case 'grp-qty': {
        const st = local.groups[ds.group];
        const row = st && st.data && st.data.items.find(r => r.id === ds.id);
        if (!row) return;
        const qty = row.qty + Number(ds.delta);
        const q = qty <= 0 ? App.sb.from('group_order_items').delete().eq('id', row.id) : App.sb.from('group_order_items').update({ qty: Math.min(20, qty) }).eq('id', row.id);
        return q.then(({ error }) => { if (error) App.Toast.error('Could not change that. The group may be locked.'); loadGroup(ds.group, true); });
      }
      case 'grp-lock-checkout': return App.Modal.confirm({ title: 'Lock and check out?', message: 'Nobody can change their food after this. You pay for the whole order at checkout.', confirmLabel: 'Lock and continue', onConfirm: () => lockAndCheckout(ds.id, false) });
      case 'grp-checkout': return lockAndCheckout(ds.id, true);
      case 'grp-lock-each': return lockEachModal(ds.id);
      case 'grp-pay': return payShare(ds.id);
      case 'grp-check-pay': { const p = pendingPay(); return p ? verifyShare(p.ref, false) : loadGroup(ds.id, true); }
      case 'grp-switch-mode': return App.sb.rpc('set_group_pay_mode', { p_group: ds.id, p_pay_mode: ds.mode }).then(({ error }) => {
        if (error) return App.Toast.error(human(error, 'Could not change who pays.'));
        App.Toast.success(ds.mode === 'each' ? 'Everyone pays for their own food' : 'The leader pays for everyone'); loadGroup(ds.id, true);
      });
      case 'grp-extend': return App.sb.rpc('set_group_order_state', { p_group: ds.id, p_action: 'extend', p_minutes: 15 }).then(({ error }) => {
        if (error) return App.Toast.error(human(error, 'Could not change the deadline.'));
        App.Toast.success('15 more minutes to pay'); loadGroup(ds.id, true);
      });
      case 'grp-drop-unpaid': return App.Modal.confirm({ title: 'Send without unpaid people?', message: "People who haven't paid are removed with their food. The rest goes to the shop.", confirmLabel: 'Send order', onConfirm: async () => {
        const { error } = await App.sb.rpc('set_group_order_state', { p_group: ds.id, p_action: 'drop_unpaid' });
        if (error) return App.Toast.error(human(error, 'Could not send the order.'));
        App.Toast.success('Sent to the shop'); local.hub = null; loadGroup(ds.id, true);
      } });
      case 'grp-refunds': return App.sb.functions.invoke('payfast-group-refund', { body: { groupId: ds.id, retryFailed: true } }).then(({ data, error }) => {
        if (error || !data || data.error) return App.Toast.error((data && data.error) || 'Could not send the refunds. Please try again.');
        App.Toast.success(data.failed ? 'Some refunds failed. Try again later.' : data.sent ? 'Refunds sent' : 'Refunds recorded'); loadGroup(ds.id, true);
      });
      case 'grp-unlock': case 'grp-cancel': {
        const act = action === 'grp-unlock' ? 'unlock' : 'cancel';
        const run = async () => {
          const { error } = await App.sb.rpc('set_group_order_state', { p_group: ds.id, p_action: act });
          if (error) return App.Toast.error(human(error, 'Could not update the group.'));
          if (act === 'cancel') {
            if (ds.each) await App.sb.functions.invoke('payfast-group-refund', { body: { groupId: ds.id } });
            local.hub = null; delete local.groups[ds.id]; S.setRoute({ view: 'groups', params: {} }); App.Toast.success('Group order cancelled');
          }
          else loadGroup(ds.id, true);
        };
        return act === 'cancel' ? App.Modal.confirm({ title: 'Cancel this group order?', message: ds.each ? 'Anyone who already paid is refunded.' : 'Everyone\'s food in it is removed.', variant: 'danger', confirmLabel: 'Cancel group', onConfirm: run }) : run();
      }
      case 'grp-leave': return App.sb.from('group_order_members').delete().eq('group_id', ds.id).eq('user_id', me()).then(({ error }) => {
        if (error) return App.Toast.error('Could not leave the group.');
        local.hub = null; delete local.groups[ds.id]; S.setRoute({ view: 'groups', params: {} });
      });
      case 'grp-suggest': return suggestModal(ds.id, '');
      case 'grp-pick-suggest': return App.sb.from('food_list_items').insert({ list_id: ds.list, menu_item_id: ds.id, added_by: me() }).then(({ error }) => {
        if (error) return App.Toast.error(/duplicate|unique/i.test(error.message || '') ? 'You already suggested that one.' : 'Could not add it. Please try again.');
        App.Modal.close(); App.Toast.success('Suggested'); loadList(ds.list, true);
      });
      case 'grp-unsuggest': return App.sb.from('food_list_items').delete().eq('id', ds.id).then(({ error }) => { if (error) App.Toast.error('Could not remove it.'); loadList(ds.list, true); });
      case 'grp-leave-list': case 'grp-delete-list': {
        const del = action === 'grp-delete-list';
        return App.Modal.confirm({ title: del ? 'Delete this list?' : 'Leave this list?', message: del ? 'Everyone loses it.' : 'You can join again with the code.', variant: 'danger', confirmLabel: del ? 'Delete' : 'Leave', onConfirm: async () => {
          const { error } = del ? await App.sb.from('food_lists').delete().eq('id', ds.id) : await App.sb.from('food_list_members').delete().eq('list_id', ds.id).eq('user_id', me());
          if (error) return App.Toast.error('Something went wrong. Please try again.');
          local.hub = null; delete local.lists[ds.id]; S.setRoute({ view: 'groups', params: {} });
        } });
      }
      default: return;
    }
  }

  async function handleSubmit(formId, data, form) {
    if (formId === 'grp-create-order') {
      const storeId = data.get('store_id');
      if (!storeId) return App.Toast.error('Please choose a shop.');
      return payModeModal(storeId);
    }
    if (formId === 'grp-create-mode') {
      if (local.creating) return;
      local.creating = true;
      const { data: g, error } = await App.sb.rpc('create_group_order', { p_store_id: form.dataset.store, p_title: null, p_pay_mode: data.get('mode') === 'each' ? 'each' : 'leader' });
      local.creating = false;
      if (error) return App.Toast.error(human(error, 'Could not start the group order.'));
      App.Modal.close();
      local.hub = null;
      return S.setRoute({ view: 'group-order', params: { id: g.id } });
    }
    if (formId === 'grp-lock-each') {
      if (local.locking) return;
      local.locking = true;
      const { error } = await App.sb.rpc('set_group_order_state', { p_group: form.dataset.id, p_action: 'lock', p_minutes: Number(data.get('minutes')) || 30 });
      local.locking = false;
      if (error) return App.Toast.error(human(error, 'Could not lock the group. Please try again.'));
      App.Modal.close(); App.Toast.success('Everyone can pay now');
      return loadGroup(form.dataset.id, true);
    }
    if (formId === 'grp-join') {
      const code = (data.get('code') || '').trim().toUpperCase();
      if (!/^[GL]-[A-Z2-9]{6}$/.test(code)) return App.Toast.error('Codes look like G-7KQ2MX or L-7KQ2MX.');
      const res = await (code[0] === 'G' ? joinGroup(code) : joinList(code));
      if (res.error) return App.Toast.error(res.error);
      local.hub = null;
      return S.setRoute({ view: code[0] === 'G' ? 'group-order' : 'food-list', params: { id: res.data.id } });
    }
    if (formId === 'grp-create-list') {
      const { data: l, error } = await App.sb.rpc('create_food_list', { p_name: (data.get('name') || '').trim() });
      if (error) return App.Toast.error(human(error, 'Could not create the list.'));
      local.hub = null;
      return S.setRoute({ view: 'food-list', params: { id: l.id } });
    }
    if (formId === 'grp-add-item') {
      const qty = Math.max(1, Math.min(20, parseInt(data.get('qty'), 10) || 1));
      const { error } = await App.sb.from('group_order_items').insert({
        group_id: form.dataset.group, user_id: me(), menu_item_id: form.dataset.item, qty,
        addon_ids: data.getAll('extra'), note: (data.get('note') || '').trim() || null,
      });
      if (error) return App.Toast.error('Could not add it. The group may be locked.');
      App.Modal.close(); App.Toast.success('Added to the group order');
      return loadGroup(form.dataset.group, true);
    }
    if (formId === 'grp-suggest-search') return suggestModal(form.dataset.list, data.get('q'));
  }

  function render(view, params) {
    if (view === 'group-order') return renderGroup(params.id);
    if (view === 'food-list') return renderList(params.id);
    return renderHub();
  }

  return { render, handleAction, handleSubmit, parseLink, checkPending, afterCheckout, verifyShare };
})();
