/**
 * Calendar Blocker Sync
 *
 * For every busy event in the hub calendar (D ONE) within the next N days,
 * sends an opaque "Blocked" invite to each configured client address that is
 * NOT already a participant of that event. Blockers live on a secondary
 * calendar and carry exactly one guest, so clients never see each other.
 *
 * Requires: Apps Script Advanced Service "Google Calendar API" (identifier: Calendar).
 *
 * Entry points:
 *   createBlockerCalendar()  one-off: creates the secondary calendar, logs its ID
 *   reconcile()              one sync pass (respects CONFIG.dryRun)
 *   install()                installs the 15-min timer + on-calendar-change triggers
 *   uninstall()              removes all triggers of this project
 *   purgeBlockers()          deletes all future blockers (sends cancellations)
 */

// Configuration lives in Config.gs (global CONFIG).

const TAG = 'calsync';
const SKIP_EVENT_TYPES = ['workingLocation', 'birthday'];

// ---------------------------------------------------------------- main

function reconcile() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30 * 1000)) {
    console.log('Another run in progress; skipping.');
    return;
  }
  try {
    validateConfig_();
    const now = new Date();
    const windowEnd = new Date(now.getTime() + CONFIG.windowDays * 86400000);

    const desired = buildDesired_(now, windowEnd);
    const existing = loadExisting_(now);
    const stats = { created: 0, updated: 0, deleted: 0, unchanged: 0 };

    desired.forEach((want, key) => {
      const have = existing.get(key) || [];
      existing.delete(key);
      if (have.length === 0) {
        createBlocker_(want); stats.created++;
        return;
      }
      const [keep, ...dupes] = have;
      dupes.forEach(d => { deleteBlocker_(d, 'duplicate'); stats.deleted++; });
      if (guestOf_(keep) !== want.email) {
        deleteBlocker_(keep, 'guest changed'); stats.deleted++;
        createBlocker_(want); stats.created++;
      } else if (sameTime_(keep, want)) {
        stats.unchanged++;
      } else {
        patchBlocker_(keep, want); stats.updated++;
      }
    });

    // Remaining blockers have no source in the window anymore.
    existing.forEach(list => list.forEach(b => { deleteBlocker_(b, 'source gone'); stats.deleted++; }));

    console.log(`${CONFIG.dryRun ? '[DRY RUN] ' : ''}created=${stats.created} ` +
      `updated=${stats.updated} deleted=${stats.deleted} unchanged=${stats.unchanged}`);
    return stats;
  } finally {
    lock.releaseLock();
  }
}

// ---------------------------------------------------------------- desired state

function buildDesired_(timeMin, timeMax) {
  const clients = Object.entries(CONFIG.clients).map(([k, v]) => [k, v.toLowerCase()]);
  const desired = new Map();
  listAll_(CONFIG.hubCalendarId, {
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    singleEvents: true,
  })
    .filter(isBlocking_)
    .forEach(ev => {
      const present = participants_(ev);
      clients.forEach(([client, email]) => {
        if (present.has(email)) return;
        desired.set(`${ev.id}|${client}`, {
          sourceId: ev.id, client, email,
          start: timeOf_(ev.start), end: timeOf_(ev.end),
        });
      });
    });
  return desired;
}

function isBlocking_(ev) {
  if (ev.status === 'cancelled') return false;
  if (ev.transparency === 'transparent') return false;           // marked "Free"
  if (SKIP_EVENT_TYPES.includes(ev.eventType)) return false;
  if (!ev.start || !ev.end) return false;
  if (ev.start.date && !CONFIG.includeAllDay) return false;
  if (ev.start.date && isIgnoredAllDay_(ev.summary)) return false;   // e.g. room bookings
  const priv = ev.extendedProperties && ev.extendedProperties.private;
  if (priv && priv[TAG]) return false;                           // never mirror a blocker
  const me = (ev.attendees || []).find(a => a.self);
  if (me && me.responseStatus === 'declined') return false;
  return true;
}

function isIgnoredAllDay_(summary) {
  const title = (summary || '').trim();
  return (CONFIG.ignoreAllDayPrefixes || []).some(p => title.startsWith(p));
}

function participants_(ev) {
  const set = new Set((ev.attendees || []).map(a => (a.email || '').toLowerCase()));
  if (ev.organizer && ev.organizer.email) set.add(ev.organizer.email.toLowerCase());
  return set;
}

// ---------------------------------------------------------------- current state

function loadExisting_(timeMin) {
  const map = new Map();
  listAll_(CONFIG.blockerCalendarId, {
    timeMin: timeMin.toISOString(),          // blockers ending in the past are never touched
    singleEvents: true,
    privateExtendedProperty: `${TAG}=1`,
  })
    .filter(b => b.status !== 'cancelled')
    .forEach(b => {
      const p = b.extendedProperties.private;
      const key = `${p.src}|${p.client}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(b);
    });
  return map;
}

function listAll_(calendarId, params) {
  const out = [];
  let pageToken = null;
  do {
    const query = Object.assign({ maxResults: 2500 }, params);
    if (pageToken) query.pageToken = pageToken;
    const res = Calendar.Events.list(calendarId, query);
    (res.items || []).forEach(i => out.push(i));
    pageToken = res.nextPageToken;
  } while (pageToken);
  return out;
}

// ---------------------------------------------------------------- writes

function createBlocker_(want) {
  log_('CREATE', want.client, want.start, want.end);
  if (CONFIG.dryRun) return;
  Calendar.Events.insert({
    summary: CONFIG.blockerTitle,
    start: want.start,
    end: want.end,
    attendees: [{ email: want.email }],
    transparency: 'opaque',
    visibility: 'private',
    guestsCanSeeOtherGuests: false,
    guestsCanInviteOthers: false,
    guestsCanModify: false,
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: { private: { [TAG]: '1', src: want.sourceId, client: want.client } },
  }, CONFIG.blockerCalendarId, { sendUpdates: 'all' });
  Utilities.sleep(250);
}

function patchBlocker_(blocker, want) {
  log_('UPDATE', want.client, want.start, want.end);
  if (CONFIG.dryRun) return;
  Calendar.Events.patch({
    start: patchTime_(want.start),
    end: patchTime_(want.end),
  }, CONFIG.blockerCalendarId, blocker.id, { sendUpdates: 'all' });
  Utilities.sleep(250);
}

function deleteBlocker_(blocker, reason) {
  const p = blocker.extendedProperties.private;
  log_(`DELETE (${reason})`, p.client, blocker.start, blocker.end);
  if (CONFIG.dryRun) return;
  Calendar.Events.remove(CONFIG.blockerCalendarId, blocker.id, { sendUpdates: 'all' });
  Utilities.sleep(250);
}

// ---------------------------------------------------------------- helpers

function timeOf_(t) {
  return t.date ? { date: t.date } : { dateTime: t.dateTime, timeZone: t.timeZone };
}

function patchTime_(t) {
  // Explicit nulls allow switching between all-day and timed via patch.
  return t.date
    ? { date: t.date, dateTime: null, timeZone: null }
    : { date: null, dateTime: t.dateTime, timeZone: t.timeZone || null };
}

function norm_(t) {
  return t.date ? `d:${t.date}` : `t:${new Date(t.dateTime).getTime()}`;
}

function sameTime_(blocker, want) {
  return norm_(blocker.start) === norm_(want.start) && norm_(blocker.end) === norm_(want.end);
}

function guestOf_(blocker) {
  const a = (blocker.attendees || [])[0];
  return a ? a.email.toLowerCase() : '';
}

function fmt_(t) {
  return t.date || t.dateTime;
}

function log_(action, client, start, end) {
  console.log(`${CONFIG.dryRun ? '[DRY RUN] ' : ''}${action} ${client} ${fmt_(start)} -> ${fmt_(end)}`);
}

function validateConfig_() {
  if (/REPLACE_ME/.test(CONFIG.blockerCalendarId)) {
    throw new Error('Set CONFIG.blockerCalendarId (run createBlockerCalendar() first).');
  }
  if (CONFIG.blockerCalendarId === CONFIG.hubCalendarId) {
    throw new Error('Blocker calendar must differ from hub calendar.');
  }
  const emails = Object.values(CONFIG.clients);
  if (emails.length < 1) throw new Error('Configure at least one client address.');
  emails.forEach(e => {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error(`Invalid client address: ${e}`);
  });
  if (![1, 5, 10, 15, 30].includes(CONFIG.syncIntervalMinutes)) {
    throw new Error('syncIntervalMinutes must be 1, 5, 10, 15 or 30.');
  }
}

// ---------------------------------------------------------------- setup

function createBlockerCalendar() {
  const cal = CalendarApp.createCalendar(CONFIG.blockerCalendarName, { selected: false });
  console.log(`Created calendar. Set CONFIG.blockerCalendarId = '${cal.getId()}'`);
}

function install() {
  validateConfig_();
  uninstall();
  ScriptApp.newTrigger('reconcile').timeBased().everyMinutes(CONFIG.syncIntervalMinutes).create();
  const hub = CONFIG.hubCalendarId === 'primary'
    ? Session.getEffectiveUser().getEmail()
    : CONFIG.hubCalendarId;
  ScriptApp.newTrigger('reconcile').forUserCalendar(hub).onEventUpdated().create();
  console.log(`Installed: every ${CONFIG.syncIntervalMinutes} min + on change of ${hub}.`);
}

function uninstall() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  console.log('All triggers removed.');
}

function purgeBlockers() {
  const existing = loadExisting_(new Date());
  let n = 0;
  existing.forEach(list => list.forEach(b => { deleteBlocker_(b, 'purge'); n++; }));
  console.log(`${CONFIG.dryRun ? '[DRY RUN] ' : ''}Purged ${n} blockers.`);
}
