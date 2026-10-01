/* ============================================================
   CLICKFUD — My Timetable: data layer

   CRUD against public.timetable_entries plus the pure date/time logic
   for "what's my next class" / "am I in a class right now". A class is
   a WEEKLY RECURRING slot (day_of_week) unless specific_date is set,
   in which case it's a one-off occurrence on that exact date only.

   This is the same logic, independently, that the server-side 10-
   minute reminder uses (see supabase/functions/timetable-reminder-
   check and claim_due_timetable_reminders() — migration_governance.sql
   section 45) — the reminder's timing and this module's on-screen
   "Starts in N minutes" always agree because both are just reading
   start_time/day_of_week/specific_date off the same rows.
   ============================================================ */
window.App = window.App || {};

App.Timetable = (function () {
  const S = App.Store;
  const U = App.Utils;

  function validate(payload) {
    if (!payload.module || !U.sanitizeText(payload.module)) return 'Module/Subject is required.';
    if (!payload.class_type || !U.sanitizeText(payload.class_type)) return 'Class type/name is required.';
    if (payload.day_of_week === undefined || payload.day_of_week === null || payload.day_of_week === '') return 'Please select a day.';
    const dow = Number(payload.day_of_week);
    if (!Number.isInteger(dow) || dow < 0 || dow > 6) return 'Please select a valid day.';
    if (!payload.start_time) return 'Start time is required.';
    if (!payload.end_time) return 'End time is required.';
    if (!/^\d{2}:\d{2}$/.test(payload.start_time) || !/^\d{2}:\d{2}$/.test(payload.end_time)) return 'Please enter valid start and end times.';
    if (payload.end_time <= payload.start_time) return 'End time must be after start time.';
    if (!payload.campus || !App.Orientation.getCampusByName(payload.campus)) return 'Please select a valid campus.';
    // Venue is always free text, deliberately never checked against the
    // campus venue database (App.Orientation.Providers.Places) — that
    // dataset is only ever a suggestion/autocomplete source (see
    // venueSuggestions below); a student's real class venue ("My
    // Residence Common Room", a venue not yet in the database, etc.)
    // must always be saveable as-is.
    if (!payload.venue || !U.sanitizeText(payload.venue)) return 'Venue is required.';
    return null;
  }

  function cleanPayload(payload) {
    return {
      module: U.sanitizeText(payload.module, 120),
      module_code: payload.module_code ? U.sanitizeText(payload.module_code, 30) : null,
      class_type: U.sanitizeText(payload.class_type, 60),
      day_of_week: Number(payload.day_of_week),
      specific_date: payload.specific_date ? payload.specific_date : null,
      start_time: payload.start_time,
      end_time: payload.end_time,
      campus: payload.campus,
      venue: U.sanitizeText(payload.venue, 120),
      lecturer: payload.lecturer ? U.sanitizeText(payload.lecturer, 100) : null,
      notes: payload.notes ? U.sanitizeText(payload.notes, 300) : null,
    };
  }

  // ---------------- Venue suggestions (campus venue database) ----------------
  // Thin wrapper around the exact same dataset My Orientation's own
  // destination search already uses (App.Orientation.Providers.Places)
  // — never a second venue list. Purely a suggestion source:
  // validate()/cleanPayload() above never require a match here, so a
  // venue that doesn't exist in this list is always still savable. The
  // Venue field's own as-you-type filtering is a native <datalist>
  // (see js/pages/timetable.js and allVenueNames below it reads from) —
  // this is just the short quick-fill chip list shown before typing.
  function venueSuggestions(campusName) {
    const campus = App.Orientation.getCampusByName(campusName);
    if (!campus) return [];
    return App.Orientation.Providers.Places.suggestedSearches(campus, 6);
  }
  function allVenueNames(campusName) {
    const campus = App.Orientation.getCampusByName(campusName);
    if (!campus) return [];
    return App.Orientation.Providers.Places.allVenueNames(campus);
  }

  // ---------------- Recurrence expansion (fast multi-day entry) ----------------
  // The table itself only ever models ONE of two shapes per row: a
  // plain weekly-recurring slot (day_of_week set, specific_date null —
  // recurs forever, exactly like every class already in this system)
  // or a single dated occurrence (specific_date set). There's no native
  // "every 2 weeks" concept at the DB/reminder-cron level, so rather
  // than changing that shared, live cron logic, "Every 2 weeks"/
  // "Custom" is expanded HERE, client-side, into a bounded batch of
  // concrete dated rows up front — each one is then just a completely
  // ordinary one-off entry that editing, deleting, Get Directions and
  // the reminder cron already all handle with zero further changes.
  const MAX_GENERATED_OCCURRENCES = 26; // ~half a year per selected day — a safety cap on batch size, not a limit on what a student can plan; add more later the same way any class is added

  function toISODate(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  // base: the common fields for every generated row (module, module_code,
  // class_type, start_time, end_time, campus, venue, lecturer, notes) —
  // day_of_week/specific_date are computed here, never passed in.
  // anchorDate: 'YYYY-MM-DD', the specific date the student actually
  // picked in the form — always required, even for a plain weekly-
  // forever class, so its day-of-week can be derived rather than asked
  // for twice.
  // recurrence: { type: 'none'|'weekly'|'biweekly'|'custom', days: [0-6,...], intervalWeeks, until: 'YYYY-MM-DD' }
  function expandRecurrence(base, anchorDate, recurrence) {
    const anchor = new Date(anchorDate + 'T00:00:00');
    const anchorDow = anchor.getDay();
    const type = (recurrence && recurrence.type) || 'none';

    if (type === 'none') {
      return [{ ...base, day_of_week: anchorDow, specific_date: anchorDate }];
    }
    if (type === 'weekly') {
      const days = (recurrence.days && recurrence.days.length) ? recurrence.days : [anchorDow];
      // Weekly-forever — the same model every existing class already
      // uses, so it keeps recurring indefinitely with zero extra rows.
      return days.map((dow) => ({ ...base, day_of_week: dow, specific_date: null }));
    }
    // biweekly / custom
    const intervalWeeks = type === 'biweekly' ? 2 : Math.max(1, Number(recurrence.intervalWeeks) || 1);
    const days = (recurrence.days && recurrence.days.length) ? recurrence.days : [anchorDow];
    const until = recurrence.until ? new Date(recurrence.until + 'T00:00:00') : null;
    const out = [];
    days.forEach((dow) => {
      let d = new Date(anchor);
      d.setDate(d.getDate() + ((dow - d.getDay() + 7) % 7));
      let count = 0;
      while (count < MAX_GENERATED_OCCURRENCES && (!until || d <= until)) {
        out.push({ ...base, day_of_week: dow, specific_date: toISODate(d) });
        d = new Date(d);
        d.setDate(d.getDate() + intervalWeeks * 7);
        count++;
      }
    });
    return out;
  }

  async function fetchAll() {
    if (!S.state.profile || S.state.profile.role !== 'customer') return;
    const userId = S.state.profile.id;
    const { data, error } = await App.sb.from('timetable_entries').select('*').order('day_of_week').order('start_time');
    if (error) {
      console.error(error);
      // Offline: fall back to this customer's own last-loaded timetable
      // (read-only — adding/editing classes still needs a connection).
      if (App.Connectivity.isNetworkError(error) && !S.state.timetable.length) {
        const cached = await App.OfflineCache.loadTimetable(userId);
        if (cached && S.state.profile && S.state.profile.id === userId) S.set({ timetable: cached.data || [] });
      }
      return;
    }
    S.set({ timetable: data || [] });
    App.OfflineCache.saveTimetable(userId, data || []);
  }

  async function create(payload) {
    const err = validate(payload);
    if (err) return { error: err };
    if (!S.state.profile) return { error: 'Please sign in first.' };
    const clean = cleanPayload(payload);
    clean.student_id = S.state.profile.id;
    const { data, error } = await App.sb.from('timetable_entries').insert(clean).select().single();
    if (error) return { error: error.message };
    S.upsertIn('timetable', data);
    return { data };
  }

  // Bulk insert — one round trip for "recurring on several days" or an
  // expanded biweekly/custom batch, instead of one create() call per
  // row. Validates every row up front; if any one is invalid, nothing
  // is inserted (matches create()'s all-or-nothing single-row contract).
  async function createMany(payloads) {
    if (!payloads || !payloads.length) return { data: [] };
    if (!S.state.profile) return { error: 'Please sign in first.' };
    const cleaned = [];
    for (const payload of payloads) {
      const err = validate(payload);
      if (err) return { error: err };
      const clean = cleanPayload(payload);
      clean.student_id = S.state.profile.id;
      cleaned.push(clean);
    }
    const { data, error } = await App.sb.from('timetable_entries').insert(cleaned).select();
    if (error) return { error: error.message };
    (data || []).forEach((row) => S.upsertIn('timetable', row));
    return { data };
  }

  async function update(id, payload) {
    const err = validate(payload);
    if (err) return { error: err };
    const clean = cleanPayload(payload);
    const { data, error } = await App.sb.from('timetable_entries').update(clean).eq('id', id).select().single();
    if (error) return { error: error.message };
    S.upsertIn('timetable', data);
    return { data };
  }

  // Deleting the row is the whole cancellation mechanism for its
  // reminder too — timetable_reminders_sent has ON DELETE CASCADE, and
  // the reminder cron only ever looks at rows that still exist, so a
  // deleted class simply stops being found on the very next tick.
  // ---------------- Sharing with friends (supabase/timetable_sharing.sql) ----------------
  // A share is a SNAPSHOT of the owner's classes (no personal notes) behind
  // an unguessable id; accepting COPIES them into the friend's own
  // timetable_entries. RLS on timetable_entries is untouched — nobody can
  // read anyone else's timetable, only what was deliberately shared.
  function rpcError(error, fallback) {
    const msg = (error && error.message) || '';
    return /empty|sign in|expired|no longer|own timetable|many times/i.test(msg) ? msg : fallback;
  }
  async function createShare() {
    const { data, error } = await App.sb.rpc('create_timetable_share');
    if (error) return { error: rpcError(error, "Couldn't create a share link. Please try again.") };
    return { id: data };
  }
  async function getShare(id) {
    const { data, error } = await App.sb.rpc('get_timetable_share', { p_id: id });
    if (error) return { error: "Couldn't open this timetable link. Please check your connection." };
    return { share: data }; // null = expired / revoked / unknown
  }
  async function acceptShare(id, mode) {
    const { data, error } = await App.sb.rpc('accept_timetable_share', { p_id: id, p_mode: mode });
    if (error) return { error: rpcError(error, "Couldn't add this timetable. Please try again.") };
    await fetchAll();
    return { added: data };
  }

  async function remove(id) {
    const { error } = await App.sb.from('timetable_entries').delete().eq('id', id);
    if (error) return { error: error.message };
    S.removeFrom('timetable', id);
    return { ok: true };
  }

  // ---------------- Occurrence / next-class math ----------------
  function parseHM(t) { const [h, m] = String(t).slice(0, 5).split(':').map(Number); return { h, m }; }
  function atTime(dateBase, h, m) { const d = new Date(dateBase); d.setHours(h, m, 0, 0); return d; }

  // Returns { occurrenceDate, start, end } for this entry's next
  // occurrence at/after `now`, or null if it has none left (a one-off
  // specific_date entry whose end_time has already passed).
  function nextOccurrenceInfo(entry, now) {
    now = now || new Date();
    const s = parseHM(entry.start_time);
    const e = parseHM(entry.end_time);

    if (entry.specific_date) {
      const dateBase = new Date(entry.specific_date + 'T00:00:00');
      const end = atTime(dateBase, e.h, e.m);
      if (end <= now) return null;
      return { occurrenceDate: dateBase, start: atTime(dateBase, s.h, s.m), end };
    }

    const todayStart = new Date(now); todayStart.setHours(0, 0, 0, 0);
    const daysUntil = (Number(entry.day_of_week) - now.getDay() + 7) % 7;
    let candidateDate = new Date(todayStart); candidateDate.setDate(candidateDate.getDate() + daysUntil);
    let end = atTime(candidateDate, e.h, e.m);
    if (daysUntil === 0 && end <= now) {
      candidateDate = new Date(candidateDate); candidateDate.setDate(candidateDate.getDate() + 7);
      end = atTime(candidateDate, e.h, e.m);
    }
    return { occurrenceDate: candidateDate, start: atTime(candidateDate, s.h, s.m), end };
  }

  function classStatusNow(entry, now) {
    const occ = nextOccurrenceInfo(entry, now);
    if (!occ) return null;
    const status = (now >= occ.start && now < occ.end) ? 'current' : 'upcoming';
    return { entry, status, ...occ };
  }

  // A currently-in-progress class always wins outright; otherwise the
  // soonest-starting upcoming one. Returns null if there are no classes
  // at all (or none with any occurrence left).
  function nextOrCurrentClass(entries, now) {
    now = now || new Date();
    let best = null;
    for (const entry of entries || []) {
      const info = classStatusNow(entry, now);
      if (!info) continue;
      if (info.status === 'current') return info;
      if (!best || info.start < best.start) best = info;
    }
    return best;
  }

  function todaysClasses(entries, now) {
    now = now || new Date();
    return (entries || [])
      .map((entry) => classStatusNow(entry, now))
      .filter((info) => info && info.occurrenceDate.toDateString() === now.toDateString())
      .sort((a, b) => a.start - b.start);
  }

  function minutesUntil(date, now) {
    now = now || new Date();
    return Math.round((date.getTime() - now.getTime()) / 60000);
  }

  // A class is a WEEKLY RECURRING slot, so its "next occurrence" can be
  // up to 6 days away — showing that as a raw minute count ("Starts in
  // 3331 minutes") is meaningless. This picks the same relative format a
  // calendar app would: an imminent class gets a countdown, anything
  // further out gets a day + time instead.
  function formatUpcoming(info, now) {
    now = now || new Date();
    const mins = minutesUntil(info.start, now);
    if (mins <= 0) return 'Starting now';
    if (mins <= 60) return `Starts in ${mins} min`;
    const time = App.Utils.formatTime(info.start);
    const startDay = new Date(info.start); startDay.setHours(0, 0, 0, 0);
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const daysAhead = Math.round((startDay - today) / (24 * 3600 * 1000));
    if (daysAhead === 0) return `Today · ${time}`;
    if (daysAhead === 1) return `Tomorrow · ${time}`;
    return `${App.CONST.DAYS[info.start.getDay()]} · ${time}`;
  }

  return {
    validate, fetchAll, create, createMany, update, remove,
    createShare, getShare, acceptShare,
    venueSuggestions, allVenueNames, expandRecurrence, toISODate,
    nextOccurrenceInfo, classStatusNow, nextOrCurrentClass, todaysClasses, minutesUntil, formatUpcoming,
  };
})();
