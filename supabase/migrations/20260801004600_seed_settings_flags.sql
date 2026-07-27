-- =============================================================================
-- Migration 046 — seed: settings (~45 rows), feature flags (9), integrations
-- registry (7), asset categories (15), kiosk device TT-GATE-01.
-- Source: docs/plan/04-data-model.md §14.11, §3.12, §3.16;
--         spec-migrations §6.14.
--
-- Notes:
--  * Every settings row is scope='company' + company_id=TT so the unique
--    index (company_id, key, scope, coalesce(scope_id, zero-uuid)) makes the
--    seed idempotent (a NULL company_id would never conflict on re-run).
--  * seed_demo_data = false: 047 is a no-op unless this is flipped to true
--    (never in production). is_editable_by_admin = false → super-admin only.
--  * Kiosk TT-GATE-01: allowed_geofence left NULL — venue lat/lng are
--    captured on site (Appendix B8); geofence_ok is recorded, not enforced,
--    until then. Its HMAC secret is generated at provisioning time by the
--    admin-api-keys edge function and shown once (never stored here).
-- =============================================================================

BEGIN;

-- Reason/source context for audit.log_changes(): tables in
-- audit.reason_required_tables demand a reason on UPDATE, and every audit row
-- this seed writes should say where it came from.
SELECT set_config('app.reason', 'seed 046: settings, feature flags, integrations and kiosk device', true);
SELECT set_config('app.source', 'migration', true);

-- -----------------------------------------------------------------------------
-- 1. Settings (§3.16 keys, §14.11 values)
-- -----------------------------------------------------------------------------
INSERT INTO public.settings
  (company_id, key, value, value_kind, scope, group_name, label,
   is_sensitive, is_editable_by_admin)
SELECT c.id, v.key, v.value::jsonb, v.kind, 'company', v.grp, v.label,
       v.sensitive, v.editable
FROM public.companies c
CROSS JOIN (VALUES
  -- attendance
  ('attendance.ist_day_cutover_time',      '"05:00"', 'time',    'attendance',    'IST day cutover time',                       false, false),
  ('attendance.absent_marking_hour',       '11',      'number',  'attendance',    'Absent marking hour (IST, cutover + 6 h)',   false, true),
  ('attendance.week_start_dow',            '1',       'number',  'attendance',    'Week start day (0 = Sunday)',                false, true),
  ('attendance.no_show_alert_minutes',     '60',      'number',  'attendance',    'No-show alert after shift start (minutes)',  false, true),
  -- kiosk
  ('kiosk.min_confidence',                 '0.62',    'number',  'kiosk',         'Face match: minimum confidence',             false, false),
  ('kiosk.min_margin',                     '0.06',    'number',  'kiosk',         'Face match: minimum runner-up margin',       false, false),
  ('kiosk.debounce_seconds',               '120',     'number',  'kiosk',         'Duplicate punch debounce (seconds)',         false, true),
  ('kiosk.retain_punch_photos_days',       '180',     'number',  'kiosk',         'Punch photo retention (days)',               false, false),
  ('kiosk.require_liveness',               'true',    'boolean', 'kiosk',         'Require liveness check',                     false, false),
  ('kiosk.offline_queue_max',              '500',     'number',  'kiosk',         'Maximum offline punch queue',                false, true),
  ('kiosk.heartbeat_interval_seconds',     '60',      'number',  'kiosk',         'Device heartbeat interval (seconds)',        false, true),
  ('kiosk.offline_alert_minutes',          '10',      'number',  'kiosk',         'Alert when kiosk offline for (minutes)',     false, true),
  ('kiosk.punch_photo_url_ttl_seconds',    '60',      'number',  'kiosk',         'Signed URL TTL for punch photos (seconds)',  false, false),
  -- payroll
  ('payroll.two_person_approval',          'true',    'boolean', 'payroll',       'Two-person payroll approval',                false, false),
  ('payroll.variance_alert_pct',           '10',      'number',  'payroll',       'Variance threshold blocking approval (%)',   false, true),
  ('payroll.minimum_wage_enforcement',     'true',    'boolean', 'payroll',       'Block runs below Karnataka minimum wage',    false, false),
  ('payroll.payslip_url_ttl_seconds',      '900',     'number',  'payroll',       'Signed URL TTL for payslips (seconds)',      false, false),
  ('payroll.pay_day_rule',                 '"last_day_of_period_month"', 'string', 'payroll', 'Pay date rule',                  false, true),
  -- leave
  ('leave.year_start_month',               '4',       'number',  'leave',         'Leave year start month (April)',             false, false),
  ('leave.comp_off_expiry_days',           '90',      'number',  'leave',         'Comp-off expiry (days)',                     false, true),
  ('leave.allow_negative_balance',         'false',   'boolean', 'leave',         'Allow negative leave balances',              false, true),
  ('leave.el_encashment_on_exit',          'true',    'boolean', 'leave',         'Encash EL balance on exit',                  false, true),
  -- notifications
  ('notifications.quiet_hours_start',      '"22:00"', 'time',    'notifications', 'Quiet hours start',                          false, true),
  ('notifications.quiet_hours_end',        '"07:00"', 'time',    'notifications', 'Quiet hours end',                            false, true),
  ('notifications.digest_hour_ist',        '9',       'number',  'notifications', 'Daily digest hour (IST)',                    false, true),
  ('notifications.sms_enabled',            'false',   'boolean', 'notifications', 'SMS channel enabled (needs DLT templates)',  false, true),
  -- security
  ('security.session_idle_minutes',        '30',      'number',  'security',      'Session idle timeout (minutes)',             false, false),
  ('security.reveal_reason_min_length',    '10',      'number',  'security',      'Minimum reason length for reveals',          false, false),
  ('security.password_min_length',         '12',      'number',  'security',      'Minimum password length',                    false, false),
  ('security.mfa_required_for_admins',     'true',    'boolean', 'security',      'MFA required for admin roles',               false, false),
  ('security.signed_url_default_ttl_seconds', '300',  'number',  'security',      'Default signed URL TTL (seconds)',           false, false),
  ('security.export_retention_days',       '90',      'number',  'security',      'Export file retention (days)',               false, true),
  ('security.failed_login_lockout_threshold', '10',   'number',  'security',      'Failed logins before lockout',               false, false),
  ('security.employee_self_editable_fields',
   '["about","photo_path","cover_photo_path","food_preference"]',
                                                      'json',    'security',      'Employee self-editable fields (B14)',        false, false),
  -- ai
  ('ai.monthly_budget_inr',                '15000',   'money',   'ai',            'AI monthly budget (INR)',                    false, true),
  ('ai.provider',                          '"anthropic"', 'string', 'ai',         'AI provider',                                false, false),
  ('ai.employee_scope_enabled',            'false',   'boolean', 'ai',            'AI agent: employee scope enabled',           false, true),
  ('ai.context_views_only',                'true',    'boolean', 'ai',            'AI reads v_ai_context_* views only (B15)',   false, false),
  -- branding
  ('branding.primary_hex',                 '"#CE8F6F"', 'string', 'branding',     'Brand primary (tamarind)',                   false, true),
  ('branding.secondary_hex',               '"#B99665"', 'string', 'branding',     'Brand secondary (gold)',                     false, true),
  ('branding.plum_hex',                    '"#564147"', 'string', 'branding',     'Brand plum',                                 false, true),
  ('branding.navy_hex',                    '"#121F38"', 'string', 'branding',     'Brand navy',                                 false, true),
  ('branding.display_name',                '"The Tamarind Tree"', 'string', 'branding', 'Display name',                         false, true),
  ('branding.logo_path',                   '"logo/tamarind-tree.png"', 'string', 'branding', 'Logo path in brand bucket',       false, true),
  -- system
  ('seed_demo_data',                       'false',   'boolean', 'system',        'Apply demo seed (047) — never in production', false, false)
) AS v(key, value, kind, grp, label, sensitive, editable)
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (company_id, key, scope,
             coalesce(scope_id, '00000000-0000-0000-0000-000000000000'::uuid))
DO NOTHING;

-- -----------------------------------------------------------------------------
-- 2. Feature flags (§14.11) — every flag expires; nothing becomes permanent
--    scaffolding. All off at seed; go-live flips them deliberately.
-- -----------------------------------------------------------------------------
INSERT INTO public.feature_flags
  (key, name, description, is_enabled, rollout_pct, owner, expires_at)
SELECT v.key, v.name, v.descr, false, 0, 'platform', v.expires
FROM (VALUES
        ('kiosk_fingerprint_fallback', 'Kiosk fingerprint fallback',
         'WebAuthn fingerprint punch when face match is unavailable.',
         TIMESTAMPTZ '2027-04-01 00:00:00+05:30'),
        ('mobile_selfie_punch',        'Mobile selfie punch',
         'Geofenced selfie punch from the employee''s own phone.',
         TIMESTAMPTZ '2027-04-01 00:00:00+05:30'),
        ('ai_agent_admin_scope',       'AI agent — admin scope',
         'Admin-scoped AI assistant over v_ai_context_* views.',
         TIMESTAMPTZ '2027-04-01 00:00:00+05:30'),
        ('ai_agent_employee_scope',    'AI agent — employee scope',
         'Employee-scoped AI assistant (own data only).',
         TIMESTAMPTZ '2027-04-01 00:00:00+05:30'),
        ('roster_auto_suggest',        'Roster auto-suggest',
         'Suggested slots from history + event bookings.',
         TIMESTAMPTZ '2027-04-01 00:00:00+05:30'),
        ('payroll_auto_run',           'Payroll auto-run',
         'Scheduled compute of the draft payroll run at cutoff.',
         TIMESTAMPTZ '2027-04-01 00:00:00+05:30'),
        ('go_social',                  'Go Social',
         'Noticeboard reactions, celebrations and kudos.',
         TIMESTAMPTZ '2027-04-01 00:00:00+05:30'),
        ('help_desk',                  'Help desk',
         'HR ticketing module.',
         TIMESTAMPTZ '2027-04-01 00:00:00+05:30'),
        ('income_tax_module',          'Income tax module',
         'Employee IT declarations, proofs and regime comparison.',
         TIMESTAMPTZ '2027-04-01 00:00:00+05:30')
     ) AS v(key, name, descr, expires)
ON CONFLICT (key) WHERE (deleted_at IS NULL) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 3. Integrations registry (§3.16). config carries secret NAMES only — the
--    values live in Supabase Function secrets, never in the database.
-- -----------------------------------------------------------------------------
INSERT INTO public.integrations
  (code, name, kind, is_enabled, config, base_url, webhook_secret_name,
   rate_limit_per_min)
SELECT v.code, v.name, v.kind, v.enabled, v.config::jsonb, v.base_url,
       v.webhook_secret, v.rate_limit
FROM (VALUES
        ('resend',          'Resend (transactional email)', 'email',
         true,  '{"api_key_secret": "RESEND_API_KEY"}',
         'https://api.resend.com',    'RESEND_WEBHOOK_SECRET', 120),
        ('anthropic',       'Anthropic (AI agent)',         'ai',
         true,  '{"api_key_secret": "ANTHROPIC_API_KEY"}',
         'https://api.anthropic.com', NULL,                    60),
        ('msg91',           'MSG91 (SMS, DLT)',             'sms',
         false, '{"api_key_secret": "MSG91_AUTH_KEY"}',
         'https://api.msg91.com',     'MSG91_WEBHOOK_SECRET',  60),
        ('zkteco_bridge',   'ZKTeco device bridge',         'biometric_device',
         false, '{"shared_secret_name": "ZKTECO_BRIDGE_SECRET"}',
         NULL,                        NULL,                    NULL::integer),
        ('razorpayx',       'RazorpayX (bank payouts)',     'banking',
         false, '{"api_key_secret": "RAZORPAYX_API_KEY"}',
         'https://api.razorpay.com',  'RAZORPAYX_WEBHOOK_SECRET', 60),
        ('tally',           'Tally (accounting export)',    'accounting',
         false, '{"bridge_token_secret": "TALLY_BRIDGE_TOKEN"}',
         NULL,                        NULL,                    NULL::integer),
        ('google_calendar', 'Google Calendar (events)',     'calendar',
         false, '{"client_secret_name": "GOOGLE_OAUTH_CLIENT_SECRET"}',
         'https://www.googleapis.com', NULL,                   NULL::integer)
     ) AS v(code, name, kind, enabled, config, base_url, webhook_secret, rate_limit)
ON CONFLICT (code) WHERE (deleted_at IS NULL) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 4. Asset categories (§3.12) — the 15 venue categories.
-- -----------------------------------------------------------------------------
INSERT INTO public.asset_categories
  (company_id, code, name, sort_order, is_consumable, default_return_required,
   requires_serial, requires_acknowledgement)
SELECT c.id, v.code, v.name, v.ord, v.consumable, v.return_req, v.serial, v.ack
FROM public.companies c
CROSS JOIN (VALUES
        ('UNIFORM',       'Uniforms',                  10, true,  false, false, false),
        ('CHEF-KNIFE',    'Chef Knives',               20, false, true,  false, true),
        ('WALKIE',        'Walkie-Talkies',            30, false, true,  true,  true),
        ('ACCESS-CARD',   'Access Cards',              40, false, true,  true,  true),
        ('MOBILE',        'Mobile Phones',             50, false, true,  true,  true),
        ('LAPTOP',        'Laptops',                   60, false, true,  true,  true),
        ('TABLET',        'Tablets (kiosk devices)',   70, false, true,  true,  true),
        ('KEYS',          'Keys',                      80, false, true,  false, true),
        ('TOOLKIT',       'Tool Kits',                 90, false, true,  false, true),
        ('SAFETY-SHOES',  'Safety Shoes',             100, true,  false, false, false),
        ('PPE',           'PPE',                      110, true,  false, false, false),
        ('GARDEN-EQUIP',  'Gardening Equipment',      120, false, true,  false, false),
        ('TROLLEY',       'Serving Trolleys',         130, false, true,  false, false),
        ('SOUND',         'Sound Equipment',          140, false, true,  true,  true),
        ('VEHICLE-KEYS',  'Vehicle Keys',             150, false, true,  false, true)
     ) AS v(code, name, ord, consumable, return_req, serial, ack)
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (company_id, code) WHERE (deleted_at IS NULL) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 5. Kiosk device TT-GATE-01 (§14.11).
-- -----------------------------------------------------------------------------
INSERT INTO public.kiosk_devices
  (device_code, label, location_id, device_kind, require_operator,
   min_match_confidence, allowed_geofence)
SELECT 'TT-GATE-01', 'Main Gate — Guard Post', l.id, 'tablet_camera', true,
       0.62, NULL
FROM public.companies c
JOIN public.locations l
  ON l.company_id = c.id AND l.code = 'TTT-VENUE' AND l.deleted_at IS NULL
WHERE c.code = 'TT' AND c.deleted_at IS NULL
ON CONFLICT (device_code) WHERE (deleted_at IS NULL) DO NOTHING;

COMMIT;
