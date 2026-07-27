# Decision Log — Tamarind Tree HRMS

Append-only. Newest last. Every entry: date (IST), decision, rationale, consequences.

---

## D-001 · 2026-07-25 · Client identity and domain

**Decision.** The product is built for **The Tamarind Tree** (brand), operated by **Machani Hospitalities LLP ("MH LLP")**, LLPIN AAF-9371, RoC Bengaluru. Venue: 88, Avalahalli, Anjanapura Post, JP Nagar 9th Phase, Kanakapura Road, Bengaluru 560108.

**Rationale.** The brief said "MH LLP Machani Hospital". Research confirms the entity is Machani **Hospitalities** LLP — a heritage wedding/event venue and the Machani Group's first hospitality venture. Not a hospital.

**Consequences.** Domain modelling targets **venue operations**: shift work, event-driven weekend peaks, banquet/kitchen/housekeeping/security/gardening/sales departments, contract and probationary staff, routine overtime, comp-off earned from event weekends. No clinical/roster-of-care concepts.

**Status.** Awaiting client confirmation. Raised 2026-07-25; work proceeding on this assumption.

---

## D-002 · 2026-07-25 · Reference repo is frontend-only

**Decision.** `DigitAlchemy-Pvt-Limited/hrms-digitalchemy` is used for **frontend patterns only**. No schema, no backend logic, no data.

**Rationale.** Client instruction. Independently, its attendance/biometric layer is not safe to inherit — see `docs/plan/08-architecture.md` threat model.

**Consequences.** Reusable: face-api model load/warm-up pattern, shadcn conventions, edge-function-per-workflow structure. Explicitly rebuilt: the trust model (client-side biometric decision → server-side 1:N), business-date handling (UTC date → IST-derived), IST representation (formatted strings → `timestamptz`), routing (two tab mega-pages → real deep-linkable routes), theming (dormant dark mode → real ThemeProvider).

---

## D-003 · 2026-07-25 · Attendance identity model: 1:N server-side

**Decision.** Face recognition performs **1:N identification server-side**, not 1:1 verification client-side.

**Rationale.** Client requires a single shared mobile camera at the gate operated by a security guard. There is no per-employee login at the kiosk, so the system must determine *who* the person is. A shared device is untrusted, so the match decision cannot live on the device.

**Consequences.** Kiosk holds no database credentials; it authenticates as a registered device and calls only the punch edge function. Face descriptors are searched with pgvector under the service role. Server timestamp is authoritative; device timestamp is metadata. Requires accept threshold + second-best margin rule, and an ambiguity path in the guard UX.

---

## D-004 · 2026-07-25 · IST is the only business clock

**Decision.** All timestamps stored as `timestamptz` (UTC). Business date derived as `(ts AT TIME ZONE 'Asia/Kolkata')::date`. No formatted local-time strings are ever stored.

**Rationale.** First-scan-in / last-scan-out is defined per IST day. The reference repo stored the UTC calendar date as the business date and precomputed IST strings — both produce wrong day attribution.

**Consequences.** Generated `ist_date` column on punches, indexed. Configurable day-cutover (default 05:00 IST) so post-midnight event shifts attribute to the correct business date.

---

## D-005 · 2026-07-25 · Supabase region → Mumbai (ap-south-1)

**Decision.** Recreate the Supabase project in **South Asia (Mumbai) `ap-south-1`**. Abandon the initial Tokyo project `aygxkkoltwltczfdbplr` (`ap-northeast-1`).

**Rationale.** Measured from the client's machine in Bangalore: Mumbai ~105 ms per request vs Tokyo ~350 ms (TCP connect 35 ms vs 111 ms; TLS 71 ms vs 235 ms). The kiosk punch path makes several sequential DB round trips per scan, so the penalty compounds against a 2.5 s scan-to-confirm budget. Supabase provides no in-place region change, and the project was empty — zero migration cost.

**Correction recorded.** An earlier draft framed Indian data residency as a DPDP Act 2023 *requirement*. That was overstated: s.16 permits transfer to any country not restricted by government notification, and Japan is not restricted. Tokyo was legally permissible. The decision rests on latency and future-proofing.

**Consequences.** New project ref replaces `aygxkkoltwltczfdbplr` in `.mcp.json` (×2), `.env.local`, `.env.example`, `supabase/config.toml`, and docs. Old project to be deleted after cutover.

---

## D-006 · 2026-07-25 · Stay on Supabase Free during development

**Decision.** Remain on the Free plan through the build. Upgrade to **Pro before any real employee data is loaded**. PITR add-on deferred.

**Rationale.** Client's call. Free is adequate for schema and seed work.

**Risks accepted, explicitly.** Free has **no automatic backups** — a bad migration during development is unrecoverable, so migrations stay forward-only and reviewed. Free **pauses after 1 week of inactivity**; if that happens mid-build the project must be resumed from the dashboard. Free caps Storage at 1 GB, and kiosk scan photos alone project to ~700 MB/month at 60 staff × 4 scans/day × ~100 KB.

**Consequences.** Scan-photo retention job is mandatory from day one, not a later optimisation. This decision **must be re-raised before go-live** — a production HRMS holding payroll and biometric records without backups is not acceptable. Tracked as a blocker in the roadmap exit criteria.

---

## D-007 · 2026-07-25 · Public signup must be disabled

**Decision.** `disable_signup` must be set to `true` on the Supabase project. Accounts are created by admin only, via the `employee-account-create` edge function using the service role, with email pre-confirmed.

**Rationale.** The project was found with signup **open** — anyone discovering the URL could self-register. An HRMS has no public registration path.

**Consequences.** Requires dashboard access to change (pending). Onboarding flow depends on server-side account creation, not self-signup. Employees who never use the web app (kiosk-only staff) get no auth account at all.
