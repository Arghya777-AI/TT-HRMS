-- =============================================================================
-- Migration 042 — seed: reference data (§14.1–14.6)
-- Company, location, cost centres, departments, sections, grades, shifts,
-- designations, weekly-off rules.
-- Source: docs/plan/04-data-model.md §14.1–14.6; spec-migrations §6.1–6.6.
--
-- §14.1 note: the first authenticated user receives super_admin via
-- public.handle_new_user() (migration 004) with granted_reason
-- 'bootstrap: first user'. The HR-Admin employee_role_assignments row is
-- created once the HR head employee exists (runtime, not seed) — there are
-- no employees at seed time.
--
-- Idempotent: every INSERT is ON CONFLICT DO NOTHING against the table's
-- unique index (partial-index conflict targets carry the WHERE clause) or
-- guarded by NOT EXISTS.
-- =============================================================================

BEGIN;

-- Reason/source context for audit.log_changes(): tables in
-- audit.reason_required_tables demand a reason on UPDATE, and every audit row
-- this seed writes should say where it came from.
SELECT set_config('app.reason', 'seed 042: company, org structure, shifts and weekly-off rules', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. Company (§14.2)
-- -----------------------------------------------------------------------------
INSERT INTO public.companies
  (code, name, description, sort_order, legal_name, trade_name, entity_type,
   registration_number, incorporation_date, registered_address,
   employee_code_prefix, employee_code_padding, financial_year_start_month,
   default_currency, is_default)
SELECT
  'TT',
  'The Tamarind Tree',
  'Machani Hospitalities LLP — heritage events venue, Kanakapura Road, Bengaluru.',
  10,
  'MACHANI HOSPITALITIES LLP',
  'The Tamarind Tree',
  'LLP',
  'AAF-9371',
  DATE '2016-03-15',
  jsonb_build_object(
    'line1',   '88, Avalahalli',
    'line2',   'Anjanapura Post, JP Nagar 9th Phase',
    'line3',   'Kanakapura Road',
    'city',    'Bengaluru',
    'state',   'Karnataka',
    'pincode', '560108',
    'country', 'India'),
  'TT', 4, 4, 'INR', true
WHERE NOT EXISTS (
  SELECT 1 FROM public.companies WHERE code = 'TT' AND deleted_at IS NULL);

-- -----------------------------------------------------------------------------
-- 2. Location TTT-VENUE (§14.2). lat/lng captured on site (Appendix B8).
-- -----------------------------------------------------------------------------
INSERT INTO public.locations
  (company_id, code, name, description, sort_order, address, city, state,
   pincode, geofence_radius_m, timezone, is_primary)
SELECT
  c.id, 'TTT-VENUE', 'Tamarind Tree, Avalahalli',
  'Primary venue. 88, Avalahalli, Anjanapura Post, JP Nagar 9th Phase, Kanakapura Road, Bengaluru, Karnataka 560108.',
  10,
  jsonb_build_object(
    'line1',   '88, Avalahalli',
    'line2',   'Anjanapura Post, JP Nagar 9th Phase',
    'line3',   'Kanakapura Road',
    'city',    'Bengaluru',
    'state',   'Karnataka',
    'pincode', '560108',
    'country', 'India'),
  'Bengaluru', 'Karnataka', '560108', 300, 'Asia/Kolkata', true
FROM public.companies c
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (company_id, code) WHERE (deleted_at IS NULL) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. Cost centres (§14.4): 9 roots, CC-BANQ sub-split into WED / CORP.
-- -----------------------------------------------------------------------------
INSERT INTO public.cost_centres (company_id, code, name, sort_order)
SELECT c.id, v.code, v.name, v.ord
FROM public.companies c,
     (VALUES
        ('CC-VENUE', 'Venue (general)',            10),
        ('CC-BANQ',  'Banquet & Service',          20),
        ('CC-KITCH', 'Kitchen & Culinary',         30),
        ('CC-HK',    'Housekeeping',               40),
        ('CC-SEC',   'Security',                   50),
        ('CC-GARD',  'Horticulture & Gardens',     60),
        ('CC-MAINT', 'Maintenance & Engineering',  70),
        ('CC-SALES', 'Sales & Events',             80),
        ('CC-ADMIN', 'Administration',             90)
     ) AS v(code, name, ord)
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (company_id, code) WHERE (deleted_at IS NULL) DO NOTHING;

INSERT INTO public.cost_centres (company_id, code, name, sort_order, parent_cost_centre_id)
SELECT c.id, v.code, v.name, v.ord, p.id
FROM public.companies c
JOIN public.cost_centres p
  ON p.company_id = c.id AND p.code = 'CC-BANQ' AND p.deleted_at IS NULL,
     (VALUES
        ('CC-BANQ-WED',  'Banquet — Weddings',  21),
        ('CC-BANQ-CORP', 'Banquet — Corporate', 22)
     ) AS v(code, name, ord)
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (company_id, code) WHERE (deleted_at IS NULL) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 4. Departments (§14.3) — 13 rows. Operational: BANQ KITCH HK SEC GARD MAINT FO TRAN.
--    Cost-centre mapping: obvious pairs; FO/TRAN roll into CC-VENUE,
--    SALES/MKTG into CC-SALES, FIN/HR/PUR into CC-ADMIN.
-- -----------------------------------------------------------------------------
INSERT INTO public.departments (company_id, code, name, sort_order, is_operational, cost_centre_id)
SELECT c.id, v.code, v.name, v.ord, v.ops, cc.id
-- CROSS JOIN, not a comma: an explicit JOIN binds tighter than a comma, so
-- `c` would not be visible inside the LEFT JOIN's ON clause.
FROM public.companies c
CROSS JOIN
     (VALUES
        ('BANQ',  'Banquet & Service',              10, true,  'CC-BANQ'),
        ('KITCH', 'Kitchen & Culinary',             20, true,  'CC-KITCH'),
        ('HK',    'Housekeeping',                   30, true,  'CC-HK'),
        ('SEC',   'Security',                       40, true,  'CC-SEC'),
        ('GARD',  'Horticulture & Gardens',         50, true,  'CC-GARD'),
        ('MAINT', 'Maintenance & Engineering',      60, true,  'CC-MAINT'),
        ('SALES', 'Sales & Events',                 70, false, 'CC-SALES'),
        ('MKTG',  'Marketing',                      80, false, 'CC-SALES'),
        ('FO',    'Front Office & Guest Relations', 90, true,  'CC-VENUE'),
        ('FIN',   'Finance & Accounts',            100, false, 'CC-ADMIN'),
        ('HR',    'Human Resources & Admin',       110, false, 'CC-ADMIN'),
        ('PUR',   'Stores & Purchase',             120, false, 'CC-ADMIN'),
        ('TRAN',  'Transport',                     130, true,  'CC-VENUE')
     ) AS v(code, name, ord, ops, cc_code)
LEFT JOIN public.cost_centres cc
  ON cc.company_id = c.id AND cc.code = v.cc_code AND cc.deleted_at IS NULL
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (company_id, code) WHERE (deleted_at IS NULL) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 5. Sections (§14.3, "typical sections")
-- -----------------------------------------------------------------------------
INSERT INTO public.sections (department_id, code, name, sort_order)
SELECT d.id, v.code, v.name, v.ord
FROM public.companies c
JOIN public.departments d ON d.company_id = c.id AND d.deleted_at IS NULL
JOIN (VALUES
        ('BANQ',  'SERVICE',        'Service',            10),
        ('BANQ',  'BAR',            'Bar',                20),
        ('BANQ',  'SETUP',          'Setup & Teardown',   30),
        ('BANQ',  'STEWARD',        'Steward',            40),
        ('KITCH', 'HOT',            'Hot Kitchen',        10),
        ('KITCH', 'COLD',           'Cold Kitchen',       20),
        ('KITCH', 'BAKERY',         'Bakery',             30),
        ('KITCH', 'DISHWASH',       'Dishwash',           40),
        ('KITCH', 'STORES',         'Stores',             50),
        ('HK',    'PUBLIC-AREA',    'Public Area',        10),
        ('HK',    'ROOMS',          'Rooms & Cottages',   20),
        ('HK',    'LAUNDRY',        'Laundry',            30),
        ('HK',    'WASHROOMS',      'Washrooms',          40),
        ('SEC',   'GATE',           'Gate & Kiosk',       10),
        ('SEC',   'PATROL',         'Patrol',             20),
        ('SEC',   'PARKING',        'Parking & Valet',    30),
        ('GARD',  'LAWNS',          'Lawns',              10),
        ('GARD',  'NURSERY',        'Nursery',            20),
        ('GARD',  'WATER',          'Water Bodies',       30),
        ('MAINT', 'ELEC',           'Electrical',         10),
        ('MAINT', 'PLUMB',          'Plumbing',           20),
        ('MAINT', 'HVAC',           'HVAC',               30),
        ('MAINT', 'CARPENTRY',      'Carpentry',          40),
        ('MAINT', 'SOUND-LIGHT',    'Sound & Light',      50),
        ('SALES', 'WEDDINGS',       'Weddings',           10),
        ('SALES', 'CORPORATE',      'Corporate',          20),
        ('SALES', 'PHOTOSHOOTS',    'Photoshoots',        30),
        ('FO',    'RECEPTION',      'Reception',          10),
        ('FO',    'CONCIERGE',      'Concierge',          20),
        ('FIN',   'AP',             'Payables',           10),
        ('FIN',   'AR',             'Receivables',        20),
        ('FIN',   'PAYROLL',        'Payroll',            30),
        ('HR',    'RECRUIT',        'Recruitment',        10),
        ('HR',    'PAY-COMPLIANCE', 'Payroll & Compliance', 20),
        ('HR',    'ADMIN',          'Admin',              30)
     ) AS v(dept_code, code, name, ord)
  ON v.dept_code = d.code
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (department_id, code) WHERE (deleted_at IS NULL) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 6. Grades (§14.4): G1 (level 1, probation 3 mo, notice 15 d) … G7 (GM,
--    level 7, probation 6 mo, notice 90 d). Intermediate rungs interpolated.
-- -----------------------------------------------------------------------------
INSERT INTO public.grades
  (company_id, code, name, sort_order, level, probation_months, notice_period_days)
SELECT c.id, v.code, v.name, v.ord, v.lvl, v.prob, v.notice
FROM public.companies c,
     (VALUES
        ('G1', 'Helper / Attendant',      10, 1, 3, 15),
        ('G2', 'Skilled Staff',           20, 2, 3, 30),
        ('G3', 'Senior Staff / Captain',  30, 3, 3, 30),
        ('G4', 'Supervisor / Executive',  40, 4, 6, 30),
        ('G5', 'Senior Executive',        50, 5, 6, 60),
        ('G6', 'Manager',                 60, 6, 6, 60),
        ('G7', 'General Manager',         70, 7, 6, 90)
     ) AS v(code, name, ord, lvl, prob, notice)
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (company_id, code) WHERE (deleted_at IS NULL) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 7. Shifts (§14.5) — 11 rows, cutover 05:00 all, grace 10/10 except SEC-* 5/5.
--    duration_minutes = wall span − unpaid break (validated by trigger).
--    half/full-day thresholds scale with the shift's paid duration.
-- -----------------------------------------------------------------------------
INSERT INTO public.shifts
  (company_id, code, name, description, sort_order,
   start_time, end_time, duration_minutes, unpaid_break_minutes,
   grace_in_minutes, grace_out_minutes, night_shift, day_cutover_time,
   half_day_minutes, absent_below_minutes, full_day_minutes,
   min_minutes_for_present)
SELECT c.id, v.code, v.name, v.descr, v.ord,
       v.st, v.et, v.dur, v.brk,
       v.gin, v.gout, v.night, TIME '05:00',
       v.dur / 2, 120, v.dur,
       v.dur / 2
FROM public.companies c,
     (VALUES
        ('G',       'General',             'Admin, Sales, Finance, HR.',                          10, TIME '09:30', TIME '18:30', 480,  60, 10, 10, false),
        ('HK-A',    'Housekeeping Early',  'Gardens + housekeeping start before guests.',        20, TIME '05:30', TIME '14:00', 450,  60, 10, 10, false),
        ('BANQ-A',  'Banquet Morning',     NULL,                                                  30, TIME '07:00', TIME '16:00', 480,  60, 10, 10, false),
        ('BANQ-B',  'Banquet Afternoon',   NULL,                                                  40, TIME '14:00', TIME '23:00', 480,  60, 10, 10, false),
        ('EVT',     'Event Long',          'Wedding service through teardown.',                   50, TIME '16:00', TIME '01:30', 510,  60, 10, 10, true),
        ('KIT-A',   'Kitchen Morning',     NULL,                                                  60, TIME '06:00', TIME '15:00', 480,  60, 10, 10, false),
        ('KIT-B',   'Kitchen Evening',     NULL,                                                  70, TIME '13:00', TIME '22:00', 480,  60, 10, 10, false),
        ('SEC-D',   'Security Day',        '12-hour post; 660 paid minutes.',                     80, TIME '07:00', TIME '19:00', 660,  60,  5,  5, false),
        ('SEC-N',   'Security Night',      '12-hour post; 660 paid minutes.',                     90, TIME '19:00', TIME '07:00', 660,  60,  5,  5, true),
        ('MAINT-G', 'Maintenance General', NULL,                                                 100, TIME '08:00', TIME '17:00', 480,  60, 10, 10, false),
        ('SPLIT',   'Split Shift',         'Long unpaid mid-day break, common in F&B.',          110, TIME '10:00', TIME '22:00', 480, 240, 10, 10, false)
     ) AS v(code, name, descr, ord, st, et, dur, brk, gin, gout, night)
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (company_id, code) WHERE (deleted_at IS NULL) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 8. Designations (§14.4). is_managerial for Manager/Supervisor/Captain/Chef
--    roles; ot_eligible = false for GM, Operations Manager, department
--    managers and Executive Chef; default_shift_id: Security Guard → SEC-D,
--    Housekeeping Attendant → HK-A, Gardener → HK-A, everyone else → G.
--    Doc §14.4 says "28 rows" but enumerates 31 names — all 31 are seeded.
-- -----------------------------------------------------------------------------
INSERT INTO public.designations
  (company_id, code, name, sort_order, grade_id, is_managerial, is_executive,
   ot_eligible, default_shift_id)
SELECT c.id, v.code, v.name, v.ord, g.id, v.mgr, v.exec, v.ot, s.id
FROM public.companies c
JOIN (VALUES
        ('GM',           'General Manager',           10, 'G7', true,  true,  false, 'G'),
        ('OPS-MGR',      'Operations Manager',        20, 'G6', true,  true,  false, 'G'),
        ('BANQ-MGR',     'Banquet Manager',           30, 'G6', true,  false, false, 'G'),
        ('BANQ-CAPT',    'Banquet Captain',           40, 'G3', true,  false, true,  'G'),
        ('STEWARD',      'Steward',                   50, 'G2', false, false, true,  'G'),
        ('BARTENDER',    'Bartender',                 60, 'G2', false, false, true,  'G'),
        ('EXEC-CHEF',    'Executive Chef',            70, 'G6', true,  false, false, 'G'),
        ('SOUS-CHEF',    'Sous Chef',                 80, 'G5', true,  false, true,  'G'),
        ('CDP',          'Chef de Partie',            90, 'G4', true,  false, true,  'G'),
        ('COMMIS-1',     'Commis I',                 100, 'G3', false, false, true,  'G'),
        ('COMMIS-2',     'Commis II',                110, 'G2', false, false, true,  'G'),
        ('COMMIS-3',     'Commis III',               120, 'G1', false, false, true,  'G'),
        ('KIT-HELPER',   'Kitchen Helper',           130, 'G1', false, false, true,  'G'),
        ('HK-SUP',       'Housekeeping Supervisor',  140, 'G4', true,  false, true,  'G'),
        ('HK-ATT',       'Housekeeping Attendant',   150, 'G1', false, false, true,  'HK-A'),
        ('LAUNDRY-ATT',  'Laundry Attendant',        160, 'G1', false, false, true,  'G'),
        ('SEC-SUP',      'Security Supervisor',      170, 'G4', true,  false, true,  'G'),
        ('SEC-GUARD',    'Security Guard',           180, 'G2', false, false, true,  'SEC-D'),
        ('VALET',        'Valet',                    190, 'G1', false, false, true,  'G'),
        ('HEAD-GARD',    'Head Gardener',            200, 'G3', false, false, true,  'G'),
        ('GARDENER',     'Gardener',                 210, 'G1', false, false, true,  'HK-A'),
        ('MAINT-SUP',    'Maintenance Supervisor',   220, 'G4', true,  false, true,  'G'),
        ('ELECTRICIAN',  'Electrician',              230, 'G2', false, false, true,  'G'),
        ('PLUMBER',      'Plumber',                  240, 'G2', false, false, true,  'G'),
        ('SALES-MGR',    'Sales Manager',            250, 'G6', true,  false, false, 'G'),
        ('EVENT-EXEC',   'Event Executive',          260, 'G4', false, false, true,  'G'),
        ('FO-EXEC',      'Front Office Executive',   270, 'G4', false, false, true,  'G'),
        ('ACCOUNTANT',   'Accountant',               280, 'G4', false, false, true,  'G'),
        ('HR-EXEC',      'HR Executive',             290, 'G4', false, false, true,  'G'),
        ('STORE-KEEPER', 'Store Keeper',             300, 'G2', false, false, true,  'G'),
        ('DRIVER',       'Driver',                   310, 'G2', false, false, true,  'G')
     ) AS v(code, name, ord, grade_code, mgr, exec, ot, shift_code) ON true
LEFT JOIN public.grades g
  ON g.company_id = c.id AND g.code = v.grade_code AND g.deleted_at IS NULL
LEFT JOIN public.shifts s
  ON s.company_id = c.id AND s.code = v.shift_code AND s.deleted_at IS NULL
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (company_id, code) WHERE (deleted_at IS NULL) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 9. Weekly-off rules (§14.6). DOW 0 = Sunday.
-- -----------------------------------------------------------------------------
INSERT INTO public.weekly_off_rules
  (company_id, code, name, description, sort_order, rule_kind,
   first_off_dow, first_off_weeks, second_off_dow, second_off_weeks,
   offs_per_week)
SELECT c.id, v.code, v.name, v.descr, v.ord, v.kind,
       v.d1, v.w1, v.d2, v.w2, v.opw
FROM public.companies c,
     (VALUES
        ('WO-SUN',         'Sunday Off',
         'Office staff.',
         10, 'fixed_weekdays', 0::smallint, '{1,2,3,4,5}'::smallint[], NULL::smallint, NULL::smallint[], NULL::smallint),
        ('WO-SUN-ALTSAT',  'Sunday + Alternate Saturday',
         'Finance / HR.',
         20, 'fixed_weekdays', 0::smallint, '{1,2,3,4,5}'::smallint[], 6::smallint, '{2,4}'::smallint[], NULL::smallint),
        ('WO-MIDWEEK-TUE', 'Tuesday Off',
         'Operational default — Fri–Sun are peak event days.',
         30, 'fixed_weekdays', 2::smallint, '{1,2,3,4,5}'::smallint[], NULL::smallint, NULL::smallint[], NULL::smallint),
        ('WO-MIDWEEK-WED', 'Wednesday Off',
         NULL,
         40, 'fixed_weekdays', 3::smallint, '{1,2,3,4,5}'::smallint[], NULL::smallint, NULL::smallint[], NULL::smallint),
        ('WO-ROSTER',      'Roster Driven',
         'Banquet/Kitchen/Housekeeping/Security: the roster grants the off; the weekly validation job enforces the statutory minimum of one per week.',
         50, 'roster_driven', NULL::smallint, NULL::smallint[], NULL::smallint, NULL::smallint[], 1::smallint)
     ) AS v(code, name, descr, ord, kind, d1, w1, d2, w2, opw)
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (company_id, code) DO NOTHING;

COMMIT;
