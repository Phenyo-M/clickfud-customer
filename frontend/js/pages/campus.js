/* ============================================================
   CLICKFOOD — Campus Deals, What's Hot, rankings, weekly awards, polls (Phase 6a)

   Everything here comes from real data: deals are shops' own promo codes
   marked "show in Campus Deals"; rankings and awards are counted from
   collected orders by the database (campus_trending / weekly_awards) and
   show "Not enough data yet" instead of anything made up; poll results are
   vote counts only, never who voted for what.
   ============================================================ */
window.App = window.App || {};
App.Pages = App.Pages || {};

App.Pages.Campus = (function () {
  const S = App.Store;
  const U = App.Utils;
  const esc = U.escapeHtml;
  const FILTERS = [['all', 'All'], ['u30', 'Under R30'], ['u50', 'Under R50'], ['lunch', 'Lunch specials'], ['exam', 'Exam specials'], ['today', 'Today only']];
  const KIND_LABEL = { orientation: 'Orientation Week', exams: 'Exam Season', sports: 'Sports Week', end_of_semester: 'End of Semester', other: 'Campus campaign' };
  const local = { filter: 'all', tab: 'deals', trending: null, awards: null, polls: null, results: {}, campaigns: null, loadedAt: 0, loading: false };

  // ---------- data ----------
  function load(force) {
    if (local.loading || (!force && local.loadedAt && Date.now() - local.loadedAt < 5 * 60 * 1000)) return;
    local.loading = true;
    const nowIso = new Date().toISOString();
    Promise.all([
      App.sb.rpc('campus_trending', { p_days: 7 }),
      App.sb.rpc('weekly_awards'),
      App.sb.from('campaigns').select('*').lte('starts_at', nowIso).gt('ends_at', nowIso).order('starts_at', { ascending: false }),
      S.state.profile ? App.sb.from('polls').select('*').eq('status', 'published').lte('starts_at', nowIso).gt('ends_at', nowIso).order('created_at', { ascending: false }).limit(10) : Promise.resolve({ data: [] }),
    ]).then(([t, a, c, p]) => {
      local.loading = false; local.loadedAt = Date.now();
      local.trending = !t.error && Array.isArray(t.data) ? t.data : [];
      local.awards = !a.error && a.data && typeof a.data === 'object' ? a.data : { enough: false, awards: [] };
      local.campaigns = !c.error && Array.isArray(c.data) ? c.data : [];
      local.polls = !p.error && Array.isArray(p.data) ? p.data : [];
      (local.polls || []).forEach(pl => loadResults(pl.id));
      App.render();
    });
  }
  function loadResults(id) {
    App.sb.rpc('poll_results', { p_poll: id }).then(({ data, error }) => { local.results[id] = error ? null : data; App.render(); });
  }

  // ---------- deals ----------
  function filteredDeals() {
    const P = App.Promotions;
    return P.campusDeals().map(p => ({ p, price: P.dealPrice(p), store: App.Stores.getById(p.store_id) }))
      .filter(d => d.store && d.price)
      .filter(d => {
        const f = local.filter;
        if (f === 'u30') return d.price.now < 30;
        if (f === 'u50') return d.price.now < 50;
        if (f === 'lunch') return (d.p.deal_tags || []).includes('lunch');
        if (f === 'exam') return (d.p.deal_tags || []).includes('exam') || (d.p.campaign_id && (local.campaigns || []).some(c => c.id === d.p.campaign_id && c.kind === 'exams'));
        if (f === 'today') return (d.p.deal_tags || []).includes('today') || (d.p.expires_at && new Date(d.p.expires_at).toDateString() === new Date().toDateString());
        return true;
      })
      .sort((a, b) => a.price.now - b.price.now);
  }
  function dealTiming(p) {
    const parts = [];
    if (p.daily_start) parts.push(`${p.daily_start.slice(0, 5)} to ${p.daily_end.slice(0, 5)}`);
    if (p.expires_at) parts.push('until ' + new Date(p.expires_at).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', timeZone: 'Africa/Johannesburg' }));
    return parts.join(', ');
  }
  function dealCard(d) {
    const p = d.p;
    const off = p.type === 'percentage' ? `${Number(p.value)}% off` : `${U.money(p.value)} off`;
    const block = App.Promotions.dealBlock(p, null);
    const badge = !block ? '' : p.daily_start && /only on between/.test(block) ? `Only ${p.daily_start.slice(0, 5)} to ${p.daily_end.slice(0, 5)}` : block;
    return `
    <button type="button" class="deal-card" data-action="open-store" data-id="${esc(d.store.id)}">
      <div class="deal-card-top"><span class="deal-off">${esc(off)}</span>${p.audience === 'students' ? '<span class="badge badge-yellow">Students</span>' : ''}${badge ? `<span class="badge badge-gray">${esc(badge)}</span>` : ''}</div>
      <div class="deal-title">${esc(p.title || d.price.item.name)}</div>
      <div class="text-xs text-muted">${esc(d.store.name)}${p.title ? ` · ${esc(App.Promotions.productName(p) || '')}` : ''}</div>
      <div class="deal-price"><strong>${U.money(d.price.now)}</strong> <s class="text-muted">${U.money(d.price.was)}</s></div>
      <div class="deal-meta">Code <strong>${esc(p.code)}</strong>${p.min_order ? ` · min order ${U.money(p.min_order)}` : ''}${dealTiming(p) ? ` · ${esc(dealTiming(p))}` : ''}</div>
      ${p.usage_limit ? `<div class="text-xs text-muted">${Math.max(0, p.usage_limit - p.used_count)} left</div>` : ''}
    </button>`;
  }
  function filterChips() {
    return `<div class="filter-bar deal-filters">${FILTERS.map(([k, l]) => `<button class="chip ${local.filter === k ? 'active' : ''}" data-action="camp-filter" data-key="${k}">${l}</button>`).join('')}</div>`;
  }

  // ---------- home sections (under the shortcuts on the home screen) ----------
  function homeSections() {
    load(false);
    const deals = filteredDeals();
    const camp = (local.campaigns || [])[0];
    // A poll you haven't answered yet, or the one you just answered (so you see the results).
    const poll = (local.polls || []).find(p => local.results[p.id] === null || p.id === local.justVoted) || null;
    const hot = (local.trending || []).slice(0, 3);
    return `
    ${camp ? `<div class="campaign-banner mb-3"><div><div class="campaign-kind">${esc(KIND_LABEL[camp.kind] || camp.name)}</div><div class="font-bold">${esc(camp.tagline || camp.name)}</div>
      <div class="text-xs">Until ${new Date(camp.ends_at).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', timeZone: 'Africa/Johannesburg' })}</div></div>
      <button class="btn btn-sm btn-secondary" data-action="camp-open" data-tab="deals">See deals</button></div>` : ''}

    ${App.Promotions.campusDeals().length ? `
    <div class="flex justify-between items-center mb-2">
      <span class="section-title">Campus Deals</span>
      <button type="button" class="view-all-link" data-action="camp-open" data-tab="deals">See all</button>
    </div>
    ${filterChips()}
    ${deals.length ? `<div class="deal-row mb-4">${deals.slice(0, 8).map(dealCard).join('')}</div>` : '<p class="text-sm text-muted mb-4">No deals here.</p>'}` : ''}

    ${hot.length ? `
    <div class="flex justify-between items-center mb-2">
      <span class="section-title">What's hot</span>
      <button type="button" class="view-all-link" data-action="camp-open" data-tab="rankings">Rankings</button>
    </div>
      <div class="hot-list mb-4">${hot.map((t, i) => `<button type="button" class="hot-row" data-action="open-store" data-id="${esc(t.store_id)}"><span class="hot-rank">#${i + 1}</span><span class="hot-name">${esc(t.name)}<span class="text-xs text-muted"> · ${esc(t.store_name)}</span></span><span class="text-xs text-muted">${t.units} ordered</span></button>`).join('')}</div>` : ''}

    ${poll ? pollCard(poll, true) : ''}`;
  }

  function pollCard(poll, compact) {
    const res = local.results[poll.id];
    const store = poll.store_id ? App.Stores.getById(poll.store_id) : null;
    return `
    <div class="card card-pad mb-4 poll-card">
      <div class="text-xs text-muted mb-1">${store ? `Poll from ${esc(store.name)}` : 'Campus poll'} · closes ${new Date(poll.ends_at).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', timeZone: 'Africa/Johannesburg' })}</div>
      <div class="font-bold mb-2">${esc(poll.question)}</div>
      ${res ? poll.options.map((o, i) => {
        const n = res.counts[i] || 0, pct = res.total ? Math.round(n / res.total * 100) : 0;
        return `<div class="poll-result ${res.mine === i ? 'is-mine' : ''}"><div class="flex justify-between text-sm"><span>${esc(o)}${res.mine === i ? ' (your vote)' : ''}</span><span>${pct}%</span></div><div class="poll-track"><span style="width:${pct}%"></span></div></div>`;
      }).join('') + `<p class="text-xs text-muted mt-1">${res.total} vote${res.total === 1 ? '' : 's'}</p>`
        : `<div class="poll-options">${poll.options.map((o, i) => `<button class="btn btn-secondary btn-sm" data-action="camp-vote" data-id="${esc(poll.id)}" data-option="${i}">${esc(o)}</button>`).join('')}</div>`}
      ${compact && (local.polls || []).length > 1 ? '<button type="button" class="view-all-link mt-2" data-action="camp-open" data-tab="polls">More polls</button>' : ''}
    </div>`;
  }

  // ---------- full page ----------
  function render() {
    load(false);
    const TABS = [['deals', 'Deals'], ['rankings', 'Rankings'], ['awards', 'Weekly awards'], ['polls', 'Polls']];
    let body = '';
    if (local.tab === 'deals') {
      const deals = filteredDeals();
      body = `${filterChips()}${deals.length ? `<div class="deal-grid">${deals.map(dealCard).join('')}</div>` : '<div class="empty-state"><h3>No deals right now</h3></div>'}`;
    } else if (local.tab === 'rankings') {
      body = local.trending === null ? '<p class="text-muted">Loading…</p>' : local.trending.length ? `
        <h2 class="font-bold mb-1">Most ordered this week</h2>
        <div class="card hot-list-full">${local.trending.map((t, i) => `<button type="button" class="hot-row" data-action="open-store" data-id="${esc(t.store_id)}"><span class="hot-rank">#${i + 1}</span><span class="hot-name">${esc(t.name)}<span class="text-xs text-muted"> · ${esc(t.store_name)}</span></span><span class="text-sm">${t.units} ordered</span></button>`).join('')}</div>`
        : '<div class="empty-state"><h3>No rankings yet</h3></div>';
    } else if (local.tab === 'awards') {
      const a = local.awards;
      const list = a && a.enough ? (a.awards || []).filter(Boolean) : [];
      body = !a ? '<p class="text-muted">Loading…</p>' : list.length ? `
        <p class="text-sm text-muted mb-3">Week of ${new Date(a.week_start + 'T12:00:00Z').toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', timeZone: 'UTC' })} to ${new Date(a.week_end + 'T12:00:00Z').toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', timeZone: 'UTC' })}</p>
        <div class="award-grid">${list.map(w => `<div class="card card-pad award"><div class="text-xs text-muted">${esc(w.title)}</div><div class="font-bold" style="font-size:17px;">${esc(w.winner)}</div>${w.detail ? `<div class="text-sm text-muted">${esc(w.detail)}</div>` : ''}<div class="text-sm mt-1">${esc(w.measure)}</div></div>`).join('')}</div>`
        : '<div class="empty-state"><h3>No awards yet</h3></div>';
    } else {
      body = !S.state.profile ? '<p class="text-muted">Sign in to vote in polls.</p>' : local.polls === null ? '<p class="text-muted">Loading…</p>'
        : local.polls.length ? local.polls.map(p => pollCard(p, false)).join('') : '<div class="empty-state"><h3>No open polls</h3></div>';
    }
    return `
    <div class="page-wrap" style="max-width:900px;">
      ${App.Nav.pageHead('Campus', 'home')}
      <div class="filter-bar mb-3">${TABS.map(([k, l]) => `<button class="chip ${local.tab === k ? 'active' : ''}" data-action="camp-tab" data-key="${k}">${l}</button>`).join('')}</div>
      ${body}
    </div>`;
  }

  function handleAction(action, ds) {
    if (action === 'camp-filter') { local.filter = ds.key; return App.render(); }
    if (action === 'camp-tab') { local.tab = ds.key; return App.render(); }
    if (action === 'camp-open') { local.tab = ds.tab || 'deals'; S.setRoute({ view: 'campus', params: {} }); return App.forceScrollTop(); }
    if (action === 'camp-vote') {
      if (!S.state.profile) return App.Toast.error('Please sign in to vote.');
      return App.sb.rpc('vote_poll', { p_poll: ds.id, p_option: Number(ds.option) }).then(({ error }) => {
        if (error) return App.Toast.error(/already voted|closed/i.test(error.message || '') ? error.message : 'Could not save your vote. Please try again.');
        App.Toast.success('Vote saved');
        local.justVoted = ds.id;
        loadResults(ds.id);
      });
    }
  }

  return { homeSections, render, handleAction };
})();
