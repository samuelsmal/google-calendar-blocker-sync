/**
 * Configuration for Calendar Blocker Sync (used by Code.gs).
 * Keep this file when updating Code.gs.
 */
const CONFIG = {
  hubCalendarId: 'primary',
  blockerCalendarId: 'REPLACE_ME@group.calendar.google.com',
  blockerCalendarName: 'Sam',          // shown to clients as organizer name
  clients: {
    clientA: 'sam@clienta.com',
  },
  windowDays: 7,
  blockerTitle: 'Blocked [sync]',      // keep distinctive: Outlook rules match on it
  includeAllDay: false,
  ignoreAllDayPrefixes: ['Booking'],   // all-day events whose title starts with these are never blocked
  syncIntervalMinutes: 15,             // allowed: 1, 5, 10, 15, 30
  dryRun: true,                        // log only; set false to send invites
};
