# Relay

> A full-stack event check-in and follow-up platform for churches running outdoor crusades, revivals, and community events. Built on Planning Center Online. Every person, every step.

**Live demo:** [fcstaff.claupc.org](https://fcstaff.claupc.org) — first deployed at Jesus is Lord Freedom Crusade, June 2026

---

## Overview

Relay handles the full lifecycle of a church event attendee — from badge printing and check-in, through milestone recording, to post-event volunteer follow-up and campus referral.

Built in a single intensive development session and deployed live to production. Replaced a manual paper-based process and gave CLA's staff team real-time visibility into every decision, tracked directly in Planning Center Online.

---

## Screenshots

> *Screenshots coming — add your own from the event here*

| Staff Guide | Badge Scanner | Walk-ins Tab |
|---|---|---|
| ![Guide](screenshots/guide.png) | ![Scanner](screenshots/scanner.png) | ![Walkins](screenshots/walkins.png) |

| Follow-up Modal | Dashboard | System Status |
|---|---|---|
| ![Followup](screenshots/followup.png) | ![Dashboard](screenshots/dashboard.png) | ![Status](screenshots/status.png) |

---

## Features

### Check-in System
- **FC badges** — pre-registered attendees get QR-coded badges printed in advance; scan and their Planning Center profile loads instantly
- **WI badges** — walk-in attendees receive a blank numbered badge; volunteers register them on the spot in under 30 seconds
- **Camera QR scanning** — native camera integration on iOS and Android for instant badge lookup
- **Search-first flow** — volunteers are prompted to search Planning Center before creating new records, preventing duplicates

### Planning Center Integration
- Real-time read/write via Planning Center People API v2
- Milestone notes written directly to PCO with recorder attribution: `[Logan] [MILESTONE:BAPTIZED] Jane Smith — Baptized in Jesus Name`
- Walk-in creation notes: `[Logan] Walk-in registration — Jesus is Lord Freedom Crusade 2026`
- Phone and email updates sync to PCO profiles in real time
- Campus assignment writes to PCO `primary_campus` field
- Form submission linking for walk-ins

### Milestone Tracking
Three one-tap milestone buttons on every attendee profile:
- 💧 Baptized
- 🔥 Filled with the Holy Ghost
- 📖 Requested Bible Study

All milestones save instantly to Planning Center under a dedicated note category.

### Follow-up System
Built entirely outside Planning Center to give volunteers full ownership:
- **Assignment** — leaders assign milestone holders to specific volunteers
- **Campus referral** — out-of-area attendees routed to the nearest CLA campus (Auburn, Geneva, Morrisville, North Syracuse, Oneida, Syracuse) — synced to PCO
- **Contact logging** — every attempt logged with method (call/text/visit), outcome, and notes
- **Status tracking** — Unassigned → Assigned → In Progress → Completed
- **Household data** — family members pulled from PCO and displayed on follow-up card
- **Notification badge** — red count badge on Follow-up tab showing unassigned people

### Volunteer Management
- Phone-number-based profiles prevent duplicates across devices
- Auto-registration — opening the Follow-up tab registers the current user as a volunteer automatically
- Session recovery — if cookies clear, entering the same phone number restores the profile
- Name-confirmation delete — removing a volunteer requires typing their exact name

### Data & Security
- **Azure Table Storage** — badge map, offline captures, follow-ups, contact log, volunteers, and audit log all persist in Azure's managed NoSQL storage, surviving container restarts and redeployments
- **Append-only audit log** — every assignment, status change, and contact attempt is permanently recorded with before/after values and attribution
- **Active session tracking** — system status page shows logged-in users with real IPs (via Cloudflare `CF-Connecting-IP`)
- **Badge protection** — FC badges cannot be assigned to walk-ins; duplicate WI assignment returns the assigned person's name and instructs the volunteer to grab a new badge
- **Rate-limited auth** — 10 login attempts per 15 minutes
- **Cloudflare proxy** — all traffic through Cloudflare with Full SSL mode

### Print System
- FC badge sheet generation — QR codes auto-assigned from form submissions, printed as a 3-column grid
- WI badge sheet — configurable start number and count, 5-column print layout, auto-scales to US Letter
- Print button disabled during QR generation to prevent blank sheets

### Staff-Facing Pages
- **`/`** — CLA-branded staff guide and training page with full event schedule
- **`/scanner`** — the badge scanner app (6 tabs: Scan, Attendees, Walk-ins, Dashboard, Schedule, Follow-up)
- **`/status`** — system diagnostic page: PCO connection health, Azure Storage health, active users with IPs, and live audit log

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Runtime** | Node.js 22 / Express |
| **Frontend** | Vanilla JS, HTML/CSS (no framework) |
| **Database** | Azure Table Storage (`@azure/data-tables`) |
| **Auth** | express-session + shared password + rate limiting |
| **External API** | Planning Center People API v2 (Personal Access Token) |
| **QR Codes** | jsQR (scanning) + qrcode.js (generation) |
| **Hosting** | Azure App Service B1 |
| **DNS / SSL** | Cloudflare (Full SSL, proxied) |
| **Domain** | claupc.org |

---

## Architecture

```
Browser (PWA)
    │
    ├── Cloudflare (SSL termination, real IP via CF-Connecting-IP)
    │
    └── Azure App Service B1 (Node/Express)
            │
            ├── Planning Center API v2
            │     └── People, Forms, Notes, Emails, Phones,
            │         Campuses, Household Memberships
            │
            └── Azure Table Storage
                  ├── badges         (badge → PCO person ID map)
                  ├── offline        (captures pending PCO sync)
                  ├── followups      (follow-up records with campus/assignment)
                  ├── contactlog     (append-only contact attempt history)
                  ├── auditlog       (append-only change history)
                  └── volunteers     (staff roster with phone dedup)
```

---

## Azure Table Storage Schema

### `badges`
| Field | Description |
|---|---|
| `partitionKey` | `"badge"` |
| `rowKey` | Badge ID (e.g. `WI-014`, `FC-003`) |
| `personId` | Planning Center person ID |

### `followups`
| Field | Description |
|---|---|
| `rowKey` | PCO person ID |
| `name`, `phone`, `email` | Contact info (syncs to PCO) |
| `family` | JSON array of household members |
| `milestones` | JSON array (`["baptized", "holyghost"]`) |
| `assigned_to`, `assigned_to_id` | Volunteer assignment |
| `campus_id`, `campus_name` | PCO campus referral |
| `status` | `unassigned` / `assigned` / `in_progress` / `completed` |

### `auditlog`
| Field | Description |
|---|---|
| `partitionKey` | Entity type (e.g. `"followup"`) |
| `rowKey` | Timestamp + random suffix (append-only) |
| `action` | `assignment_changed`, `status_changed`, `contact_logged`, etc. |
| `changed_by` | Volunteer name |
| `before`, `after` | JSON snapshots |

---

## Planning Center API Endpoints Used

```
GET    /people/v2                                    Health check
GET    /people/v2/people?where[search_name_or_email] Name search
GET    /people/v2/people/:id                         Person details
GET    /people/v2/people/:id/notes                   Milestone notes
POST   /people/v2/people/:id/notes                   Write milestone/creation note
POST   /people/v2/people                             Create walk-in person
POST   /people/v2/people/:id/emails                  Add email
POST   /people/v2/people/:id/phone_numbers           Add phone
PATCH  /people/v2/people/:id/emails/:id              Update email
PATCH  /people/v2/people/:id/phone_numbers/:id       Update phone
PATCH  /people/v2/people/:id                         Assign primary campus
GET    /people/v2/people/:id/household_memberships   Family members
GET    /people/v2/forms/:id/form_submissions         Form registrations
POST   /people/v2/forms/:id/form_submissions         Link person to form
GET    /people/v2/campuses                           Campus list
GET    /people/v2/note_categories                    Note category lookup
```

---

## Key Engineering Decisions

**Why vanilla JS?**
The app is used by non-technical church volunteers on mobile. No build step, no framework overhead, instant load on a B1 instance. The entire frontend is a single `index.html`.

**Why Azure Table Storage over a relational DB?**
For an event tool with a known schema and high read/write frequency, Table Storage is $0.01/month, has no cold start, and the key-value model maps perfectly to badge lookups. The append-only audit log is a natural fit for the partition/row key design.

**Why keep follow-up outside Planning Center?**
PCO's workflow system is powerful but complex for volunteers. Building follow-up in the app gives the pastoral team a purpose-built interface with contact logging, volunteer ownership, and campus routing — all without requiring volunteers to have PCO accounts.

**Why search-first walk-in flow?**
CLA has 6 campuses with years of PCO history. Walk-in attendees at an outdoor crusade are often already in the database from a previous service. Forcing a PCO search before creation prevents the duplicate problem that plagues event check-in at scale.

---

## Event Results

*To be updated after June 19–20, 2026*

- Attendees checked in: —
- Walk-ins registered: —
- Baptized in the crusade event
- Filled with the Holy Ghost
- Requested Bible Study
- Follow-ups assigned: —
- Follow-ups completed: —

---

## Built By

**Logan VanDyke** — [logvan.com](https://logvan.com)

Built for Christian Life Assembly, Syracuse NY.  
Jesus is Lord Freedom Crusade — June 19–20, 2026.

---

## Future Roadmap

- [ ] SMS authentication (Twilio) replacing shared password
- [ ] Multi-event support with configurable form/category IDs
- [ ] Migration from Azure App Service to Railway with GitHub auto-deploy
- [ ] relay.church landing page and product site
- [ ] Export/CSV for post-event follow-up data
- [ ] Per-volunteer email notifications on new assignments
- [ ] PCO Workflow API integration for automated assignment routing
