/**
 * ForgotPassword — E-01.4. Always shows the same success copy regardless of
 * whether the address exists (anti-enumeration).
 */
import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase";
import { t } from "@/shared/i18n/en";
import { AuthLayout } from "./AuthLayout";

export default function ForgotPassword() {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: `${window.location.origin}/reset-password`,
      });
    } finally {
      // Identical outcome either way — never confirm existence.
      setBusy(false);
      setSent(true);
      toast.success(t("auth.forgot.sent"));
    }
  }

  return (
    <AuthLayout
      title={t("auth.forgot.title")}
      description={t("auth.forgot.hint")}
      footer={<Link to="/login" className="underline-offset-4 hover:underline">{t("auth.login.back")}</Link>}
    >
      {sent ? (
        <p className="text-sm text-muted-foreground">{t("auth.forgot.sent")}</p>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">{t("auth.login.identifier")}</Label>
            <Input
              id="email"
              name="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {t("auth.forgot.submit")}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
