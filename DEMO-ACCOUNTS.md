# Demo accounts — Tamarind Tree HRMS

Live project: **`xfoeudhwxlbkkwetncjb`** · region **`ap-south-1` (Mumbai)**
Run locally: `npm run dev` → http://localhost:8080

## Passwords

| Account | Password |
|---|---|
| `arghya.ghosh@machanigroup.com` (owner, super admin) | `TamarindSuper#2026` — **stale**, see below |
| every `@tamarindtree.co` account below | `TamarindDemo#2026` |
| `vinodmaurya0410@gmail.com` (owner's admin) | `TamarindAdmin#2026`, must be changed on first sign-in |

Also in `.secrets/supabase.env` (gitignored).

The owner password above no longer authenticates on the live project —
`/auth/v1/token` answers `invalid_credentials` for it, so it has been changed out
of band since this file was written. Every `@tamarindtree.co` password still
works. This matters beyond a walkthrough: `super_admin` is the only role that can
grant `super_admin` or write an `employee_role_assignments` row, so while nobody
holds that password, both of those go through a migration or the dashboard.

## Who to sign in as, and what each one proves

| Use case | Login | Sees |
|---|---|---|
| **Normal employee** | `suresh.gowda@tamarindtree.co` | Only himself — 1 employee, 31 attendance days. TT0004 Steward, Banquet. |
| **Employee + manager (small team)** | `ravi.kumar@tamarindtree.co` | Himself + 1 reportee — 2 employees, 62 days. TT0003 Banquet Manager. |
| **Employee + manager (deep team)** | `arjun.nair@tamarindtree.co` | 12 people, 373 days — 9 direct reportees **plus indirect** ones through Ravi and Deepak, resolved by the recursive reporting closure. TT0001 Operations Manager. |
| **Admin** | `priya.menon@tamarindtree.co` | Everyone (13) + 38 capabilities. TT0002 HR Executive with a global admin scope. |
| **Security guard / kiosk operator** | `manjunath.r@tamarindtree.co` | Only himself in the app — gate access is through the kiosk edge function, never through his session. TT0006, registered operator on `TT-GATE-01`. |
| **Super admin (owner)** | `arghya.ghosh@machanigroup.com` | Everything (13) + all 50 capabilities. TT0013. |
| **Owner's own admin** | `vinodmaurya0410@gmail.com` | TT0017 Vinod Maurya, HR & Admin. Holds `admin` now; migration `20260801038500` raises it to `super_admin` and adds the global scope row. Excluded from attendance and payroll — it is an access account, not a roster line. |

## Seeded data behind those screens

- **12 demo employees** TT0001–TT0012 across Banquet, Kitchen, Housekeeping, Security, Front Office, Finance, HR, Gardens
- **624 punches** over the last 30 IST days, and **373 computed attendance days** — 301 present, 20 weekly offs, 36 absent, 49 flagged for review, averaging 8h 34m worked
- **12 approved salary revisions**, 1 published roster week (14 slots), 1 draft payroll run
- Reference data: 13 departments, 11 shifts, 31 designations, 10 leave types, 26 salary components, 19 Karnataka holidays, 12 FY2026-27 pay periods

## Two things this setup revealed

1. **An `admin` role alone grants no data scope.** Capabilities come from `role_capabilities`, but every team/admin read passes through `app.admin_scope_covers()`, which needs an `employee_role_assignments` row. Before that row existed, the HR admin could open every admin screen and see only herself. Both admins now hold `scope_kind='global'`.
2. **Payslips are 0 for everyone, and that is correct.** The demo payroll run is left in `draft`; no payslip is published, so nothing shows. Publishing is a two-person approval through `payslip-publish`, not a seed.

## Notes

- Demo data is guarded by `settings.seed_demo_data`. It is now `true` on this project. Set it back to `false` before real employee data lands.
- `profile_confirmed_at` was set for these accounts so the forced first-run wizard does not block a walkthrough. Clear it on an account to exercise that flow.

## Verified, not assumed

Every account above was signed in through the live API and its identity chain replayed exactly as `AuthProvider` does it. All seven land on `/me`; none is trapped in the first-run wizard.

Three bugs this flushed out, all fixed:

1. **`profiles.display_name` does not exist** — the column is `full_name`. `AuthProvider` asked for the wrong one, PostgREST returned 42703, and because that read is failure-tolerant the error looked like "no profile" — so `profile_confirmed_at` read as NULL and **every** signed-in user was thrown into the forced first-run wizard.
2. **The `employees` base table cannot be filtered by `profile_id`** by `authenticated`. Only a column-scoped grant exists, and Postgres requires SELECT privilege on `WHERE` columns too, so the query returned 42501. Identity now reads `v_my_employee`, which is the sanctioned path anyway.
3. **`FirstRunGate` failed closed.** It could not tell "profile says unconfirmed" from "profile unreadable", so any read failure locked the user out of the entire app. It now fails open on an unresolved identity — the gate is a nudge, not a security control; RLS is the boundary.
