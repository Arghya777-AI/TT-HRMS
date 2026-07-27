/**
 * ResetPassword — E-01.5. Waits for Supabase to verify the recovery link
 * (PASSWORD_RECOVERY event) before allowing a new password, then revokes every
 * OTHER session so a stolen link cannot keep a foothold.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/lib/supabase";
import { passwordIssues } from "@/shared/auth/password";
import { t } from "@/shared/i18n/en";
import { AuthLayout } from "./AuthLayout";

export default function ResetPassword() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // The recovery link may already have been exchanged before this mounts.
    void supabase.auth.getSession().then(({ data }) => {
      if (data.session) setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY" || event === "SIGNED_IN") setReady(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const issues = password.length > 0 ? passwordIssues(password) : [];
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit = ready && password.length > 0 && issues.length === 0 && !mismatch;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) {
        toast.error(error.message);
        return;
      }
      await supabase.auth.signOut({ scope: "others" });
      toast.success(t("auth.reset.success"));
      navigate("/login", { replace: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout title={t("auth.reset.title")} description={t("auth.password.policy")}>
      {!ready ? (
        <p className="text-sm text-muted-foreground">{t("auth.reset.waiting")}</p>
      ) : (
        <form onSubmit={onSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="password">{t("auth.reset.newPassword")}</Label>
            <Input
              id="password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            {issues.length > 0 ? (
              <ul className="space-y-0.5 text-xs text-destructive">
                {issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirm">{t("auth.reset.confirmPassword")}</Label>
            <Input
              id="confirm"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
            />
            {mismatch ? <p className="text-xs text-destructive">Passwords don&apos;t match.</p> : null}
          </div>

          <Button type="submit" className="w-full" disabled={!canSubmit || busy}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {t("auth.reset.submit")}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
