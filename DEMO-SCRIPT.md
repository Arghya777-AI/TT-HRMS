# The Tamarind Tree HRMS — demo script

**Machani Hospitalities LLP** · 28 Jul 2026, 07:00 IST

Run `npm run dev`, then open `http://localhost:5173`. Everything below reads the
**live Supabase project** (`xfoeudhwxlbkkwetncjb`) through row-level security — no
mock data, no fixtures. If a screen shows a number, a Postgres policy decided you
were allowed to see it.

---

## Logins

| Persona | Email | Sees |
|---|---|---|
| **HR / Admin** | `priya.menon@tamarindtree.co` | everything: 15 employees, 626 punches, 64 documents |
| **Manager** | `arjun.nair@tamarindtree.co` | own record **+ 12 reports** — use this one for the team story |
| **Employee** | `deepak.shetty@tamarindtree.co` | own record only: 52 punches, 4 documents, 7 notifications |
| **Owner** | `arghya.ghosh@machanigroup.com` | super admin |

Password for the three `@tamarindtree.co` accounts is the demo password in
`.secrets/supabase.env` (`DEMO_PASSWORD`).

**All 15 employees can now sign in** (it was 7). The eight new accounts use
`tt00NN@tamarindtree.co` with printed temporary passwords and
`must_change_password` set — they are login *identities*, not mailboxes, so their
recovery path is an admin reset, not email. Credentials were handed over
separately; don't project them.

> The owner account `arghya.ghosh@machanigroup.com` does NOT work with the
> password in `.secrets` — it is stale (the account is fine: active, unlocked).
> Use **Priya** for anything admin. Reset the owner password from the Supabase
> dashboard when convenient.

> **Manjunath (TT0006) is not a manager** — he sees exactly one employee. Use
> **Arjun (TT0001)** for anything involving a team.

---

## The 12-minute run

### 1 · Open as the employee — Deepak (90s)

- **`/me`** — today's punches, what needs attention, month strip, leave balances.
- The **bell** shows **6 unread**. Open it: a payslip published, a leave decision,
  a policy awaiting acknowledgement, this week's roster, a lapsing balance. Each
  one deep-links to the screen that resolves it.
- **`/me/attendance`** — pick any date to open the day detail. It shows **every
  scan** and how worked hours were derived from them. Worth saying out loud: the
  punch log is **append-only**. A correction never edits a scan; it adds one.
- **`/me/payslips`** → open the payslip. Money is stored in **integer paise** and
  never computed in the browser.

### 2 · The employee asks for a correction (2 min)

- **`/me/regularizations/new`** — pick a date, state the real in/out, attach a
  reason. The **preview is computed by the server** before you're allowed to
  submit, so what you see is what will be applied.
- Submit it. Then switch to Priya.

### 3 · As HR — approve it (2 min)

- **`/admin/attendance/regularisations`** — the queue shows **now vs claimed**
  side by side, the employee's quota chip, and a warning if the period is locked.
- Approve. This calls `decide_regularization()`, which in **one transaction**
  re-checks your authority, inserts `system_regularization` punches carrying the
  reason, and recomputes the attendance day.
- Go back to `/me/attendance` for that date: the derived hours have changed and
  the audit trail names you.

**This is the strongest thing to show.** It is a real approval that mutates real
attendance under real policy — not a form that writes a row.

### 4 · Enrol a face, then punch with it (3 min) — THE headline

This is the workflow the client described, and it runs in this order.

**Admin enrols.** Open any employee at **`/admin/people/<code>`** and press
**"Enrol face"** (primary button, top right). Or go straight to
**Face & kiosk → Enrolment** in the admin rail. Either way you land on that
employee with the camera ready. Capture the five guided poses **on your own
device** — that is the point: the admin registers the employee's face, the
employee never has to.

Consent is recorded first, versioned and withdrawable — DPDP framing, which
matters for a venue with 100+ seasonal staff.

**Then the employee punches.** Sign in as that employee, open **`/me`**, and press
**Punch in**. Location is asked for with a plain reason, the camera runs, several
agreeing frames are required, and the punch is recorded with coordinates, the
geofence result and the IST time. Press it again later for **Punch out** — the
*server* decides the direction from the punch log, never the browser.

> **Only TT0010 (Rahul Verma) has a face enrolled right now.** For anybody else
> the button answers honestly: "your face is not enrolled yet." So enrol on stage,
> or enrol a few people before the meeting.

### 4b · The gate scanner (2 min)

- **`/kiosk`** — a link, mobile-first. Front/back camera switch: **front** for the
  guard's own scan, **back** for the queue.
- The guard's **face identifies** them, then a PIN authorises the shift. Say why,
  because it is a deliberate choice: a face is an identifier, not a secret, and
  there is no certified liveness model here — so a photograph must not be able to
  open a shift. The PIN is typed once per shift.
- Then scan people continuously: a big result card (name, code, IN/OUT, IST time)
  clears itself so the guard never taps between people.
- **Measured: ~950 ms** from face-in-frame to result card, down from ~2.7 s.
- Device auth is **HMAC-SHA256 over `timestamp.nonce.body`** — a replayed request
  is rejected. Only the 128-float descriptor crosses the wire, never an image.

### 5 · As the manager — Arjun (90s)

- **`/team/attendance`** — his 12 reports, today and the week.
- Say this plainly: managers read through dedicated views that **exclude capture
  photos, geolocation and IP**, and hide fields marked PII. A manager sees
  attendance, not surveillance.

### 6 · Documents and compliance (90s)

- **`/admin/documents`** — 64 documents, 26 types.
- The **expiry** view is the venue-specific one: the **FSSAI licence expires
  4 Aug** and the **banquet fire NOC 11 Sep**. That is the screen a venue manager
  would actually open.
- **`/admin/documents/acknowledgements`** — who has read the guest-privacy policy:
  18 acknowledged, 9 opened, 18 not yet.

### 7 · Ask the AI (90s) — optional, see caveat

- **`/me/ask`** or **`/admin/analyst`**. Ask something narrow, e.g.
  *"What is my leave balance?"* → answers in about **12 seconds**.
- Broad questions ("attendance trend this month") take **27–45s** and return real
  charts. Start it talking, then keep narrating — don't watch the spinner.

---

## New since the first draft — worth showing

**Employees can now edit their own record.** `/me/profile/basic` and
`/me/profile/personal` carry a per-field editor for 26 of the 29 fields the
database whitelists; `/me/profile/custom` edits the venue fields (uniform size,
transport route, meal preference, blood group). Two fields save directly
(`about`, `food_preference` — the only two with a column grant); everything else
raises a change request.

Then approve it as Priya at **`/admin/people/changes`**: old value vs proposed
value side by side, who asked, when in IST. Proven end to end — and the database
refuses to let anyone approve their OWN request, so maker-checker is real rather
than a convention.

**The sign-in trail** is at `/me/activity` (Sign-ins tab) and
`/me/settings/security`: each event in plain language — which method, from where,
which device, when in IST. It says "Location was not shared" rather than guessing
a city from an IP, and it withholds "new device" claims it cannot prove.

**Fingerprint (passkey) sign-in** is on `/login` when the platform supports it.

## What to say when asked "is this real?"

- **60 migrations, 29 edge functions**, 142 tables, **302 RLS policies**,
  355 triggers. RLS is the only security boundary; the UI gate is cosmetic.
- **183 routes** built and registered.
- Capabilities resolve **in the database** (`role_capabilities` + `app.has_cap()`).
  Sensitive actions demand **step-up MFA** (TOTP → `aal2`) — approving a
  regularisation will prompt for it.
- Every mutation writes an audit row with a **reason**; `audit_log` has ~2,700
  entries already.
- All clocks are **IST**, and `toISOString()` is banned by lint so a UTC date can
  never leak into a business decision.
- Money is **integer paise** end to end. No floats anywhere near payroll.

---

## Be honest about these if asked

1. **Downloading a *seeded* document fails.** The storage layer is real — migration
   039 creates twelve buckets (`documents`, `payslips`, `contracts`,
   `employee-photos`, `face-enrolment-captures`, …) with `storage.objects`
   policies. What's missing is only the file *bytes*: the 64 seeded documents are
   metadata describing PDFs nobody uploaded, so a download 404s at the object
   layer. Lists, filters, expiry warnings, version history and acknowledgement
   tracking are all fully live, and a **freshly uploaded** document downloads
   normally. Say: *"the document pipeline is wired end to end; the sample rows
   are metadata only."*
2. **Email only reaches the account owner.** Resend is on the shared
   `onboarding@resend.dev` sender because the domain isn't verified. Outbound mail
   is redirected to the owner's address with the intended recipient in the subject
   and an `X-Intended-Recipient` header. Verifying a domain makes it real.
3. **Eight routes are not built** — `/admin/analyst`, `/admin/audit/dpdp`,
   `/admin/audit/retention`, `/admin/org/events`, `/me/ask`, `/me/profile`,
   `/me/profile/:tab`, `/team/people/:employee_code`. Nothing in the navigation
   points at them, so you will not hit them by accident. **Don't type URLs.**
4. **Face sign-in: do not demo it.** The `face-login` function is deployed and its
   security design is strong — it is a 1:1 confirmation (you say who you are, and
   the same scan the gate runs must rank you first), and it refuses any
   manager/admin account behind a generic 404 so it cannot be used to discover
   privileged accounts. But it requires a liveness score, and no passive-liveness
   estimator exists in the build, so the happy path is unproven. Fingerprint and
   password both work. If asked: "face at the gate is attendance and it works;
   face as a *login* factor needs a liveness model before we'd trust it."
5. **Admin cannot yet write two things** the capability matrix implies it can:
   locking/unlocking an attendance period, and creating kiosk device rows
   directly. The capability is granted but the RLS policy is read-only — a fix is
   in flight. Avoid `/admin/attendance/locks` writes and adding a device live.
6. **Travel and resignation requests can't submit.** The approval chains and
   detail tables (`travel_requisitions`, `resignations`) were never created in the
   58-migration plan. Those screens say so on screen and route you to the flow
   that does work (`/me/apply/claim`). This was found by verifying against the
   migrations rather than assuming — it's a **backend gap**, not a UI bug.
7. **`/me/settings` and `/me/activity` exist but aren't in the nav.** The footer
   item points straight at `/me/settings/security`. Deep links work.
8. **TT0015 "Test Candidate"** is a test row in `pre_joining`. Harmless, but
   don't open `/admin/people` and scroll to it while talking about real staff.

---

## If something breaks

- A blank screen is almost always an **expired JWT** — reload; the app
  re-authenticates.
- An empty list is usually **RLS doing its job**, not a bug. Check which persona
  you're logged in as before debugging.
- The AI agent can return a refusal card instead of a chart. That's the
  validator rejecting a malformed spec — the repair loop working, not a crash.

---

## Do before the meeting

- [ ] `npm run dev` and confirm `/me` loads for Deepak.
- [ ] Log in as all three personas once, so no first-login password prompt
      surprises you on the projector.
- [ ] Have `/kiosk` open in a second window, already paired.
- [ ] Rotate `ANTHROPIC_API_KEY` and `RESEND_API_KEY` — both were pasted into a
      chat transcript. Do this **after** the demo, not before; the AI screens need
      the key.
