# HR is the admin role, and where IST is (and was not) the clock

Audit performed 2026-07-27 against the deployed migrations (`supabase/migrations/*.sql`)
and all 31 edge functions under `supabase/functions/`, plus `src/`. This document is the conclusion, so the
next person does not have to repeat the search.

---

## Part A — HR **is** the `admin` role

### The finding

`public.app_role` is an enum of exactly four values (migration
`20260801000300_enums.sql`):

```
('employee', 'manager', 'admin', 'super_admin')
```

There is no `hr` value, no `hr_manager`, no second HR table, and no plan for one.
**HR staff are granted `admin`.** That is not an interpretation — the deployed
code says it in two places:

1. `public.resolve_approver_kind('hr_admin', …)` in
   `20260801002900_workflow.sql` §8 resolves the HR approver set as
   `WHERE ur.role = 'admin'`. Every seeded approval chain that routes to
   `hr_admin` (`AC-LEAVE-STD` L2, `AC-LEAVE-LONG` L3, `AC-BANK-CHANGE` L1,
   `AC-SALARY` L2, `AC-PROFILE` L1, `AC-FACE-ENROL` L1) therefore lands on the
   admins.
2. `app.has_role()` in `20260801000500_app_auth_helpers.sql` applies the
   hierarchy **super_admin ⊃ admin ⊃ manager ⊃ employee**, so an `admin` row in
   `user_roles` satisfies a check for `manager` or `employee` as well.

Both facts are now also recorded as `COMMENT ON TYPE public.app_role` and
`COMMENT ON TABLE public.role_capabilities` (migration
`20260801016000_ist_civil_day_and_hr_admin.sql`), so the database can be asked
directly.

### Does `admin` control everything? Yes — with 12 deliberate exceptions

`public.role_capabilities` (migration `20260801005000`) holds **50 rows**, and
because each role lists only what it *adds*, `admin` effectively holds the
first 38:

| Role listed | Rows | Held by `admin`? |
|---|---|---|
| `employee` | 10 | yes, via the hierarchy |
| `manager` | 8 | yes, via the hierarchy |
| `admin` | 20 | yes, directly |
| `super_admin` | 12 | **no — on purpose** |

Nothing needed granting. The 12 `super_admin`-only capabilities, and why each
one stays there:

| Capability | Reserved because |
|---|---|
| `admin.super` | it *is* the marker for the super-admin surfaces |
| `role.grant`, `role.revoke` | changing who is trusted must not be self-service for the people it would promote (spec-admin §16.1 wants four-eyes; the four-eyes ledger is not deployed, so the quiet path is not offered at all) |
| `employee.hard_delete`, `employee.data.purge` | irreversible; DPDP erasure ceremony, second approver within 24 h (spec-admin §2 "Soft/hard delete") |
| `biometric.template.purge` | irreversible destruction of biometric data; only `{template_hash, purged_at, purged_by, reason}` survives |
| `attendance.lock.override` | writing into a locked period moves a payroll figure after it was frozen (spec-admin §4 "Unlock = super_admin, reason ≥ 15, Critical alert") |
| `payroll.run.delete` | deleting a run destroys the evidence behind a payment |
| `audit.export` | takes the audit log **off** the platform; the register of exports is admin-visible, the export itself is not (spec-admin §13) |
| `settings.security.write` | session policy, MFA and password rules are the controls everything else rests on |
| `kiosk.device.secret.rotate` | the gate tablet's HMAC secret is what makes a punch attributable to a device |
| `ai.budget.override` | spending money past a cap the venue set |

All twelve also carry `requires_step_up = true` except `admin.super`, so they
demand a fresh second factor as well as the role.

Read as a rule: **`super_admin` is a technical safety tier, not a seniority
tier.** It adds only irreversibility, trust-granting and off-platform egress.
Everything an HR administrator does day to day is in the 38.

### How the first super admin comes to exist

`public.handle_new_user()` (migration `20260801000400_identity_core.sql` §6) is
an `AFTER INSERT` trigger on `auth.users`. It grants `employee` to every new
account, and grants `super_admin` to the first one only — guarded by
`IF NOT EXISTS (SELECT 1 FROM public.user_roles WHERE role = 'super_admin')`,
with `granted_reason = 'bootstrap: first user'`. No hard-coded email. This is the
"bootstrap" exception: it is the one place `super_admin` appears without another
super admin granting it, and it can happen exactly once per database.

### Proof, not prose

`supabase/tests/harness/prove-roles-ist.mjs` applies every migration to an
embedded PostgreSQL 17, creates the bootstrap owner, then creates a **plain
admin** and asserts against the live catalog:

```
node supabase/tests/harness/prove-roles-ist.mjs
```

24 assertions, all passing as of this audit — including
`app.has_cap()` returning true for all 38 non-super capabilities and false for
all 12 reserved ones, `my_capabilities()` returning exactly 38, and
`resolve_approver_kind('hr_admin')` filtering on `ur.role = 'admin'`. The
harness pins the session to `timezone = 'UTC'` because the embedded cluster
inherits the host zone (IST on a Bengaluru laptop), which would hide the entire
Part B bug class.

### What the audit changed

Three UI-side divergences from that model, all fixed:

1. **`/admin/settings/roles` was gated `admin.super`** in
   `src/app/route-manifest.ts` — so an HR admin could never open the screen that
   explains their own authority. But the deployed RLS deliberately lets an admin
   *read* every table on it (`user_roles__admin_read`, `era__admin_read`,
   `profiles__admin_read` in `20260801000660`, plus a read-to-all-authenticated
   policy on `role_capabilities` in `20260801005000`) while reserving
   INSERT/UPDATE to `app.is_super_admin()`. `Roles.page.tsx` already implemented
   exactly that split — its `!isSuper` branches were unreachable dead code.
   Tier is now `A/S`: admin reads, super admin grants.
2. **`capsForRoles` gave `admin` no `team.view`** while the database gives an
   admin every manager capability. The `/team` nav survived only because
   `AuthProvider`'s `isManager` probe counts rows from `v_team_employee_basic`,
   which also returns admin-scoped employees. On a fresh tenant with no
   `employee_role_assignments` row the probe returns nothing and an admin lost a
   section the server would have served. `admin` now lists `team.view`
   explicitly, matching `super_admin`.
3. **`supabase/functions/_shared/auth.ts` `SUPER_ADMIN_ONLY_CAPS` was
   incomplete** — it claimed to mirror migration 050 but omitted `admin.super`,
   `payroll.run.delete` and `attendance.lock.override`, so the synchronous
   `hasCap()` fallback answered *true* for a plain admin asking to write into a
   locked payroll period. No live caller was affected (every edge function uses
   `requireCapDb` / `requireCapWithStepUp` / `hasCapDb`, i.e. `app.has_cap()`),
   but a permissive fallback is worse than none. All 12 are listed now.

### Two capabilities that are deliberately **not** in the matrix

Leave them out. Both are load-bearing absences:

- **`kiosk.operate`** — a gate guard is not an `app_role`. Authority is the
  `public.kiosk_operators` row, and `kiosk-operator-auth` checks whether the
  capability is *declared* before enforcing it (`guardHoldsOperatorCap`:
  undeclared → row-based authority). Seeding `kiosk.operate` against any role
  would immediately lock every guard out of the scanner.
- **`auth.passkey.register`** — same pattern in `webauthn-register`
  (`if (capSeeded && !(await hasCapDb(…)))`). Declaring it would deny passkey
  enrolment to every employee.

### Route tiers versus the spec

Every `/admin/**` row in `src/app/route-manifest.ts` now matches
`docs/build/spec-admin.md` §§1–15 tiers, with one intentional deviation:
`/admin/settings/roles` is `A/S` here and `S` in the spec, for the reason in (1)
above. The remaining seven `S` routes (`/admin/kiosk/purge`,
`/admin/audit/integrity`, `/admin/audit/retention`,
`/admin/analytics/exports`, `/admin/settings/api`,
`/admin/settings/security`, `/admin/settings/backup`) map onto the reserved
capabilities in the table above and stay super-admin-only.

---

## Part B — IST everywhere

The premise brought to this audit was "the frontend looks clean; check the edge
functions and the database". The audit found the opposite emphasis: **the
database and edge layer were nearly right, and the frontend guard that was
believed to exist did not.**

### Verified correct — do not churn these

- **Edge functions (all 31).** Zero `toISOString()` and zero bare `new Date()`
  outside `_shared/datetime.ts`. Zero `getFullYear`/`getMonth`/`getDate`/
  `getUTC*`/`toLocaleDateString`. Every day, window and bucket comes from
  `_shared/datetime.ts` (`istToday`, `istDate`, `istInstant`, `businessDate`,
  `addDays`, `istParts`). Spot-checked in the dangerous places:
  `cron-daily-attendance-close` (business date = `addDays(istToday(), -1)`),
  `cron-accruals`, `cron-compoff-expiry`, `cron-payroll-prechecks`
  (`for_date ?? istToday()`), `cron-expiry-reminders` (next Monday derived from
  `istParts(istInstant(asOf,'12:00:00')).weekday`), `cron-integrity`,
  `cron-ai-digest`, `notification-dispatch` (quiet hours in IST wall clock),
  `document-generate` (`toIsoDate` routes a `Date` through `istDate`).
- **`export-audit`.** Converts an IST date window to `[fromInstant, toInstant)`
  UTC instants for the row filter, and separately widens the *verification*
  window by one UTC day because `audit.verify_chain` walks `occurred_at::date`
  in UTC. Verifying more of the chain than was exported is safe; verifying less
  would be false assurance. The asymmetry is deliberate and commented.
- **pg_cron (migration `20260801004100`).** The database timezone is UTC, and
  every schedule string is UTC with the IST intent in `schedule_human`. All 21
  conversions were re-derived and all 21 are right (e.g. `30 22 * * *` =
  04:00 IST, `0 20 * * *` = 01:30 IST, `30 21 24 * *` = 03:00 IST on the 25th,
  `50 3 1 1,2,3 *` = 09:20 IST on the 1st of Jan/Feb/Mar). Day-boundary jobs
  carry a `util.ist_today()` guard inside the command rather than trusting the
  cron day (`leave_accrual` fires daily and accrues only when the IST day is the
  1st; `payroll_reminder` fires daily and delivers only when
  `attendance_cutoff_date - 2 = util.ist_today()`).
- **The engines.** `util.ist_today()` / `util.ist_date()` /
  `util.business_date()` appear 59 times across attendance, leave, payroll and
  the views. `expire_comp_off`, `mark_absent_days`, `accrue_leave`,
  `compute_attendance_day` and every `v_*` view derive their day in IST.
- **`date_trunc('month'|'quarter', now())`** in `partition_maintenance` and the
  partition bootstraps is UTC **and should stay UTC**: those are bounds on a
  `timestamptz` partition key. An IST-truncated bound would still be read as a
  UTC instant, moving the seam without removing it. A storage seam is not a
  business day.
- **`Date.now()` in `src/`** (IstClock, useHomeUi, reveal countdown, kiosk
  cooldown) is elapsed-time arithmetic, which is timezone-independent.

### Fixed — genuinely wrong

**1. Eleven `CURRENT_DATE` sites in the database** (migration
`20260801016000_ist_civil_day_and_hr_admin.sql`). The database timezone is UTC,
so `CURRENT_DATE` is the UTC calendar day — which between 00:00 and 05:29 IST is
*yesterday*. Every site was an authority window or an effective-date default:

| Site | Consequence before the fix |
|---|---|
| `app.is_manager_of()` | a delegation dated to start today granted nothing until 05:30 IST; one that ended yesterday still granted team access until 05:30 IST |
| `app.admin_scope_covers()` (×2) | same, for scoped-admin assignments — the predicate behind every admin read |
| `public.resolve_approver_kind()` | the location-head admin assignment window |
| `public.resolve_approvers()` | delegation expansion when routing an approval |
| `public.act_on_approval()` | whether an action is recorded as `approver` or `delegate` |
| `employee_role_assignments.effective_from` default | a scope created at 01:00 IST back-dated one day |
| `employee_bank_accounts.effective_from` default | a payroll input back-dated one day |
| `employee_swipe_cards.issued_on` / `.valid_from` defaults | access dates back-dated one day |

This is not a theoretical window at a wedding venue: a banquet shift ending at
02:00 IST is the ordinary case, and that is precisely when a manager or delegate
would be acting.

Fix by shape: the two small `app.*` SQL helpers are re-created with
`util.ist_today()` spelled out (they are the predicates every RLS policy leans
on, so explicitness wins); the three large plpgsql workflow functions get
`ALTER FUNCTION … SET timezone = 'Asia/Kolkata'`, which is what makes
`CURRENT_DATE` mean the IST civil day without copying a 310-line body into a
second migration where it could drift from `20260801002900`. Verified safe:
`CURRENT_DATE` is the *only* timezone-dependent expression in all three — no
`to_char`, no `timestamptz::text`, no `::date`, no `AT TIME ZONE`. Migration
`20260801000600` already establishes the pattern in the opposite direction
(`audit.write_row` / `audit.verify_chain` carry `SET timezone = 'UTC'` so the
hash payload is stable).

**2. `civilDateMinusDays()` was off by one, always**
(`src/features/attendance/api/regularizations.api.ts`). It built an instant from
IST midnight (`…T00:00:00+05:30` = 18:30 UTC on the *previous* day), subtracted
whole days, then read `getUTCDate()` back off it. A 15-day regularisation window
measured from 2026-07-25 opened on **2026-07-09** instead of 2026-07-10.
`NewRegularization.page.tsx` used that value both as the displayed "window opens
on" date and as the client-side guard, so it accepted one date the server would
reject. Now delegates to `addIstDays(isoDate, -days)`.

**3. A `timestamptz` rendered as a UTC day**
(`src/features/admin/pages/LeaveLedger.page.tsx`).
`fmtCivilDate(last_recomputed_at.slice(0, 10))` takes the first ten characters
of a `timestamptz`, i.e. the UTC date. The `balance_drift_check` job that writes
that column runs at **02:45 IST = 21:15 UTC the previous day**, so the screen
reported yesterday every single night. Now `fmtDateTime(last_recomputed_at)`.

**4. The eslint guard on `new Date()` did not exist** (`eslint.config.js`). The
file's own header claims "no business date is ever derived from UTC or browser
locale", and `toISOString` / `toLocale*` *were* restricted — but nothing
restricted a zero-argument `new Date()`, and three call sites had drifted in
(`CommandCentre.page.tsx`, `Landing.tsx`, `apply.api.ts`). None produced a wrong
value — each fed the instant straight into an IST formatter or an instant
comparison — but the guard everyone believed in was not there. A
`NewExpression[callee.name='Date'][arguments.length=0]` rule now enforces it
(`new Date(value)` with an argument stays legal: parsing a stored instant is not
deriving a business day), and the three sites use `nowInstantIso()`.

### Why this is now independent of the server's timezone

Worth stating because it bit the proof harness: the embedded PostgreSQL used by
`npm run db:validate` inherits the **host** zone, which on a Bengaluru laptop is
Asia/Kolkata — so `CURRENT_DATE` looked correct locally and was wrong only on
hosted Supabase (UTC). After this migration none of the ten sites reads the
ambient `TimeZone` setting at all: four are `util.ist_today()` and three
functions carry their own `SET timezone = 'Asia/Kolkata'`. Correctness no longer
depends on how the cluster happens to be configured.

`supabase/tests/harness/prove-roles-ist.mjs` asserts this with the session forced
to UTC, so a regression fails loudly instead of hiding behind a friendly local
clock.

### Known, accepted, not IST bugs

- `audit_seal` is registered for 02:15 IST; spec-admin §13 says the daily anchor
  is 00:10 IST. The cron string and its `schedule_human` agree with each other,
  so this is spec drift, not a timezone error. Left alone.
- `public.cron_jobs` has no entry for the main `cron-daily-attendance-close`
  task (only `missing_out`), nor for `cron-accruals`, `cron-ai-digest` or
  `notification-dispatch`. That is scheduling coverage, not IST correctness.
  Flagged, not fixed here.
- **The roles screen has no in-app link.** `src/app/shell/nav-model.ts` carries
  one nav entry per admin section, and the Settings entry points at
  `/admin/settings/branding`; there is no sub-navigation, and `/admin/settings`
  is not a route. So `/admin/settings/roles` is reachable by URL (and, once
  global search is wired, by search) but not by clicking. This affects all
  eleven settings pages identically, predates this audit, and fixing it means
  designing a section sub-nav in `src/app/shell/**` — flagged for the shell
  owner, not patched here.
- `monthBounds()` in `regularizations.api.ts` re-implements
  `daysInIstMonth()` with `Date.UTC(year, month, 0)`. The arithmetic is
  timezone-neutral and the output is correct, so it was left as-is rather than
  churned — but a future edit there should use `@/lib/datetime`.

---

## Review corrections (migration `20260801017000`)

An adversarial review of the above found two things this audit asserted but had
not fully checked. Both are corrected in
`20260801017000_audit_tz_pin_and_capability_truth.sql`; neither changes a grant
or a predicate.

### 1. `app.has_cap()` is not the boundary — RLS is

Part A proved "admin holds all 38 non-super capabilities" by asking
`app.has_cap()`. That is a lookup in `role_capabilities`; it is not what refuses
a request. For two of the 20 admin rows the row-level policies are strictly
narrower than the capability's own description, and because
`/admin/settings/roles` renders those descriptions to HR, the matrix was
promising authority the server withholds:

| Capability | Described as | Actually enforced |
|---|---|---|
| `attendance.lock.manage` | "Lock **or unlock** an attendance period" | `attendance_locks__admin_insert` allows `lock_kind = 'soft'` only; `attendance_locks__super_update` reserves every UPDATE — and an unlock *is* an UPDATE stamping `unlocked_at` — to `app.is_super_admin()`. An admin may take a soft lock and nothing else. |
| `kiosk.device.manage` | "Manage kiosk devices **and operators**" | `kiosk_operators__admin_all` does grant FOR ALL to an admin, and `kiosk-provision` (service-role, gated on this capability) does let an admin issue activation codes and set operator PINs. But `kiosk_devices` is `__admin_read` (SELECT) + `__super_admin_write` (FOR ALL), so editing a device row — including `min_match_confidence`, the face-match threshold — is super-admin. |

The policies agree with spec-admin §4 ("Unlock = super_admin, reason ≥ 15,
Critical alert"), which this document already quoted in the reserved-capability
table. The spec and the enforcement were right; only the two descriptions and
the client-facing copy were wrong, and only those were changed. **The narrower
question — whether HR-as-admin *should* be able to release a period lock or edit
a gate tablet — is a decision for the client, not for a description edit, and is
left open.**

The claim to retire: *"Everything an HR administrator does day to day is in the
38."* Accurate as a statement about `role_capabilities`; not a statement about
what RLS permits. Releasing a lock is the counter-example.

### 2. `SET timezone` on a function leaks into the triggers its writes fire

Migration 160 pinned three workflow functions to `Asia/Kolkata` and justified it
with "none of the three performs any other timezone-dependent operation — no
`to_char`, no `timestamptz::text`, no `::date`, no `AT TIME ZONE`". True of the
three **bodies**. But `act_on_approval` is the one of the three that *writes*,
and its INSERT/UPDATEs fire `audit.log_changes()`, which carries
`SET search_path = ''` and **no** `SET timezone`. A `SET` on a caller is
inherited by a callee that does not override it, and `to_jsonb(NEW)` renders
`timestamptz` in the ambient zone. Measured on one instant through one trigger:

```
via a caller pinned to Asia/Kolkata : "2026-07-27T05:00:00+05:30"
via an unpinned caller (session UTC): "2026-07-26T23:30:00+00:00"
```

**The hash chain was never at risk** — `audit.write_row` hashes the jsonb it is
handed and `verify_chain` re-reads that same stored jsonb, and `jsonb::text` of
an already-rendered string is zone-independent (md5 of the stored payload is
stable across session zones). `audit_log.ist_date` / `ist_timestamp` are
GENERATED from `util.ist_date(occurred_at)`, so partitioning and day-bucketing
never depended on the ambient zone either. What was at risk is representational
consistency: approval diffs stored at `+05:30` in a column where everything else
is `+00:00`.

Fixed by pinning the *writer* rather than un-pinning the callers:
`ALTER FUNCTION audit.log_changes() SET timezone = 'UTC'`, the same discipline
migration `20260801000600` already applies to `audit.write_row` and
`audit.verify_chain`. The audit engine is now independent of whatever zone a
calling function chooses.

### The harness now proves the boundary

`prove-roles-ist.mjs` gained **Part C**, which runs as the `authenticated` ROLE
so policies actually engage — as `postgres` the harness owns the tables and RLS
is bypassed, which is why no earlier assertion could have caught either finding.
**34 assertions, all passing.** Part C asserts, by real DML:

- admin **can** take a soft attendance lock;
- admin **cannot** take a hard one (`42501`);
- admin **cannot** release a lock it just took — the UPDATE matches **zero rows**
  rather than raising, which is precisely why this surfaced in no log;
- admin **cannot** write `kiosk_devices` (`42501`) while holding
  `kiosk.device.manage`, though it **can** manage `kiosk_operators`;
- both corrected descriptions name their `super_admin` narrowing;
- `audit.log_changes` is pinned to `TimeZone=UTC`.
