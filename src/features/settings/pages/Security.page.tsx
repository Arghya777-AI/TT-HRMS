/**
 * E-18.2 · /me/settings/security — the account, for real.
 *
 * Everything on this page does what it says:
 *
 *  * PASSWORD writes through `supabase.auth.updateUser`. The policy shown is the
 *    shared one (`@/shared/auth/password`), and the "not one of your last three"
 *    rule is named as server-enforced because the client cannot know password
 *    history. Rotating the password signs every OTHER session out by default —
 *    a password change that leaves the old sessions alive has not changed much.
 *  * AUTHENTICATOR enrolment is the genuine three-step GoTrue flow: `enroll`
 *    returns a QR (rendered from the SVG the server sent) AND the typed secret
 *    for a phone that cannot scan; `challengeAndVerify` promotes the factor to
 *    verified and lifts this session to aal2. Abandoning the dialog UNENROLS the
 *    half-made factor, because GoTrue creates it on `enroll`, not on `verify` —
 *    otherwise a cancelled attempt leaves dead "unverified" factors behind.
 *  * PASSKEYS are listed from `webauthn_credentials`, which grants SELECT only:
 *    the `webauthn-register` edge function is the only thing that may write one,
 *    so this screen lists them and says where registration happens rather than
 *    offering a button that cannot work.
 *  * FACE state is read from `v_my_biometric_status` and my own
 *    `face_enrolment_requests`. A missing consent row is shown as "no consent
 *    recorded", never as "not enrolled" — the view selects FROM the consent
 *    table, so absence of consent hides the template state as well.
 *  * SWIPE CARDS come from the profile domain's existing `useSwipeCards`, so this
 *    page and /me/profile/employment cannot disagree about the same card.
 *  * SIGN-IN ACTIVITY is `sessions_audit`, filtered to my own profile id (the
 *    table carries an admin read policy too, and an HR administrator's own
 *    security page must not list the company's sign-ins). It is written by the
 *    service-role paths only, which the card states, because a short list here
 *    does not mean you signed in rarely. The rows are rendered by the shared
 *    `SignInTrail` (../signin) rather than a grid of raw column values, so this
 *    card and /me/activity describe the same event with the same sentence, name
 *    the same device the same way, and agree about which rows deserve a note.
 *
 * @route /me/settings/security
 */
import { useCallback, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import {
  CreditCard,
  Fingerprint,
  KeyRound,
  Loader2,
  MonitorSmartphone,
  ScanFace,
  ShieldCheck,
  Smartphone,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { FaceLoginSwitch } from "@/shared/ui/FaceLoginSwitch";
import { useFaceLoginAccess } from "../hooks/useFaceLogin";
import { Notice } from "@/features/admin/components/Notice";
import { useSwipeCards } from "@/features/profile/hooks/useProfile";
import type { SwipeCard } from "@/features/profile/api/employment.api";
import { passwordIssues } from "@/shared/auth/password";
import { useAuth } from "@/app/auth/AuthProvider";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { dash } from "@/lib/format";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import {
  AuthActionError,
  qrSvgToDataUrl,
  type Passkey,
  type TotpEnrolment,
} from "../api/security.api";
import {
  useAssuranceLevel,
  useChangePassword,
  useEnrolTotp,
  useMfaFactors,
  useMyBiometricStatus,
  useMyFaceEnrolmentRequests,
  useMyPasskeys,
  useSignOutOtherSessions,
  useUnenrolFactor,
  useVerifyTotp,
} from "../hooks/useMeSettings";
import { useMySignInTrail } from "../hooks/useSignInActivity";
import { buildSignInTrail } from "../signin/analysis";
import { SignInTrail } from "../signin/SignInTrail";

const ISSUER = "Tamarind Tree HRMS";

/** How many of the newest auth events this card shows before /me/activity takes over. */
const RECENT_SIGNIN_COUNT = 6;

const CARD_STATUS_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  requested: { label: t("security.card.requested"), tone: "warn" },
  approved: { label: t("security.card.approved"), tone: "info" },
  active: { label: t("security.card.active"), tone: "success" },
  lost: { label: t("security.card.lost"), tone: "danger" },
  reported_lost: { label: t("security.card.reportedLost"), tone: "danger" },
  damaged: { label: t("security.card.damaged"), tone: "danger" },
  returned: { label: t("security.card.returned"), tone: "neutral" },
  revoked: { label: t("security.card.revoked"), tone: "danger" },
};

const ENROLMENT_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  pending: { label: t("security.face.pending"), tone: "warn" },
  approved: { label: t("security.face.approved"), tone: "success" },
  rejected: { label: t("security.face.rejected"), tone: "danger" },
  cancelled: { label: t("security.face.cancelled"), tone: "neutral" },
};

function errorMessageOf(error: unknown, fallback: string): string {
  if (error instanceof AuthActionError) return error.message;
  if (error instanceof Error && error.message !== "") return error.message;
  return fallback;
}

/* ── Password ─────────────────────────────────────────────────────────────── */

function PasswordCard() {
  const auth = useAuth();
  const change = useChangePassword();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [signOutOthers, setSignOutOthers] = useState(true);
  const [done, setDone] = useState(false);

  const issues =
    password.length > 0
      ? passwordIssues(password, {
          employeeCode: auth.employee?.employeeCode ?? null,
          firstName: auth.employee?.displayName?.split(" ")[0] ?? null,
        })
      : [];
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit = password.length > 0 && issues.length === 0 && !mismatch && !change.isPending;

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSubmit) return;
    setDone(false);
    change.mutate(
      { password, signOutOthers },
      {
        onSuccess: () => {
          setPassword("");
          setConfirm("");
          setDone(true);
        },
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <KeyRound className="size-4 text-primary" aria-hidden />
          {t("security.password.title")}
        </CardTitle>
        <CardDescription>{t("security.password.hint")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {done ? <Notice tone="success">{t("security.password.done")}</Notice> : null}
        {change.isError ? (
          <Notice tone="error">
            {errorMessageOf(change.error, t("security.password.failed"))}
          </Notice>
        ) : null}

        <form onSubmit={onSubmit} className="grid gap-4 sm:max-w-md">
          <div className="space-y-2">
            <Label htmlFor="new-password">{t("security.password.new")}</Label>
            <Input
              id="new-password"
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {issues.length > 0 ? (
              <ul className="space-y-0.5 text-xs text-destructive">
                {issues.map((issue) => (
                  <li key={issue}>{issue}</li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">{t("security.password.policy")}</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="confirm-password">{t("security.password.confirm")}</Label>
            <Input
              id="confirm-password"
              type="password"
              autoComplete="new-password"
              value={confirm}
              onChange={(event) => setConfirm(event.target.value)}
            />
            {mismatch ? (
              <p className="text-xs text-destructive">{t("security.password.mismatch")}</p>
            ) : null}
          </div>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5 size-4 rounded border-input"
              checked={signOutOthers}
              onChange={(event) => setSignOutOthers(event.target.checked)}
            />
            <span>
              {t("security.password.signOutOthers")}
              <span className="block text-xs text-muted-foreground">
                {t("security.password.signOutOthersHint")}
              </span>
            </span>
          </label>

          <div>
            <Button type="submit" disabled={!canSubmit}>
              {change.isPending ? (
                <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
              ) : null}
              {t("security.password.submit")}
            </Button>
          </div>
        </form>

        <p className="text-xs text-muted-foreground">{t("security.password.historyNote")}</p>
      </CardContent>
    </Card>
  );
}

/* ── Authenticator (TOTP) ─────────────────────────────────────────────────── */

function AuthenticatorCard() {
  const factors = useMfaFactors();
  const aal = useAssuranceLevel();
  const enrol = useEnrolTotp();
  const verify = useVerifyTotp();
  const unenrol = useUnenrolFactor();

  const [pending, setPending] = useState<TotpEnrolment | null>(null);
  const [code, setCode] = useState("");
  const [verified, setVerified] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);

  const rows = factors.data ?? [];
  const totp = rows.filter((factor) => factor.factor_type === "totp");

  const startEnrolment = useCallback(() => {
    setVerified(false);
    setCode("");
    enrol.mutate(
      { friendlyName: t("security.mfa.defaultName"), issuer: ISSUER },
      { onSuccess: (data) => setPending(data) },
    );
  }, [enrol]);

  /**
   * Abandoning the dialog must remove the factor: `enroll` already created it in
   * an `unverified` state, and leaving it behind means the account grows dead
   * factors every time someone changes their mind.
   */
  const abandonEnrolment = useCallback(() => {
    const current = pending;
    setPending(null);
    setCode("");
    if (current !== null) unenrol.mutate(current.factorId);
  }, [pending, unenrol]);

  function confirmCode() {
    const current = pending;
    if (current === null || code.length !== 6) return;
    verify.mutate(
      { factorId: current.factorId, code },
      {
        onSuccess: () => {
          setPending(null);
          setCode("");
          setVerified(true);
        },
      },
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Smartphone className="size-4 text-primary" aria-hidden />
          {t("security.mfa.title")}
        </CardTitle>
        <CardDescription>{t("security.mfa.hint")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {verified ? <Notice tone="success">{t("security.mfa.verified")}</Notice> : null}
        {enrol.isError ? (
          <Notice tone="error">{errorMessageOf(enrol.error, t("security.mfa.enrolFailed"))}</Notice>
        ) : null}
        {unenrol.isError ? (
          <Notice tone="error">
            {errorMessageOf(unenrol.error, t("security.mfa.removeFailed"))}
          </Notice>
        ) : null}

        <StateBoundary
          loading={factors.isPending}
          error={factors.error}
          onRetry={() => void factors.refetch()}
          isEmpty={totp.length === 0}
          skeletonRows={1}
          empty={
            <EmptyState
              icon={Smartphone}
              title={t("security.mfa.empty.title")}
              hint={t("security.mfa.empty.hint")}
              action={
                <Button onClick={startEnrolment} disabled={enrol.isPending}>
                  {enrol.isPending ? (
                    <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
                  ) : null}
                  {t("security.mfa.enrol")}
                </Button>
              }
            />
          }
        >
          <ul className="divide-y rounded-md border">
            {totp.map((factor) => (
              <li key={factor.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {dash(factor.friendly_name ?? null)}
                  </p>
                  <p className="num text-xs text-muted-foreground">
                    {t("security.mfa.added", { when: fmtDateTime(factor.created_at) })}
                  </p>
                </div>
                <Badge variant={factor.status === "verified" ? "success" : "warning"}>
                  {factor.status === "verified"
                    ? t("security.mfa.status.verified")
                    : t("security.mfa.status.unverified")}
                </Badge>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setRemoving(factor.id)}
                  disabled={unenrol.isPending}
                >
                  {t("security.mfa.remove")}
                </Button>
              </li>
            ))}
          </ul>

          <div className="mt-3">
            <Button variant="outline" onClick={startEnrolment} disabled={enrol.isPending}>
              {enrol.isPending ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
              {t("security.mfa.addAnother")}
            </Button>
          </div>
        </StateBoundary>

        {aal.isSuccess ? (
          <p className="text-xs text-muted-foreground">
            {t("security.mfa.aal", {
              current: aal.data.current ?? dash(null),
              next: aal.data.next ?? dash(null),
            })}
          </p>
        ) : null}

        {/* Enrolment dialog — the QR and the typed secret, exactly once. */}
        <AlertDialog.Root open={pending !== null}>
          <AlertDialog.Portal>
            <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
            <AlertDialog.Content
              className={cn(
                "fixed left-1/2 top-1/2 z-50 grid w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2",
                "-translate-y-1/2 gap-4 rounded-lg border bg-background p-5 shadow-lg sm:p-6",
              )}
              onEscapeKeyDown={(event) => {
                event.preventDefault();
              }}
            >
              <AlertDialog.Title className="font-display text-base font-semibold">
                {t("security.mfa.dialog.title")}
              </AlertDialog.Title>
              <AlertDialog.Description className="text-sm text-muted-foreground">
                {t("security.mfa.dialog.hint")}
              </AlertDialog.Description>

              {pending !== null ? (
                <div className="grid gap-4 sm:grid-cols-[auto,1fr] sm:items-start">
                  {/*
                    Omitted rather than rendered broken when the server sends no
                    usable QR. A broken-image icon reads as "this screen is
                    faulty" and stops people using the typed key beside it, which
                    enrols exactly as well.
                  */}
                  {qrSvgToDataUrl(pending.qrSvg) !== "" ? (
                    <img
                      src={qrSvgToDataUrl(pending.qrSvg)}
                      alt={t("security.mfa.dialog.qrAlt")}
                      className="mx-auto h-44 w-44 rounded-md border bg-white p-2"
                    />
                  ) : null}
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      {t("security.mfa.dialog.manual")}
                    </p>
                    <p className="num break-all rounded-md border bg-muted/40 px-2 py-1.5 text-sm">
                      {pending.secret}
                    </p>
                    <Label htmlFor="totp-code">{t("security.mfa.dialog.codeLabel")}</Label>
                    <Input
                      id="totp-code"
                      value={code}
                      onChange={(event) =>
                        setCode(event.target.value.replace(/\D/g, "").slice(0, 6))
                      }
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      placeholder="000000"
                      className="num text-center font-display text-xl tracking-[0.4em]"
                    />
                    {verify.isError ? (
                      <p className="text-sm font-medium text-destructive" role="alert">
                        {errorMessageOf(verify.error, t("security.mfa.dialog.wrongCode"))}
                      </p>
                    ) : null}
                  </div>
                </div>
              ) : null}

              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="outline" onClick={abandonEnrolment} disabled={verify.isPending}>
                  {t("common.cancel")}
                </Button>
                <Button onClick={confirmCode} disabled={verify.isPending || code.length !== 6}>
                  {verify.isPending ? (
                    <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
                  ) : null}
                  {t("security.mfa.dialog.confirm")}
                </Button>
              </div>
            </AlertDialog.Content>
          </AlertDialog.Portal>
        </AlertDialog.Root>

        {/* Removal confirmation — an alertdialog, not a browser confirm(). */}
        <AlertDialog.Root open={removing !== null}>
          <AlertDialog.Portal>
            <AlertDialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
            <AlertDialog.Content
              className={cn(
                "fixed left-1/2 top-1/2 z-50 grid w-[calc(100vw-2rem)] max-w-md -translate-x-1/2",
                "-translate-y-1/2 gap-4 rounded-lg border bg-background p-5 shadow-lg sm:p-6",
              )}
              onEscapeKeyDown={() => setRemoving(null)}
            >
              <AlertDialog.Title className="font-display text-base font-semibold">
                {t("security.mfa.removeDialog.title")}
              </AlertDialog.Title>
              <AlertDialog.Description className="text-sm text-muted-foreground">
                {t("security.mfa.removeDialog.hint")}
              </AlertDialog.Description>
              <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <Button variant="outline" onClick={() => setRemoving(null)}>
                  {t("common.cancel")}
                </Button>
                <Button
                  variant="destructive"
                  disabled={unenrol.isPending}
                  onClick={() => {
                    const id = removing;
                    setRemoving(null);
                    if (id !== null) unenrol.mutate(id);
                  }}
                >
                  {t("security.mfa.removeDialog.confirm")}
                </Button>
              </div>
            </AlertDialog.Content>
          </AlertDialog.Portal>
        </AlertDialog.Root>
      </CardContent>
    </Card>
  );
}

/* ── Passkeys ─────────────────────────────────────────────────────────────── */

function PasskeysCard() {
  const passkeys = useMyPasskeys();
  const rows = passkeys.data ?? [];

  const columns: DataGridColumn<Passkey>[] = [
    {
      key: "device_label",
      header: t("security.passkey.col.device"),
      render: (row) => dash(row.device_label),
    },
    {
      key: "purpose",
      header: t("security.passkey.col.purpose"),
      width: "9rem",
      render: (row) => <StatusChip status={row.purpose} />,
    },
    {
      key: "last_used_at",
      header: t("security.passkey.col.lastUsed"),
      width: "12rem",
      render: (row) => (
        <span className="num text-xs">
          {row.last_used_at === null ? t("security.passkey.never") : fmtDateTime(row.last_used_at)}
        </span>
      ),
    },
    {
      key: "revoked_at",
      header: t("security.passkey.col.state"),
      width: "9rem",
      render: (row) =>
        row.revoked_at === null ? (
          <Badge variant="success">{t("security.passkey.live")}</Badge>
        ) : (
          <Badge variant="neutral">{t("security.passkey.revoked")}</Badge>
        ),
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Fingerprint className="size-4 text-primary" aria-hidden />
          {t("security.passkey.title")}
        </CardTitle>
        <CardDescription>{t("security.passkey.hint")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <StateBoundary
          loading={passkeys.isPending}
          error={passkeys.error}
          onRetry={() => void passkeys.refetch()}
          isEmpty={rows.length === 0}
          skeletonRows={2}
          empty={
            <EmptyState
              icon={Fingerprint}
              title={t("security.passkey.empty.title")}
              hint={t("security.passkey.empty.hint")}
            />
          }
        >
          <DataGrid columns={columns} rows={rows} rowKey={(row) => row.id} pageSize={10} />
        </StateBoundary>
        <Notice tone="info">{t("security.passkey.readOnly")}</Notice>
      </CardContent>
    </Card>
  );
}

/* ── Face SIGN-IN switch ──────────────────────────────────────────────────── */

/**
 * The employee's own face sign-in switch.
 *
 * `useFaceLoginAccess()` with no argument returns exactly one row — theirs — because
 * `v_face_login_access` scopes rows to self OR manager-of OR admin-scope. An employee
 * therefore cannot see or reach anybody else's switch through this card, and that is
 * enforced in Postgres rather than by what this component chooses to render.
 */
function MyFaceLoginCard() {
  const access = useFaceLoginAccess();
  const auth = useAuth();
  const mine = access.data?.find((row) => row.employee_id === auth.employee?.employeeId) ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("faceLogin.title.self")}</CardTitle>
      </CardHeader>
      <CardContent>
        <StateBoundary
          loading={access.isPending}
          error={access.error}
          onRetry={() => void access.refetch()}
          isEmpty={!access.isPending && access.error === null && mine === null}
          empty={<p className="text-sm text-muted-foreground">{t("faceLogin.noEmployee")}</p>}
          skeletonRows={2}
        >
          {mine !== null ? (
            // No border: the Card already provides one.
            <FaceLoginSwitch
              row={mine}
              audience="self"
              hideTitle
              className="border-0 bg-transparent p-0"
            />
          ) : null}
        </StateBoundary>
      </CardContent>
    </Card>
  );
}

/* ── Face enrolment ───────────────────────────────────────────────────────── */

function FaceCard() {
  const status = useMyBiometricStatus();
  const requests = useMyFaceEnrolmentRequests();
  const latest = requests.data?.[0] ?? null;
  const biometric = status.data ?? null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ScanFace className="size-4 text-primary" aria-hidden />
          {t("security.face.title")}
        </CardTitle>
        <CardDescription>{t("security.face.hint")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <StateBoundary
          loading={status.isPending || requests.isPending}
          error={status.error ?? requests.error}
          onRetry={() => {
            void status.refetch();
            void requests.refetch();
          }}
          skeletonRows={2}
        >
          {biometric === null ? (
            <Notice tone="warning">{t("security.face.noConsent")}</Notice>
          ) : (
            <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">{t("security.face.consent")}</dt>
                <dd className="mt-0.5 text-sm">
                  {biometric.withdrawn_at !== null ? (
                    <Badge variant="danger">
                      {t("security.face.withdrawn", {
                        when: fmtDateTime(biometric.withdrawn_at),
                      })}
                    </Badge>
                  ) : biometric.granted ? (
                    <Badge variant="success">
                      {biometric.granted_at !== null
                        ? t("security.face.granted", { when: fmtDateTime(biometric.granted_at) })
                        : t("security.face.grantedPlain")}
                    </Badge>
                  ) : (
                    <Badge variant="neutral">{t("security.face.notGranted")}</Badge>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("security.face.modality")}</dt>
                <dd className="mt-0.5 text-sm">{dash(biometric.modality)}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("security.face.template")}</dt>
                <dd className="mt-0.5 text-sm">
                  {biometric.face_template_active ? (
                    <Badge variant="success">{t("security.face.templateActive")}</Badge>
                  ) : (
                    <Badge variant="neutral">{t("security.face.templateNone")}</Badge>
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">{t("security.face.enrolledAt")}</dt>
                <dd className="num mt-0.5 text-sm">
                  {biometric.face_enrolled_at === null
                    ? dash(null)
                    : fmtDateTime(biometric.face_enrolled_at)}
                </dd>
              </div>
            </dl>
          )}

          {latest !== null ? (
            <div className="rounded-md border p-3">
              {/* A `div`, not a `p`: StatusChip and Badge both render a div, and `<p>`
                  may only contain phrasing content — the browser silently closes the
                  paragraph before the first one, so the badges after it became
                  siblings of the paragraph rather than children of it. Same defect
                  class as the DataGrid card title fixed alongside this. */}
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <StatusChip status={latest.status} map={ENROLMENT_CHIP} />
                <span className="num text-xs text-muted-foreground">
                  {t("security.face.requested", { when: fmtDateTime(latest.requested_at) })}
                </span>
                <Badge variant="neutral">
                  {t("security.face.via", { via: latest.requested_via })}
                </Badge>
                {latest.quality_score !== null ? (
                  <Badge variant="info">
                    {/* The server's 0–1 score, shown as-is: rescaling it here
                        would be the client inventing a percentage. */}
                    {t("security.face.quality", {
                      score: dash(latest.quality_score, (v) => v.toFixed(4)),
                    })}
                  </Badge>
                ) : null}
              </div>
              {latest.review_comment !== null ? (
                <p className="mt-1.5 text-xs text-muted-foreground">{latest.review_comment}</p>
              ) : null}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t("security.face.noRequest")}</p>
          )}
        </StateBoundary>

        <Notice tone="info">{t("security.face.enrolAtGate")}</Notice>
      </CardContent>
    </Card>
  );
}

/* ── Swipe cards ──────────────────────────────────────────────────────────── */

function SwipeCardsCard() {
  const cards = useSwipeCards();
  const rows = cards.data ?? [];

  const columns: DataGridColumn<SwipeCard>[] = [
    {
      key: "card_number",
      header: t("security.card.col.number"),
      render: (row) => <span className="num">{row.card_number}</span>,
    },
    {
      key: "card_technology",
      header: t("security.card.col.technology"),
      width: "9rem",
      hideBelow: "md",
      render: (row) => dash(row.card_technology),
    },
    {
      key: "status",
      header: t("security.card.col.status"),
      width: "9rem",
      render: (row) => <StatusChip status={row.status} map={CARD_STATUS_CHIP} />,
    },
    {
      key: "issued_on",
      header: t("security.card.col.issued"),
      width: "9rem",
      render: (row) => <span className="num">{fmtCivilDate(row.issued_on)}</span>,
    },
    {
      key: "valid_to",
      header: t("security.card.col.validTo"),
      width: "10rem",
      render: (row) => (
        <span className="num">
          {row.valid_to === null ? t("security.card.noExpiry") : fmtCivilDate(row.valid_to)}
        </span>
      ),
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CreditCard className="size-4 text-primary" aria-hidden />
          {t("security.card.title")}
        </CardTitle>
        <CardDescription>{t("security.card.hint")}</CardDescription>
      </CardHeader>
      <CardContent>
        <StateBoundary
          loading={cards.isPending}
          error={cards.error}
          onRetry={() => void cards.refetch()}
          isEmpty={rows.length === 0}
          skeletonRows={2}
          empty={
            <EmptyState
              icon={CreditCard}
              title={t("security.card.empty.title")}
              hint={t("security.card.empty.hint")}
            />
          }
        >
          <DataGrid columns={columns} rows={rows} rowKey={(row) => row.id} pageSize={10} />
        </StateBoundary>
      </CardContent>
    </Card>
  );
}

/* ── Sign-in activity ─────────────────────────────────────────────────────── */

/**
 * The recent auth events, in the SAME words /me/activity uses.
 *
 * This card used to render a six-column grid of raw row values. It now renders the
 * shared `SignInTrail`, analysed by the shared `buildSignInTrail`, so the sentence
 * describing an event, the device name and the note on a row are produced in exactly
 * one place. `historyComplete` is FALSE here on purpose: this card shows the newest
 * events only, and "the first time this device was ever used" cannot be claimed from
 * a short window — the full trail on /me/activity is where those notes appear.
 *
 * It reads through `useMySignInTrail`, the SAME query key /me/activity uses, so the
 * two screens share one cache entry instead of issuing two reads of one table; the
 * slice happens here, in the render.
 */
function SessionsCard() {
  const events = useMySignInTrail();
  const signOutOthers = useSignOutOtherSessions();
  const rows = events.data ?? [];
  const ua = typeof navigator === "undefined" ? null : navigator.userAgent;
  const trail = buildSignInTrail(rows.slice(0, RECENT_SIGNIN_COUNT), {
    historyComplete: false,
    currentUserAgent: ua,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <MonitorSmartphone className="size-4 text-primary" aria-hidden />
          {t("signIn.card.title")}
        </CardTitle>
        <CardDescription>{t("signIn.card.hint")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {signOutOthers.isSuccess ? (
          <Notice tone="success">{t("security.sessions.signedOut")}</Notice>
        ) : null}
        {signOutOthers.isError ? (
          <Notice tone="error">
            {errorMessageOf(signOutOthers.error, t("security.sessions.signOutFailed"))}
          </Notice>
        ) : null}

        <StateBoundary
          loading={events.isPending}
          error={events.error}
          onRetry={() => void events.refetch()}
          isEmpty={rows.length === 0}
          skeletonRows={2}
          empty={
            <EmptyState
              icon={MonitorSmartphone}
              title={t("signIn.empty.title")}
              hint={t("signIn.empty.hint")}
            />
          }
        >
          <SignInTrail
            rows={trail}
            initialCount={RECENT_SIGNIN_COUNT}
            showLegend={false}
            showCount={false}
          />
        </StateBoundary>

        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="outline"
            disabled={signOutOthers.isPending}
            onClick={() => signOutOthers.mutate()}
          >
            {signOutOthers.isPending ? (
              <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
            ) : null}
            {t("security.sessions.signOutOthers")}
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link to="/me/activity">{t("signIn.card.full")}</Link>
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("signIn.recorded.notWritten")}</p>
      </CardContent>
    </Card>
  );
}

export default function SecurityPage() {
  return (
    <div className="container py-6">
      <PageHeader
        icon={ShieldCheck}
        title={t("security.title")}
        subtitle={t("security.subtitle")}
      />

      <div className="grid gap-4 xl:grid-cols-2">
        <PasswordCard />
        <AuthenticatorCard />
        <PasskeysCard />
        <FaceCard />
        {/* The switch sits NEXT TO the enrolment card, not inside it: enrolment is
            "does a template exist", this is "may it open a session", and merging them
            would suggest that withdrawing one withdraws the other. */}
        <MyFaceLoginCard />
        <SwipeCardsCard />
        <SessionsCard />
      </div>
    </div>
  );
}
