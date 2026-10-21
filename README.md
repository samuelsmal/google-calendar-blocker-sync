# Calendar Blocker Sync

Google Apps Script that mirrors busy time from the D ONE Google Calendar into client calendars as anonymous **"Blocked"** invites. No client learns which other clients exist.

It is a helper, not a full sync. Client meetings reach the D ONE calendar only when `sam@d-one` is added to them.

## How it works

```
D ONE calendar (hub, primary)
   │  busy events, next 7 days
   ▼
Apps Script: reconcile()  ── every 15 min + on every calendar change
   │  one blocker per (event × client not already invited)
   ▼
Secondary calendar "Sam"  ── organizer of all blockers
   │  each blocker has exactly ONE guest
   ▼
sam@clientA   sam@clientB   …
```

Each run is a full reconcile, not an append:

| Hub event | Effect on blocker |
|---|---|
| New busy event | Create (sends invite) |
| Time changed | Patch (sends update) |
| Cancelled, declined, deleted or marked *Free* | Delete (sends cancellation) |
| Unchanged | Nothing (no email) |
| Already ended | Never touched |

## Rules

An event in the hub calendar produces a blocker for client X if all of the following hold:

- it is in the window (`now` → `now + windowDays`),
- its status is not cancelled and it is not marked *Free*,
- you have not declined it,
- it is not a working-location or birthday entry,
- it is not all-day, unless `includeAllDay: true`,
- if all-day, its title does not start with a prefix in `ignoreAllDayPrefixes` (room bookings),
- client X's address is neither an attendee nor the organizer.

## Confidentiality properties

- **One guest per blocker.** Client A never sees client B's address.
- **Fixed content.** The title is `Blocked [sync]`. There is no description, location, Meet link or reminder.
- **Opaque organizer.** The organizer is the secondary calendar (`…@group.calendar.google.com`), displayed as `Sam`.
- **Residual exposure.** Time slots and the time zone remain visible to each client.

## Files

| File | Content |
|---|---|
| `Config.gs` | All settings. Keep it when updating. |
| `Code.gs` | Logic. Replace it to update. |

## Setup

1. **Project.** On script.google.com (D ONE account), create a *New project*. Add the script files `Config` and `Code` and paste in the contents.
2. **API.** *Services* → **+** → *Google Calendar API*. The identifier must stay `Calendar`.
3. **Blocker calendar.** Run `createBlockerCalendar` and authorize. Copy the logged ID into `CONFIG.blockerCalendarId`.
4. **Clients.** Fill `CONFIG.clients`. One entry is enough.
5. **Dry run.** With `dryRun: true`, run `reconcile`. The *Executions* log lists the planned `CREATE` lines and totals.
6. **Live test.** Set `dryRun: false`, create a test event for tomorrow and run `reconcile`. In the client mailbox, check that:
   - the invite arrives and is not quarantined,
   - a tentative entry appears,
   - the organizer shows as `Sam`.

   Then move the event and run again (update), and delete it and run again (cancellation).
7. **Activate.** Run `install`.

## Outlook (per client mailbox)

- **Rule:** subject contains `Blocked [sync]` → move to folder `Calendar sync`, optionally mark as read.
- **Tentative entries.** Exchange normally adds the invite to the calendar as *Tentative* even after the email has been moved. Verify this once per tenant.
- **Acceptance.** Blockers stay *Tentative* unless you accept them manually. Selective auto-accept is not available in new Outlook or OWA.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `hubCalendarId` | `'primary'` | Source calendar |
| `blockerCalendarId` | — | Secondary calendar that owns the blockers |
| `blockerCalendarName` | `'Sam'` | Name used by `createBlockerCalendar`. Shown to clients as the organizer. |
| `clients` | — | `{ key: 'sam@client.tld' }`. Keys are internal labels. |
| `windowDays` | `7` | Look-ahead window |
| `blockerTitle` | `'Blocked [sync]'` | Invite title. Outlook rules match on it. |
| `includeAllDay` | `false` | Mirror all-day events |
| `ignoreAllDayPrefixes` | `['Booking']` | All-day titles to skip. Case-sensitive. |
| `syncIntervalMinutes` | `15` | Timer interval: 1, 5, 10, 15 or 30 |
| `dryRun` | `true` | Log only, send nothing |

## Operations

| Task | Action |
|---|---|
| Pause | Run `uninstall` |
| Resume | Run `install` |
| Remove all future blockers | Run `purgeBlockers` (sends cancellations; respects `dryRun`) |
| Add a client | Edit `clients`. The next run sends blockers for the window. |
| Remove a client | Edit `clients`. The next run cancels that client's future blockers. |
| Inspect | *Executions* in the Apps Script editor. Logs contain client keys and times only. |

## Limitations

- **Inbound is manual.** Client meetings without `sam@d-one` are invisible to the script.
- **Late blockers.** Events beyond `windowDays` get blockers only once they enter the window.
- **Title changes.** Changing `blockerTitle` affects new blockers only. Update the Outlook rules at the same time.
- **Email per change.** Every create, update and delete sends an email to the client address.
- **Recurring events.** These are mirrored instance by instance, not as a recurrence rule.
