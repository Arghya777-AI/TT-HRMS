-- ============================================================================
-- Supabase local-validation shim for vanilla PostgreSQL 17
-- Recreates just enough of the hosted-Supabase surface (roles, auth schema,
-- storage schema, realtime publication) for the HRMS migrations to execute.
-- NEVER applied to a real Supabase project.
-- ============================================================================

-- ---- Roles ------------------------------------------------------------------
DO $$ BEGIN CREATE ROLE anon NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE supabase_admin NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticator NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- ---- auth schema -------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS auth.users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aud                 text,
  role                text,
  email               text UNIQUE,
  phone               text,
  encrypted_password  text,
  email_confirmed_at  timestamptz,
  phone_confirmed_at  timestamptz,
  last_sign_in_at     timestamptz,
  raw_app_meta_data   jsonb DEFAULT '{}'::jsonb,
  raw_user_meta_data  jsonb DEFAULT '{}'::jsonb,
  is_super_admin      boolean,
  banned_until        timestamptz,
  deleted_at          timestamptz,
  is_sso_user         boolean DEFAULT false,
  is_anonymous        boolean DEFAULT false,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    '{}'::jsonb
  )
$$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    'anon'
  )
$$;

-- ---- storage schema -----------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS storage;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;

CREATE TABLE IF NOT EXISTS storage.buckets (
  id                 text PRIMARY KEY,
  name               text NOT NULL,
  owner              uuid,
  public             boolean DEFAULT false,
  avif_autodetection boolean DEFAULT false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz DEFAULT now(),
  updated_at         timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id        text REFERENCES storage.buckets (id),
  name             text,
  owner            uuid,
  owner_id         text,
  version          text,
  metadata         jsonb,
  user_metadata    jsonb,
  path_tokens      text[] GENERATED ALWAYS AS (string_to_array(name, '/')) STORED,
  created_at       timestamptz DEFAULT now(),
  updated_at       timestamptz DEFAULT now(),
  last_accessed_at timestamptz DEFAULT now()
);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT (string_to_array(name, '/'))[1 : array_length(string_to_array(name, '/'), 1) - 1]
$$;

CREATE OR REPLACE FUNCTION storage.filename(name text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT (string_to_array(name, '/'))[array_length(string_to_array(name, '/'), 1)]
$$;

CREATE OR REPLACE FUNCTION storage.extension(name text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT reverse(split_part(reverse(name), '.', 1))
$$;

GRANT ALL ON storage.buckets, storage.objects TO service_role;
GRANT SELECT ON storage.buckets, storage.objects TO anon, authenticated;

-- ---- realtime -----------------------------------------------------------------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END $$;

-- ---- misc schemas Supabase pre-creates -----------------------------------------
CREATE SCHEMA IF NOT EXISTS graphql_public;
CREATE SCHEMA IF NOT EXISTS extensions;
