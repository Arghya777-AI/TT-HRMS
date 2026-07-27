/**
 * LocationConsent — the geolocation ask, with the reason visible before the
 * browser's own dialog lands on top of it.
 *
 * `navigator.geolocation` is used NOWHERE ELSE in this app, so this component is
 * the entire user-facing contract for it:
 *   - it states WHY (security record of the sign-in, never attendance);
 *   - it states the LIMIT — only the face route can carry coordinates today,
 *     because `webauthn-login`'s and `auth-identify`'s request schemas are
 *     `.strict()` and password sign-in never touches an edge function;
 *   - a refusal renders as a settled, harmless state with sign-in unaffected.
 *
 * There is no "required" variant on purpose. A refused permission must not block
 * anyone from their payslip.
 */
import { Button } from "@/components/ui/button";
import { t } from "@/shared/i18n/en";
import type { SignInLocationStatus } from "../lib/geolocation";
import { AuthNotice, type AuthNoticeTone } from "./AuthNotice";

export interface LocationConsentProps {
  status: SignInLocationStatus;
  /** Browser-reported accuracy radius, shown so the user knows what was taken. */
  accuracyMetres: number | null;
  onShare: () => void;
}

function toneFor(status: SignInLocationStatus): AuthNoticeTone {
  switch (status) {
    case "granted":
      return "success";
    case "denied":
    case "unavailable":
    case "error":
      return "warning";
    case "idle":
    case "asking":
      return "info";
  }
}

function statusLine(status: SignInLocationStatus, accuracyMetres: number | null): string {
  switch (status) {
    case "idle":
      return t("auth.login.location.reason");
    case "asking":
      return t("auth.login.location.asking");
    case "granted":
      return t("auth.login.location.granted", { metres: accuracyMetres ?? 0 });
    case "denied":
      return t("auth.login.location.denied");
    case "unavailable":
      return t("auth.login.location.unavailable");
    case "error":
      return t("auth.login.location.error");
  }
}

export function LocationConsent({ status, accuracyMetres, onShare }: LocationConsentProps) {
  const canRetry = status === "idle" || status === "denied" || status === "error";
  return (
    <AuthNotice
      tone={toneFor(status)}
      action={
        canRetry ? (
          <Button type="button" variant="outline" size="sm" onClick={onShare}>
            {t("auth.login.location.share")}
          </Button>
        ) : undefined
      }
    >
      <p className="font-medium">{t("auth.login.location.title")}</p>
      <p className="text-muted-foreground">{statusLine(status, accuracyMetres)}</p>
      {status === "idle" ? null : (
        <p className="mt-1 text-xs text-muted-foreground">{t("auth.login.location.reason")}</p>
      )}
      <p className="mt-1 text-xs text-muted-foreground">{t("auth.login.location.scope")}</p>
    </AuthNotice>
  );
}
