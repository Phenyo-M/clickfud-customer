/* ============================================================
   CLICKFUD — My Timetable: UI

   A weekly grid, not a flat "Add Class" list: day tabs (Mon..Sun) show
   one day's classes at a time on mobile, with a Week View to see the
   whole week at once. Every "GET DIRECTIONS" button still hands off
   straight to Google Maps via App.Orientation.MapsLauncher — this page
   never renders a map or calculates a route itself.

   ---------------- Groups, not raw rows ----------------
   The table (public.timetable_entries) still only ever models ONE of
   two shapes per row — a plain weekly-recurring slot (day_of_week set,
   specific_date null, recurs forever) or a single dated occurrence
   (specific_date set) — exactly as before this redesign, so the
   server-side 10-minute reminder cron and every existing row keep
   working completely unchanged with zero migration. "Every 2 weeks" /
   "Custom" recurrence (new in this redesign) is expanded CLIENT-SIDE,
   up front, into a bounded batch of ordinary dated rows (see
   App.Timetable.expandRecurrence) — each one is then just a normal
   one-off entry the rest of the system already understands.

   That means a single real class can now be several rows sharing the
   same module/type/time/venue/campus/day — this file groups those back
   together for display (buildGroups below) so the student always sees
   and edits/deletes/duplicates ONE card per class, never a wall of
   near-identical rows. Editing a group is implemented as "delete the
   old rows, generate + insert the new ones" (see saveForm) rather than
   a per-row diff — simpler and correct for every case that matters;
   the one accepted trade-off is documented right on saveForm.

   The 10-minute reminder itself is entirely server-side (pg_cron ->
   timetable-reminder-check) — nothing here needs to be open for a
   reminder to fire. The only thing this module owns is the on-screen
   "starts in N minutes" countdown, which is cosmetic and independent of
   the real reminder.
   ============================================================ */
window.App = window.App || {};
App.Pages = App.Pages || {};

App.Pages.Timetable = (function () {
  const S = App.Store;
  const U = App.Utils;
  const O = App.Orientation;
  const T = App.Timetable;

  // day_of_week follows App.CONST.DAYS / JS Date.getDay(): 0=Sunday..6=Saturday.
  const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DAY_TAB_ORDER = [1, 2, 3, 4, 5, 6, 0]; // displayed Monday..Sunday
  const CLASS_TYPE_PRESETS = ['Lecture', 'Tutorial', 'Practical', 'Seminar', 'Lab', 'Test', 'Meeting'];

  const local = {
    editingGroup: null, // the group object being replaced on save, or null for a fresh add
    launching: {},
    viewMode: 'day', // 'day' | 'week'
    selectedDay: new Date().getDay(),
    duplicateGroupKey: null,
    duplicateDays: [],
    userCoords: null, // cached once known this session — see ensureUserCoords()
  };

  // Directions should start from where the student actually IS, not just
  // the class's campus — same reasoning/behaviour as My Orientation's own
  // ensureUserCoords (js/pages/orientation.js): reuse a coordinate we
  // already have, otherwise make one silent, best-effort attempt to get
  // it (prompting for permission if needed), and never block or fail the
  // directions hand-off if it's denied/unavailable/slow.
  async function ensureUserCoords() {
    if (local.userCoords) return local.userCoords;
    const res = await O.LocationService.getCurrentPosition({ timeout: 4000 });
    if (res.error) return null;
    local.userCoords = res.coords;
    return local.userCoords;
  }

  // Live "starts in N minutes" — only ticks while this page is actually
  // on screen, so it never disrupts anything mid-interaction elsewhere
  // (the Home screen's own Next Class card just recomputes fresh
  // whenever that screen happens to re-render for any other reason).
  let tickInterval = null;
  function startTicking() {
    if (tickInterval) return;
    tickInterval = setInterval(() => { if (S.state.route.view === 'timetable') App.render(); }, 60000);
  }
  function stopTicking() {
    if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
  }

  function dayLabel(dow) { return App.CONST.DAYS[dow] || '—'; }
  function formatTimeRange(entry) { return `${entry.start_time.slice(0, 5)} – ${entry.end_time.slice(0, 5)}`; }
  function formatDateNice(iso) {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  // Next date (>= today) that falls on the given weekday — used only to
  // give the date picker a sensible, real default when quick-adding a
  // weekly class from a day tab, or when reconstructing one to edit.
  function nextDateForDow(dow, from) {
    const base = from ? new Date(from) : new Date();
    base.setHours(0, 0, 0, 0);
    base.setDate(base.getDate() + ((Number(dow) - base.getDay() + 7) % 7));
    return T.toISODate(base);
  }

  function directionsButton(entry, size) {
    const key = entry.id || 'form';
    return `<button type="button" class="btn btn-primary ${size || ''} ${local.launching[key] ? 'btn-loading' : ''}" data-action="timetable-directions" data-id="${U.escapeHtml(entry.id || '')}" ${local.launching[key] ? 'disabled' : ''}>
      <i data-lucide="navigation"></i> Get Directions
    </button>`;
  }

  async function getDirections(entryId) {
    const entry = S.state.timetable.find((e) => e.id === entryId);
    if (!entry) return;
    const campus = O.getCampusByName(entry.campus);
    if (!campus) { App.Toast.error("This class's campus isn't recognized — please edit it and reselect a campus."); return; }
    const key = entryId;
    if (local.launching[key]) return;
    local.launching[key] = true;
    App.render();
    const coords = await ensureUserCoords();
    const res = O.MapsLauncher.launch({ name: entry.venue }, campus, coords);
    if (res.error) {
      local.launching[key] = false;
      App.Toast.error(res.message || "This class's venue can't be sent to Google Maps right now.");
      App.render();
      return;
    }
    setTimeout(() => { local.launching[key] = false; App.render(); }, 1500);
  }

  // ---------------- Next/Current Class card (also used by the Home screen) ----------------
  // Unchanged by this redesign — still reads S.state.timetable directly,
  // one row at a time, exactly as before.
  function nextClassCard() {
    const info = App.Timetable.nextOrCurrentClass(S.state.timetable, new Date());
    if (!info) {
      return `<div class="card card-pad text-center"><i data-lucide="graduation-cap" style="width:22px;height:22px;color:var(--text-muted);"></i><p class="text-sm text-muted mt-2">No upcoming classes</p></div>`;
    }
    const isCurrent = info.status === 'current';
    const timing = isCurrent ? 'Happening now' : App.Timetable.formatUpcoming(info, new Date());
    return `
    <div class="card card-pad">
      <div class="text-xs font-semibold text-muted mb-1" style="text-transform:uppercase;letter-spacing:.04em;">${isCurrent ? 'Current Class' : 'Next Class'}</div>
      <h3 class="font-bold" style="font-size:17px;line-height:1.25;">${U.escapeHtml(info.entry.module)}</h3>
      <div class="text-sm text-muted mt-1">${U.escapeHtml(info.entry.class_type)} · ${formatTimeRange(info.entry)}</div>
      <div class="text-sm text-muted">${U.escapeHtml(info.entry.venue)}, ${U.escapeHtml(info.entry.campus)} Campus</div>
      <div class="text-sm font-semibold mt-2" style="color:var(--color-primary);">${timing}</div>
      <div class="mt-3">${directionsButton(info.entry)}</div>
    </div>`;
  }

  // ---------------- Grouping (one card per real class, not per row) ----------------
  function groupKey(e) {
    return [e.module, e.module_code || '', e.class_type, e.day_of_week, e.start_time, e.end_time, e.venue, e.campus].join('|');
  }

  // Label shown on a group's card, describing its recurrence honestly
  // from the rows that actually exist — never guessed/invented.
  function recurrenceLabel(group) {
    if (group.entries.length === 1) {
      return group.representative.specific_date ? formatDateNice(group.representative.specific_date) : 'Every week';
    }
    const dates = group.entries.map((e) => e.specific_date).filter(Boolean).sort();
    const spanDays = dates.length > 1 ? Math.round((new Date(dates[1]) - new Date(dates[0])) / 86400000) : null;
    const weeks = spanDays ? Math.round(spanDays / 7) : null;
    const cadence = weeks === 2 ? 'Every 2 weeks' : weeks ? `Every ${weeks} weeks` : 'Recurring';
    return `${cadence} · ${dates.length} sessions (${formatDateNice(dates[0])} – ${formatDateNice(dates[dates.length - 1])})`;
  }

  function buildGroups(entries) {
    const map = new Map();
    (entries || []).forEach((e) => {
      const key = groupKey(e);
      if (!map.has(key)) map.set(key, { key, entries: [] });
      map.get(key).entries.push(e);
    });
    return [...map.values()].map((g) => {
      g.entries.sort((a, b) => (a.specific_date || '').localeCompare(b.specific_date || ''));
      g.representative = g.entries[0];
      return g;
    });
  }

  function allGroups() { return buildGroups(S.state.timetable); }

  // ---------------- Main screen ----------------
  function render() {
    startTicking();
    const groups = allGroups();
    const dayCounts = {};
    groups.forEach((g) => { dayCounts[g.representative.day_of_week] = (dayCounts[g.representative.day_of_week] || 0) + 1; });

    return `
    <div class="page-wrap" style="max-width:640px;">
      <div class="flex items-center gap-2 mb-3">
        <button type="button" class="btn-icon" data-action="navigate" data-view="home" aria-label="Back"><i data-lucide="arrow-left"></i></button>
        <h1 class="page-title" style="margin:0;">My Timetable</h1>
      </div>

      ${nextClassCard()}

      <div class="flex items-center justify-between mt-4 mb-2">
        <div class="tt-view-toggle">
          <button type="button" class="tt-view-toggle-btn ${local.viewMode === 'day' ? 'active' : ''}" data-action="timetable-view-mode" data-mode="day">Day</button>
          <button type="button" class="tt-view-toggle-btn ${local.viewMode === 'week' ? 'active' : ''}" data-action="timetable-view-mode" data-mode="week">Week View</button>
        </div>
        <div class="flex items-center gap-2">
          ${groups.length ? `<button type="button" class="btn btn-secondary btn-sm" data-action="ttshare-open"><i data-lucide="share-2"></i> Share</button>` : ''}
          <button type="button" class="btn btn-primary btn-sm" data-action="timetable-add"><i data-lucide="plus"></i> Add Class</button>
        </div>
      </div>

      ${local.viewMode === 'day' ? renderDayTabs(dayCounts) : ''}

      ${local.viewMode === 'day' ? renderDayView(groups) : renderWeekView(groups)}
    </div>`;
  }

  function renderDayTabs(dayCounts) {
    return `
    <div class="tt-day-tabs">
      ${DAY_TAB_ORDER.map((dow) => `
        <button type="button" class="tt-day-tab ${local.selectedDay === dow ? 'active' : ''}" data-action="timetable-select-day" data-day="${dow}">
          <span>${SHORT_DAYS[dow]}</span>
          ${dayCounts[dow] ? `<span class="tt-day-tab-dot"></span>` : ''}
        </button>`).join('')}
    </div>`;
  }

  function renderDayView(groups) {
    const dayGroups = groups.filter((g) => g.representative.day_of_week === local.selectedDay)
      .sort((a, b) => a.representative.start_time.localeCompare(b.representative.start_time));
    return `
    <div class="mt-2">
      ${dayGroups.length
        ? `<div class="flex flex-col gap-2">${dayGroups.map(groupCard).join('')}</div>`
        : `<div class="empty-state"><div class="icon-wrap"><i data-lucide="calendar"></i></div><h3>No classes on ${dayLabel(local.selectedDay)}</h3><p>Tap "Add Class" above to add one.</p></div>`}
    </div>`;
  }

  function renderWeekView(groups) {
    return DAY_TAB_ORDER.map((dow) => {
      const dayGroups = groups.filter((g) => g.representative.day_of_week === dow)
        .sort((a, b) => a.representative.start_time.localeCompare(b.representative.start_time));
      if (!dayGroups.length) return '';
      return `
      <div class="mt-3">
        <h3 class="font-bold mb-2" style="font-size:14px;">${dayLabel(dow)}</h3>
        <div class="flex flex-col gap-2">${dayGroups.map(groupCard).join('')}</div>
      </div>`;
    }).join('') || `<div class="empty-state mt-2"><div class="icon-wrap"><i data-lucide="calendar"></i></div><h3>No classes yet</h3><p>Add your first class to start getting reminders and directions.</p></div>`;
  }

  function groupCard(group) {
    const e = group.representative;
    return `<div class="card card-pad">
      <div class="flex justify-between items-start gap-2">
        <div>
          <div class="font-bold">${U.escapeHtml(e.module)}${e.module_code ? ` <span class="text-muted font-semibold">· ${U.escapeHtml(e.module_code)}</span>` : ''}</div>
          <div class="text-sm text-muted">${U.escapeHtml(e.class_type)} • ${formatTimeRange(e)}</div>
          <div class="text-sm text-muted mt-1"><i data-lucide="map-pin" style="width:13px;height:13px;"></i> ${U.escapeHtml(e.venue)}, ${U.escapeHtml(e.campus)} Campus</div>
          ${e.lecturer ? `<div class="text-xs text-muted mt-1">${U.escapeHtml(e.lecturer)}</div>` : ''}
          ${e.notes ? `<div class="text-xs text-muted mt-1">"${U.escapeHtml(e.notes)}"</div>` : ''}
          <div class="text-xs font-semibold mt-1" style="color:var(--color-primary);">${recurrenceLabel(group)}</div>
        </div>
        <div class="flex gap-1">
          <button type="button" class="btn-icon" data-action="timetable-duplicate" data-key="${U.escapeHtml(group.key)}" aria-label="Duplicate to another day"><i data-lucide="copy"></i></button>
          <button type="button" class="btn-icon" data-action="timetable-edit-group" data-key="${U.escapeHtml(group.key)}" aria-label="Edit"><i data-lucide="pencil"></i></button>
          <button type="button" class="btn-icon" data-action="timetable-delete-group" data-key="${U.escapeHtml(group.key)}" aria-label="Delete"><i data-lucide="trash-2"></i></button>
        </div>
      </div>
      <div class="mt-2">${directionsButton(e, 'btn-sm')}</div>
    </div>`;
  }

  // ---------------- Add/Edit form ----------------
  function findGroup(key) { return allGroups().find((g) => g.key === key) || null; }

  // seed: optional { day_of_week } used only when quick-adding from a
  // day tab, so the form opens with that day already selected.
  function openForm(group, seed) {
    local.editingGroup = group || null;
    const e = group ? group.representative : null;
    const dow = e ? e.day_of_week : (seed && seed.day_of_week != null ? seed.day_of_week : new Date().getDay());
    const anchorDate = e ? (e.specific_date || nextDateForDow(dow)) : nextDateForDow(dow);

    // Reconstruct an honest recurrence description from the rows that
    // actually exist for an edit — never guessed for a fresh add.
    let repeatMode = 'weekly', intervalWeeks = 2, untilDate = '';
    if (group) {
      if (group.entries.length === 1) {
        repeatMode = e.specific_date ? 'none' : 'weekly';
      } else {
        repeatMode = 'interval';
        const dates = group.entries.map((x) => x.specific_date).sort();
        const spanDays = Math.round((new Date(dates[1]) - new Date(dates[0])) / 86400000);
        intervalWeeks = Math.max(1, Math.round(spanDays / 7));
        untilDate = dates[dates.length - 1];
      }
    }

    const campus = (e && e.campus) || (O.CAMPUSES[0] && O.CAMPUSES[0].name) || '';
    const venueChips = T.venueSuggestions(campus);

    App.Modal.open(`
      <div class="modal-header"><span class="modal-title">${group ? 'Edit Class' : 'Add Class'}</span><button class="modal-close" data-action="close-modal"><i data-lucide="x"></i></button></div>
      <div class="modal-body">
        <form data-form="timetable-form">
          <div class="field"><label>Module / Subject *</label><input class="input" name="module" value="${U.escapeHtml(e ? e.module : '')}" placeholder="e.g. Applied Logic, or Study Group" required /></div>
          <div class="flex gap-2">
            <div class="field" style="flex:1"><label>Module Code</label><input class="input" name="module_code" value="${U.escapeHtml(e ? (e.module_code || '') : '')}" placeholder="e.g. ALL 121" /></div>
            <div class="field" style="flex:1">
              <label>Class Type *</label>
              <input class="input" id="tt-class-type-input" name="class_type" value="${U.escapeHtml(e ? e.class_type : '')}" placeholder="e.g. Lecture" required />
            </div>
          </div>
          <div class="flex gap-2" style="flex-wrap:wrap;margin:-6px 0 8px;">
            ${CLASS_TYPE_PRESETS.map((t) => `<button type="button" class="chip" data-action="timetable-fill-field" data-field="class_type" data-value="${U.escapeHtml(t)}">${U.escapeHtml(t)}</button>`).join('')}
          </div>

          <div class="field">
            <label>Date *</label>
            <input class="input" type="date" name="specific_date" data-action-change="timetable-date-change" value="${U.escapeHtml(anchorDate)}" required />
            <div class="text-xs text-muted mt-1">Any date — this is used as-is for a one-off class, or as the starting date for a recurring one.</div>
          </div>
          <div class="flex gap-2">
            <div class="field" style="flex:1"><label>Start Time *</label><input class="input" type="time" name="start_time" value="${U.escapeHtml(e ? e.start_time.slice(0, 5) : '')}" required /></div>
            <div class="field" style="flex:1"><label>End Time *</label><input class="input" type="time" name="end_time" value="${U.escapeHtml(e ? e.end_time.slice(0, 5) : '')}" required /></div>
          </div>

          <div class="field">
            <label>Campus *</label>
            <select class="select" name="campus" data-action-change="timetable-campus-change" required>
              ${O.CAMPUSES.map((c) => `<option value="${U.escapeHtml(c.name)}" ${campus === c.name ? 'selected' : ''}>${U.escapeHtml(c.name)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>Venue *</label>
            <input class="input" id="tt-venue-input" name="venue" list="tt-venue-datalist" value="${U.escapeHtml(e ? e.venue : '')}" placeholder="Search the campus venue list, or type your own" required autocomplete="off" />
            <div class="text-xs text-muted mt-1">Not in the list? Just type it — any venue can be saved.</div>
          </div>
          <div id="tt-venue-chip-row" class="flex gap-2" style="flex-wrap:wrap;margin:-4px 0 8px;">
            ${venueChips.map((v) => `<button type="button" class="chip" data-action="timetable-fill-field" data-field="venue" data-value="${U.escapeHtml(v)}">${U.escapeHtml(v)}</button>`).join('')}
          </div>
          ${venueDatalistsHtml()}

          <div class="flex gap-2">
            <div class="field" style="flex:1"><label>Lecturer</label><input class="input" name="lecturer" value="${U.escapeHtml(e ? (e.lecturer || '') : '')}" placeholder="Optional" /></div>
          </div>
          <div class="field"><label>Notes</label><textarea class="input" name="notes" rows="2" placeholder="Optional">${U.escapeHtml(e ? (e.notes || '') : '')}</textarea></div>

          <div class="divider" style="margin:14px 0;"></div>
          <h3 class="font-bold mb-2" style="font-size:14px;">Repeats</h3>
          <div class="field">
            <select class="select" name="repeat_mode">
              <option value="none" ${repeatMode === 'none' ? 'selected' : ''}>Does not repeat — just this one date</option>
              <option value="weekly" ${repeatMode === 'weekly' ? 'selected' : ''}>Every week</option>
              <option value="interval" ${repeatMode === 'interval' ? 'selected' : ''}>Every few weeks (set below)</option>
            </select>
          </div>
          <label class="text-sm font-semibold" style="display:block;margin-bottom:6px;">Repeats on</label>
          <div class="flex gap-2 mb-2" style="flex-wrap:wrap;">
            ${DAY_TAB_ORDER.map((d) => `
              <label class="chip" style="cursor:pointer;">
                <input type="checkbox" name="repeat_days" value="${d}" id="tt-day-cb-${d}" ${d === dow ? 'checked' : ''} style="margin-right:4px;" />${SHORT_DAYS[d]}
              </label>`).join('')}
          </div>
          <div class="flex gap-2">
            <div class="field" style="flex:1"><label>Every N weeks</label><input class="input" type="number" min="1" max="12" name="interval_weeks" value="${intervalWeeks}" /></div>
            <div class="field" style="flex:1"><label>Ends on</label><input class="input" type="date" name="repeat_until" value="${U.escapeHtml(untilDate)}" /></div>
          </div>
          <div class="text-xs text-muted mb-2">"Every N weeks" and "Ends on" are only used when Repeats is set to "Every few weeks" above.</div>

          <div class="modal-footer" style="padding:16px 0 0;">
            <button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button>
            <button type="submit" class="btn btn-primary">${group ? 'Save Changes' : 'Add Class'}</button>
          </div>
        </form>
      </div>`, { size: 'lg' });
  }

  // One <datalist> per real campus, generated once per form-open (plain
  // static data, not a live query) — see js/orientation-providers.js
  // allVenueNames(). Swapping the Venue input's `list` attribute (see
  // handleChange's 'timetable-campus-change' case) re-points it at the
  // right one the moment the campus changes, with no re-render at all.
  function venueDatalistsHtml() {
    return O.CAMPUSES.map((c) => `
      <datalist id="tt-venue-datalist-${U.escapeHtml(c.id)}">
        ${T.allVenueNames(c.name).map((v) => `<option value="${U.escapeHtml(v)}"></option>`).join('')}
      </datalist>`).join('') + `<datalist id="tt-venue-datalist"></datalist>`;
  }

  function readRecurrenceFromForm(data) {
    const type = data.get('repeat_mode');
    const days = data.getAll('repeat_days').map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6);
    return {
      type,
      days,
      intervalWeeks: Number(data.get('interval_weeks')) || 2,
      until: data.get('repeat_until') || null,
    };
  }

  // Edit = "replace": the old group's rows are deleted, then the newly
  // edited/expanded set is inserted fresh, rather than diffing row by
  // row. Simple and correct for every real edit (change the time, add a
  // day, switch cadence, etc.). The one accepted trade-off: if a
  // reminder already fired for an occurrence in the last few minutes
  // before this exact edit, and that occurrence's row gets replaced,
  // its dedup record (tied to the old row's id) no longer matches the
  // new row — an extremely narrow window that, at worst, could re-fire
  // that one reminder once. Not worth a full per-row diff/reconciliation
  // system for.
  async function saveForm(data) {
    const base = {
      module: data.get('module'),
      module_code: data.get('module_code') || null,
      class_type: data.get('class_type'),
      start_time: data.get('start_time'),
      end_time: data.get('end_time'),
      campus: data.get('campus'),
      venue: data.get('venue'),
      lecturer: data.get('lecturer') || null,
      notes: data.get('notes') || null,
    };
    const anchorDate = data.get('specific_date');
    const recurrence = readRecurrenceFromForm(data);
    const rows = T.expandRecurrence(base, anchorDate, recurrence);

    // Validate the FIRST generated row up front for a fast, clear error
    // before touching the network — every generated row shares the same
    // non-date fields, so one check covers them all.
    const err = T.validate(rows[0]);
    if (err) return { error: err };

    if (local.editingGroup) {
      await Promise.all(local.editingGroup.entries.map((entry) => T.remove(entry.id)));
    }
    return T.createMany(rows);
  }

  async function handleSubmit(formId, data) {
    if (formId !== 'timetable-form') return;
    const res = await saveForm(data);
    if (res.error) { App.Toast.error(res.error); return; }
    App.Modal.close();
    App.Toast.success(local.editingGroup ? 'Class updated' : 'Class added');
    local.editingGroup = null;
  }

  function confirmDeleteGroup(key) {
    const group = findGroup(key);
    if (!group) return;
    const e = group.representative;
    const multi = group.entries.length > 1;
    App.Modal.confirm({
      title: multi ? 'Delete this recurring class?' : 'Delete this class?',
      message: `"${e.module}" (${dayLabel(e.day_of_week)}, ${formatTimeRange(e)})${multi ? ` — all ${group.entries.length} upcoming sessions` : ''} will be removed, and its reminders will no longer fire.`,
      variant: 'danger', confirmLabel: 'Delete', cancelLabel: 'Cancel',
      onConfirm: async () => {
        const results = await Promise.all(group.entries.map((entry) => T.remove(entry.id)));
        const failed = results.find((r) => r.error);
        if (failed) { App.Toast.error(failed.error); return; }
        App.Toast.success('Class deleted');
      },
    });
  }

  // ---------------- Duplicate to another day ----------------
  // The fast path from the brief: "ALL 121 is also on Wednesday at the
  // same time" — copies the class's own fields onto one or more OTHER
  // days as a plain weekly-recurring class, regardless of whether the
  // original itself repeats weekly or on a fixed interval. Deliberately
  // the simple, common-case interpretation of "duplicate".
  function openDuplicateSheet(key) {
    const group = findGroup(key);
    if (!group) return;
    local.duplicateGroupKey = key;
    local.duplicateDays = [];
    renderDuplicateSheet();
  }

  function renderDuplicateSheet() {
    const group = findGroup(local.duplicateGroupKey);
    if (!group) return;
    const e = group.representative;
    App.Modal.open(`
      <div class="modal-header"><span class="modal-title">Duplicate "${U.escapeHtml(e.module)}"</span><button class="modal-close" data-action="close-modal"><i data-lucide="x"></i></button></div>
      <div class="modal-body">
        <p class="text-sm text-muted mb-2">Copy this class (${formatTimeRange(e)}, ${U.escapeHtml(e.venue)}) onto other days, as a weekly class.</p>
        <div class="flex gap-2" style="flex-wrap:wrap;">
          ${DAY_TAB_ORDER.filter((d) => d !== e.day_of_week).map((d) => `
            <button type="button" class="chip ${local.duplicateDays.includes(d) ? 'active' : ''}" data-action="timetable-duplicate-toggle-day" data-day="${d}">${SHORT_DAYS[d]}</button>`).join('')}
        </div>
      </div>
      <div class="modal-footer" style="padding:16px 0 0;">
        <button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button>
        <button type="button" class="btn btn-primary" data-action="timetable-duplicate-confirm" ${local.duplicateDays.length ? '' : 'disabled'}>Copy to ${local.duplicateDays.length || ''} day${local.duplicateDays.length === 1 ? '' : 's'}</button>
      </div>`, { closeOnOverlay: false });
  }

  function toggleDuplicateDay(dow) {
    const i = local.duplicateDays.indexOf(dow);
    if (i === -1) local.duplicateDays.push(dow); else local.duplicateDays.splice(i, 1);
    renderDuplicateSheet();
  }

  async function confirmDuplicate() {
    const group = findGroup(local.duplicateGroupKey);
    if (!group || !local.duplicateDays.length) return;
    const e = group.representative;
    const base = {
      module: e.module, module_code: e.module_code, class_type: e.class_type,
      start_time: e.start_time, end_time: e.end_time, campus: e.campus, venue: e.venue,
      lecturer: e.lecturer, notes: e.notes,
    };
    const rows = local.duplicateDays.map((dow) => ({ ...base, day_of_week: dow, specific_date: null }));
    const res = await T.createMany(rows);
    if (res.error) { App.Toast.error(res.error); return; }
    App.Modal.close();
    App.Toast.success(`Copied to ${rows.length} day${rows.length === 1 ? '' : 's'}`);
    local.duplicateGroupKey = null; local.duplicateDays = [];
  }

  // ---------------- Small in-modal helpers (no full re-render) ----------------
  // Setting one field's value directly on the already-open modal's DOM —
  // used by the class-type/venue quick-fill chips. Deliberately NOT a
  // App.render()/re-open of the modal: that would rebuild the whole form
  // (and every other field's in-progress value with it) just to fill in
  // one field, the same kind of unnecessary full-rerender this app's
  // search boxes were already fixed to avoid.
  function fillModalField(field, value) {
    const root = App.Modal.getRoot();
    if (!root) return;
    const el = root.querySelector(`[name="${field}"]`);
    if (el) el.value = value;
  }

  function handleAction(action, ds) {
    switch (action) {
      case 'timetable-add': return openForm(null, { day_of_week: local.selectedDay });
      case 'timetable-edit-group': {
        const group = findGroup(ds.key);
        if (group) openForm(group);
        return;
      }
      case 'timetable-delete-group': return confirmDeleteGroup(ds.key);
      case 'timetable-directions': return getDirections(ds.id);
      case 'timetable-select-day': local.selectedDay = Number(ds.day); return App.render();
      case 'timetable-view-mode': local.viewMode = ds.mode; return App.render();
      case 'timetable-fill-field': return fillModalField(ds.field, ds.value);
      case 'timetable-duplicate': return openDuplicateSheet(ds.key);
      case 'timetable-duplicate-toggle-day': return toggleDuplicateDay(Number(ds.day));
      case 'timetable-duplicate-confirm': return confirmDuplicate();
      default: return;
    }
  }

  // Surgical DOM patches only — see the file header note on why editing
  // an already-open modal never goes through App.render().
  function handleChange(kind, ds, value, el) {
    if (kind === 'timetable-campus-change') {
      const root = App.Modal.getRoot();
      if (!root) return;
      const campus = O.getCampusByName(value);
      const venueInput = root.querySelector('#tt-venue-input');
      if (venueInput && campus) venueInput.setAttribute('list', `tt-venue-datalist-${campus.id}`);
      const chipRow = root.querySelector('#tt-venue-chip-row');
      if (chipRow) {
        const chips = campus ? O.Providers.Places.suggestedSearches(campus, 6) : [];
        chipRow.innerHTML = chips.map((v) => `<button type="button" class="chip" data-action="timetable-fill-field" data-field="venue" data-value="${U.escapeHtml(v)}">${U.escapeHtml(v)}</button>`).join('');
        if (window.lucide) lucide.createIcons({ context: chipRow });
      }
      return;
    }
    if (kind === 'timetable-date-change') {
      const root = App.Modal.getRoot();
      if (!root || !value) return;
      // Only nudges the day checkboxes when NONE are checked yet, so it
      // never silently overrides a deliberate multi-day selection the
      // student already made.
      const anyChecked = [...root.querySelectorAll('input[name="repeat_days"]')].some((cb) => cb.checked);
      if (anyChecked) return;
      const dow = new Date(value + 'T00:00:00').getDay();
      const cb = root.querySelector(`#tt-day-cb-${dow}`);
      if (cb) cb.checked = true;
    }
  }

  return {
    render, handleAction, handleChange, handleSubmit, nextClassCard, directionsButton, getDirections, stopTicking,
  };
})();
