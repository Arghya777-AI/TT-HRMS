/**
 * StepUpDialog — the MFA step-up moment (aal2).
 *
 * Some capabilities carry `requires_step_up = true` in `role_capabilities`
 * (migration 050): activating a face template, granting a role, rotating a
 * device secret. The edge functions enforce it server-side by refusing with
 * `MFA_STEP_UP_REQUIRED` when the session is aal1. This dialog is the client
 * half: ask for the six-digit authenticator code, verify it with Supabase
 * (`mfa.challengeAndVerify`, which upgrades the SESSION to aal2 for ~15 min),
 * then let the caller retry the refused action.
 *
 * Usage (imperative, promise-based — actions live in mutation callbacks):
 *
 *   const stepUp = useStepUp();
 *   ...
 *   const ok = await stepUp.ensureAal2();   // resolves false if dismissed
 *   if (ok) retryTheAction();
 *   ...
 *   {stepUp.dialog}
 *
 * `isStepUpRequired(error)` recognises the refusal in both transports: the
 * problem+json `code` from edge functions and the same string embedded in a
 * MutationError's message.
 */
import { useCallback, useMemo, useRef, useState } from "react";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/lib/supabase";
import { t } from "@/shared/i18n/en";

/**
 * BOTH refusals `requireStepUp()` can raise (`supabase/functions/_shared/auth.ts`):
 * `MFA_STEP_UP_REQUIRED` when the session is aal1, and `MFA_STEP_UP_STALE` when
 * the aal2 confirmation is older than `STEP_UP_MAX_AGE_SECONDS` (15 minutes).
 *
 * They MUST both be recognised here. The remedy is identical for each —
 * `mfa.challengeAndVerify` re-stamps the `amr` timestamp the server measures the
 * age against — and treating STALE as an ordinary failure is worse than useless:
 * the caller re-throws without ever opening this dialog, so an admin sixteen
 * minutes into a session gets a dead end with no way to re-verify, and
 * `EnrolCapture` silently discards a finished five-pose biometric capture.
 */
const STEP_UP_CODES: readonly string[] = ["MFA_STEP_UP_REQUIRED", "MFA_STEP_UP_STALE"];

/** True when a thrown value is either of the server's step-up refusals. */
export function isStepUpRequired(error: unknown): boolean {
  if (error === null || typeof error !== "object") return false;
  const rec = error as Record<string, unknown>;
  const code = rec["code"];
  if (typeof code === "string" && STEP_UP_CODES.includes(code)) return true;
  const problem = rec["problem"] as Record<string, unknown> | undefined;
  const problemCode = problem?.["code"];
  if (typeof problemCode === "string" && STEP_UP_CODES.includes(problemCode)) return true;
  const message = rec["message"];
  return typeof message === "string" && STEP_UP_CODES.some((c) => message.includes(c));
}

export interface StepUpHandle {
  /** Opens the dialog and resolves true once the session is aal2. */
  ensureAal2: () => Promise<boolean>;
  /** Render this once near the page root. */
  dialog: React.ReactNode;
}

export function useStepUp(): StepUpHandle {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const ensureAal2 = useCallback((): Promise<boolean> => {
    setCode("");
    setError(null);
    setOpen(true);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const finish = useCallback((ok: boolean) => {
    setOpen(false);
    setBusy(false);
    resolver.current?.(ok);
    resolver.current = null;
  }, []);

  const verify = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const { data: factors, error: listError } = await supabase.auth.mfa.listFactors();
      if (listError !== null) throw listError;
      const totp = factors.totp[0];
      if (totp === undefined) {
        setError(t("stepUp.noFactor"));
        setBusy(false);
        return;
      }
      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
        factorId: totp.id,
        code: code.trim(),
      });
      if (verifyError !== null) {
        setError(t("stepUp.wrongCode"));
        setBusy(false);
        return;
      }
      finish(true);
    } catch {
      setError(t("stepUp.failed"));
      setBusy(false);
    }
  }, [code, finish]);

  const dialog = useMemo(
    () => (
      <AlertDialog.Root open={open}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
          <AlertDialog.Content
            className={cn(
              "fixed left-1/2 top-1/2 z-50 grid w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 gap-4",
              "rounded-lg border bg-background p-5 shadow-lg sm:p-6",
            )}
            onEscapeKeyDown={() => finish(false)}
          >
            <AlertDialog.Title className="font-display text-lg font-semibold">
              {t("stepUp.title")}
            </AlertDialog.Title>
            <AlertDialog.Description className="text-sm text-muted-foreground">
              {t("stepUp.description")}
            </AlertDialog.Description>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="000000"
            className="num text-center font-display text-2xl tracking-[0.4em]"
            aria-label={t("stepUp.codeLabel")}
          />
          {error !== null ? (
            <p className="text-sm font-medium text-destructive" role="alert">
              {error}
            </p>
          ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" disabled={busy} onClick={() => finish(false)}>
                {t("stepUp.cancel")}
              </Button>
              <Button disabled={busy || code.length !== 6} onClick={() => void verify()}>
                {busy ? t("stepUp.verifying") : t("stepUp.confirm")}
              </Button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    ),
    [open, code, busy, error, finish, verify],
  );

  return { ensureAal2, dialog };
}
