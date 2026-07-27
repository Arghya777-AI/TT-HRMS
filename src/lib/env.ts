/**
 * Typed access to the client-side environment. Only VITE_-prefixed values are
 * available in the browser bundle; never a service-role or Anthropic key.
 */
function required(name: keyof ImportMetaEnv, value: string | undefined): string {
  if (!value || value.trim() === "") {
    throw new Error(`Missing required env var ${name}. Copy .env.example to .env.local and fill it in.`);
  }
  return value;
}

export const env = {
  supabaseUrl: required("VITE_SUPABASE_URL", import.meta.env.VITE_SUPABASE_URL),
  supabasePublishableKey: required("VITE_SUPABASE_PUBLISHABLE_KEY", import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY),
  appName: import.meta.env.VITE_APP_NAME || "Tamarind Tree HRMS",
  timezone: import.meta.env.VITE_APP_TIMEZONE || "Asia/Kolkata",
} as const;
