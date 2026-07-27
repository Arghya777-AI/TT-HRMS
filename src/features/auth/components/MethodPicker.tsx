/**
 * MethodPicker — step 2 of sign-in: which credential, stated with its strength.
 *
 * Order is the security order, strongest first, and each option carries a badge
 * that says where it sits. That ordering is the whole point: the screen nudges
 * toward the passkey, keeps the password permanently available, and offers face
 * last with "convenience" written on it rather than hiding the trade-off in a
 * help article.
 *
 * An option that cannot work on this device is not rendered as a dead button —
 * it is replaced by one line saying why (no WebAuthn, no passkey registered, no
 * camera). Password is never conditional and never removed.
 */
import type { ComponentType } from "react";
import { Fingerprint, KeyRound, Loader2, ScanFace } from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import type { SignInMethod } from "../api/signin.api";
import type { PasskeyCapability } from "../lib/passkeySupport";
import { AuthNotice } from "./AuthNotice";

export interface MethodPickerProps {
  /** `auth-identify` said this account has at least one login passkey. */
  hasPasskey: boolean;
  passkey: PasskeyCapability;
  cameraAvailable: boolean;
  /** The method currently being attempted, so the row can show a spinner. */
  busyMethod: SignInMethod | null;
  disabled: boolean;
  onPick: (method: SignInMethod) => void;
}

interface OptionProps {
  icon: ComponentType<{ className?: string }>;
  label: string;
  badge: string;
  badgeClass: string;
  hint: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}

function Option({
  icon: Icon,
  label,
  badge,
  badgeClass,
  hint,
  busy,
  disabled,
  onClick,
}: OptionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full items-start gap-3 rounded-lg border bg-card px-3 py-3 text-left transition-colors",
        "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-60",
      )}
    >
      <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-md border bg-background">
        {busy ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : (
          <Icon className="size-4" aria-hidden />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{label}</span>
          <span
            className={cn(
              "rounded-full border px-1.5 py-0.5 text-[0.65rem] font-medium uppercase tracking-wide",
              badgeClass,
            )}
          >
            {badge}
          </span>
        </span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{hint}</span>
      </span>
    </button>
  );
}

export function MethodPicker({
  hasPasskey,
  passkey,
  cameraAvailable,
  busyMethod,
  disabled,
  onPick,
}: MethodPickerProps) {
  const showPasskey = hasPasskey && passkey.supported;
  return (
    <div className="space-y-3">
      <div>
        <h2 className="font-display text-sm font-semibold">{t("auth.login.chooseTitle")}</h2>
        <p className="mt-0.5 text-xs text-muted-foreground">{t("auth.login.chooseHint")}</p>
      </div>

      <div className="space-y-2">
        {showPasskey ? (
          <Option
            icon={Fingerprint}
            label={t("auth.login.passkey.button")}
            badge={t("auth.login.passkey.badge")}
            badgeClass="border-success/50 text-success"
            hint={
              passkey.platform
                ? t("auth.login.passkey.hintPlatform")
                : t("auth.login.passkey.hintRoaming")
            }
            busy={busyMethod === "passkey"}
            disabled={disabled}
            onClick={() => onPick("passkey")}
          />
        ) : null}

        <Option
          icon={KeyRound}
          label={t("auth.login.password.button")}
          badge={t("auth.login.password.badge")}
          badgeClass="border-info/50 text-info"
          hint={t("auth.login.password.hint")}
          busy={busyMethod === "password"}
          disabled={disabled}
          onClick={() => onPick("password")}
        />

        {cameraAvailable ? (
          <Option
            icon={ScanFace}
            label={t("auth.login.face.button")}
            badge={t("auth.login.face.badge")}
            badgeClass="border-warning/50 text-warning"
            hint={t("auth.login.face.hint")}
            busy={busyMethod === "face"}
            disabled={disabled}
            onClick={() => onPick("face")}
          />
        ) : null}
      </div>

      {/* Why an option is missing, rather than a button that cannot work. */}
      <div className="space-y-1 text-xs text-muted-foreground">
        {!passkey.supported && passkey.checked ? <p>{t("auth.login.passkey.unsupported")}</p> : null}
        {passkey.supported && !hasPasskey ? <p>{t("auth.login.passkey.notEnrolled")}</p> : null}
        {!cameraAvailable ? <p>{t("auth.login.face.unsupported")}</p> : null}
      </div>

      <AuthNotice tone="security">
        <p className="font-medium">{t("auth.login.security.title")}</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-muted-foreground">
          <li>{t("auth.login.security.passkeyLine")}</li>
          <li>{t("auth.login.security.passwordLine")}</li>
          <li>{t("auth.login.security.faceLine")}</li>
        </ul>
        <p className="mt-1.5 text-xs text-muted-foreground">{t("auth.login.security.audit")}</p>
      </AuthNotice>
    </div>
  );
}
