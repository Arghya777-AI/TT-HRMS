# Onboarding report — Employee_Basic_(Details).xlsx

All 75 people from the sheet are in the live project as of 2026-07-31: **74 as new
records**, and Sunil M **merged into his existing record TT0016** (see the last
section — he already had a portal login, which a new record would have orphaned).

For all 74, their own employee number (079, PR11, S7 …) **is** the `employee_code`,
not a generated TT-code: the code trigger only allocates when the column arrives
blank, so the venue's numbering is preserved as the system's primary identity.

## What was added to the system to hold this sheet

| Kind | Added |
|---|---|
| Departments (4) | **Ground**, **Restaurant**, **Management**, **Coorg** — the sheet's `Type`, now the department for all 75 |
| Designations (17) | Assistant Finance Manager, CFO and HR Manager, Corporate BD Manager, Electrician and Plumber, Event Co-Ordinator, Event Manager, Event Planner, Housekeeping, Inventory and Event Supervisor, Marketing Associate, Property Manager, Security, Security and Safety Manager, Senior Chef de Partie, Social Media Executive, Social Media Manager, Supervisor |

Two designation spellings were folded into one job: `Houskeeping` (8 people) +
`Housekeeping` (9) → **Housekeeping**, and `Chef De Partie` → **Chef de Partie** to match
the entry that already existed.

## Department = the sheet's `Type`

    Ground       43
    Restaurant   16
    Management   14
    Coorg         2
                ---
                 75

`Type` is the only column all 75 rows answer, so it is the only grouping that leaves
nobody department-less — the sheet's finer `Department` column is blank for 32 of them.

Consequences, stated plainly:

* The sheet's `Department` values (Operations 24, Event Planning 4, Safety and Security 4,
  Sales 3, Marketing 3, Finance 2, CEO office 2, Restaurant 1) are **no longer on the
  employee records**. They remain in the sheet, so this is reversible, but nothing in the
  database now carries them.
* Four departments created for that column hold nobody and were **deactivated**
  (`is_active = false`, not deleted): Operations, Event Planning, Safety and Security,
  CEO office. One field to bring any of them back.
* The `STAFF_CATEGORY` custom field was **retired** the same way. It existed only because
  `Type` had nowhere to live; the department now carries it, and one fact in two places is
  one fact that can drift. The stored values are untouched.
* `Coorg` is now a department, but it names a **property**, not a kind of work — 2 people.
  If Coorg is a second site it belongs in `locations` and on those employees'
  `location_id`. Worth revisiting.

## Values the sheet had that the database refused

Nothing was invented to replace these. Each is a real data-quality item:

| Employee | Field | Value | Why rejected |
|---|---|---|---|
| S8 | PAN | `HDNPA10066M` | 11 characters; PAN is 5 letters + 4 digits + 1 letter |
| S9 | Mobile | `970546868` | 9 digits, not 10 |
| S5, 123, S15, S8 | PAN / alt contact | `-` | placeholder, not a value |

Seven personal addresses were dropped: the sheet gives line 1 but no city, state or
pincode, and all three are NOT NULL on `employee_addresses`. Affected: 079, 091, 073,
085, 092, 060, 063. Only two rows on the sheet carried a complete address — Sunil M's
is on TT0016.

## The 32 incomplete records

Loaded with `employment_status = pre_joining` rather than `active`, so they are
filterable in the directory as visibly unfinished. They now carry a department (their `Type`); each still needs a joining
date and designation before it means anything for attendance or payroll.

| Code | Name | Category | Still missing |
|---|---|---|---|
| PR11 | Bharath | Restaurant | joining date, designation, gender, date of birth, mobile, PAN, Aadhaar |
| S7 | Bhimashankar | Ground | joining date, designation |
| S15 | Bolen Mohan Tripura | Ground | joining date, designation |
| S6 | Chandru C | Ground | joining date, designation |
| S10 | Diganta Rotiya | Coorg | joining date, designation, gender, date of birth, mobile, PAN, Aadhaar |
| S16 | FriJoy | Ground | joining date, designation |
| PR6 | Gasha Mani | Restaurant | joining date, designation, gender, date of birth, mobile, PAN, Aadhaar |
| PR3 | Gitendra Singh | Restaurant | joining date, designation, gender, date of birth, mobile, PAN, Aadhaar |
| S1 | Gopalappa | Ground | joining date, designation, gender, date of birth, mobile, PAN, Aadhaar |
| S5 | Indramma | Ground | joining date, designation, PAN |
| PR7 | Junun | Restaurant | joining date, designation, gender, date of birth, mobile, PAN, Aadhaar |
| PR9 | Khaje ram | Restaurant | joining date, designation, gender, date of birth, mobile, PAN, Aadhaar |
| S3 | Latha R | Ground | joining date, designation, gender, date of birth, mobile, PAN, Aadhaar |
| S9 | T Maheshwari | Ground | joining date, designation, mobile |
| PR12 | Milan | Restaurant | joining date, designation, gender, date of birth, mobile, PAN, Aadhaar |
| S4 | Nagaraj | Ground | joining date, designation |
| S2 | Nagaraju YC | Ground | joining date, designation |
| S20 | Nanda Lal | Ground | joining date, designation, gender, date of birth, mobile, PAN, Aadhaar |
| PR4 | Nandeesh | Restaurant | joining date, designation, gender, date of birth, mobile, PAN, Aadhaar |
| PR10 | Nobin | Restaurant | joining date, designation, gender, date of birth, mobile, PAN, Aadhaar |
| PR2 | Pati Ram | Restaurant | joining date, designation, gender, date of birth, mobile, PAN, Aadhaar |
| S14 | Puttamma | Ground | joining date, designation, PAN |
| S13 | Radha | Ground | joining date, designation, gender, date of birth, mobile, PAN, Aadhaar |
| S19 | Rupak Singh | Ground | joining date, designation, gender, date of birth, mobile, PAN, Aadhaar |
| S11 | Sampat Kandha | Coorg | joining date, designation, gender, date of birth, mobile, PAN, Aadhaar |
| S17 | Sharadamma | Ground | joining date, designation |
| S12 | Shiba | Ground | joining date, designation, gender, date of birth, mobile, PAN, Aadhaar |
| PR8 | Shubhankar | Restaurant | joining date, designation, gender, date of birth, mobile, PAN, Aadhaar |
| S8 | Sujatha | Ground | joining date, designation, PAN |
| S18 | Vijaya Vijayappa | Ground | joining date, designation |
| PR1 | Vikram | Restaurant | joining date, designation, gender, date of birth, mobile, PAN, Aadhaar |
| PR5 | Yogesh | Restaurant | joining date, designation, gender, date of birth, mobile, PAN, Aadhaar |

## Also done

- **Sunil M is TT0016, not 025 — merged, not duplicated.** He was already in the system
  under a generated code, and at 13:07 IST that record was given a portal login
  (`tt0016@tamarindtree.co`, invited). Archiving it in favour of the sheet's `025` would
  have orphaned that login, so TT0016 was restored and the sheet's data merged into it
  instead. `employee_code` stays TT0016 — `employees_immutable_code()` raises on any
  change to it, since it is the identity other tables point at. **He is therefore the one
  person whose code is not the venue's own number.** If 025 must be his code, it needs a
  new record and the login moved across; say so and I will do it.

  The merge filled the fields TT0016 left blank (gender, personal email, father's name,
  designation CFO and HR Manager, location, home address) plus his PAN and Management
  category. Two fields where the live record and the sheet disagreed were then resolved
  **in the sheet's favour, on instruction** — the joining sheet is the record of record:

  | Field | Was | Now (sheet) |
  |---|---|---|
  | `date_of_join` | 2017-04-01 | **2017-04-03** |
  | `employment_status` | confirmed | **active** |
- Statutory identifiers written for 55 people (PAN and/or Aadhaar). All 27 Aadhaar
  numbers on the sheet pass the Verhoeff checksum the database enforces.
- 21 alternative contact numbers stored as `alternate_mobile` contacts.
- **No logins were created.** `employee-account-create` is step-up gated and needs a
  TOTP-enrolled admin session, so all 75 are HR records without portal access. The
  sheet's `Enable Portal` column (25 Enabled / 18 Disabled / 32 blank) is recorded here
  but not acted on.

## A schema fix the 32 blank joining dates forced

`employees.date_of_join` has always been nullable, but five client schemas declared it
required — `directoryRowSchema`, `archivedEmployeeSchema`, `enrolmentCoverageRowSchema`,
`enrolmentRosterRowSchema`, `enrolmentGapSchema`. The moment records without a joining
date existed, the People directory, the archive console and both Face & kiosk screens
replaced themselves with "Something went wrong". All five now match the column, and
`fmtCivilDate` already renders a missing date as an em dash.

The same class of bug was fixed in two attendance schemas after the demo staff were
archived: `v_attendance_day_enriched` and `v_attendance_punch_detail` label rows through
`LEFT JOIN v_employee_ref`, which excludes archived employees, so 388 July day records
and 591 punches came back unlabelled against schemas that demanded a name.

## One value that was inferred, not read

`employment_type` is not on the sheet. The 43 with a joining date and status `Active`
were set **permanent** — several joined in 2015–2019, and leaving them on the column
default of `probation` would have been the more misleading guess. The 32 incomplete
records keep the default. If any of the 43 are actually contract or consultant, that
is a one-field correction per person on their profile.

## Two things to know

- `Coorg` is in the staff-category field because that is what the sheet's `Type` column
  says, but it names a **property**, not a kind of work — 2 people. If Coorg is a second
  location it belongs in `locations` and on those employees' `location_id` instead.
- `settings.seed_demo_data` is still `true` on this project. DEMO-ACCOUNTS.md says to set
  it `false` before real employee data lands. Real employee data has now landed.
