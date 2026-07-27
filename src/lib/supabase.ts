import { createClient } from "@supabase/supabase-js";
import { env } from "./env";
// import type { Database } from "@/types/database"; // generated after first migration

/**
 * Browser Supabase client. Uses the publishable (anon) key only — every read and
 * write is governed by RLS. Privileged operations (kiosk punch, payroll, imports,
 * audit export) go through Edge Functions that hold the service role server-side.
 */
export const supabase = createClient(env.supabaseUrl, env.supabasePublishableKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    storageKey: "tt-hrms-auth",
    flowType: "pkce",
  },
  global: {
    headers: { "x-application-name": "tamarind-tree-hrms" },
  },
});
