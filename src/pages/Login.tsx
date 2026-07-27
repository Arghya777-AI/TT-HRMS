/**
 * Login — E-01. One identifier field, then a CHOICE of credential:
 * fingerprint (passkey), password, or face.
 *
 * STEP 1 · identify. An employee code (TT####) or a work email goes to the
 * `auth-identify` edge function (service role — `employees` is not readable
 * pre-auth). It answers five facts and no more: found, first name only, masked
 * email, hasPasskey, portalState. An email is looked up too rather than
 * short-circuited, because that answer is the only way this screen learns whether
 * the strongest method is even available. Identify failures are one generic
 * message, and the UI never reveals whether an identifier exists.
 *
 * WHY PASSWORD SIGN-IN MAY ASK FOR THE EMAIL. `auth-identify` returns a MASKED
 * address by design (PRD §10.3 response allowlist) — a shared back-office screen
 * must not turn an employee code into an address book. `signInWithPassword` needs
 * a real address, so a code-only sign-in asks for it. The passkey and face routes
 * do NOT: their edge functions resolve `TT0042` server-side, which is exactly
 * what makes them the better options for gate staff who know their code and not
 * their email.
 *
 * STEP 2 · the three methods, all ending in the same GoTrue session:
 *   fingerprint  `webauthn-login` verifies the assertion and mints a single-use
 *                `token_hash`; the browser redeems it with
 *                `supabase.auth.verifyOtp({ token_hash, type: 'magiclink' })`.
 *                Offered only when `PublicKeyCredential` exists, the context is
 *                secure, and the account has a passkey; platform authenticators
 *                (Touch ID, Windows Hello, phone sensors) are preferred.
 *   password     `supabase.auth.signInWithPassword`. Never removed, always
 *                reachable from every other method's screen.
 *   face         several agreeing frames from the shared kiosk face pipeline →
 *                `face-login` → the same `token_hash` redemption. Stated on
 *                screen as a convenience factor, weaker than the other two.
 *
 * The token_hash never reaches this file: `features/auth/api/signin.api.ts` runs
 * each ceremony end to end and hands back only a display name.
 *
 * LOCATION. Before any attempt is possible, the screen explains that the sign-in
 * location is recorded for security and asks for it. A refusal is a settled state
 * that blocks nothing — see `features/auth/lib/geolocation.ts`. The notice also
 * states the honest limit: only the face route can carry coordinates today,
 * because `webauthn-login` and `auth-identify` validate their bodies with zod
 * `.strict()` and a password sign-in never touches an edge function.
 */
import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { ArrowLeft, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { t } from "@/shared/i18n/en";
import { AuthNotice } from "@/features/auth/components/AuthNotice";
import { FaceSignIn } from "@/features/auth/components/FaceSignIn";
import { LocationConsent } from "@/features/auth/components/LocationConsent";
import { MethodPicker } from "@/features/auth/components/MethodPicker";
import {
  identifyForSignIn,
  signInWithPasskey,
  recordPasswordSignIn,
  signInWithPassword,
  type Identified,
  type SignedIn,
  type SignInMethod,
  type SignInOutcome,
} from "@/features/auth/api/signin.api";
import { usePasskeyCapability } from "@/features/auth/hooks/usePasskeyCapability";
import { useSignInLocation } from "@/features/auth/hooks/useSignInLocation";
import { browserCanUseCamera } from "@/features/auth/lib/cameraSupport";
import { methodName, refusalMessage, signedInMessage } from "@/features/auth/lib/refusalCopy";
import { AuthLayout } from "./AuthLayout";

const EMPLOYEE_CODE = /^TT\d{4}$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;

/** What step 1 established, plus the two things only the browser knows. */
interface Subject extends Identified {
  /** Exactly what was typed — the edge functions resolve it themselves. */
  identifier: string;
  /** Known ONLY when an email was typed; never learned from a code lookup. */
  email: string | null;
}

type Step = "identify" | "choose" | "password" | "face" | "kioskOnly" | "blocked";

/** The one back affordance every step after the first needs. */
function BackLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
      {label}
    </button>
  );
}

export default function Login() {
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = (location.state as { from?: string } | null)?.from ?? "/me";

  const [step, setStep] = useState<Step>("identify");
  const [identifier, setIdentifier] = useState("");
  const [subject, setSubject] = useState<Subject | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyMethod, setBusyMethod] = useState<SignInMethod | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Set when step 1 could not reach `auth-identify`; the screen says so. */
  const [degraded, setDegraded] = useState(false);

  const passkey = usePasskeyCapability();
  const { status: geoStatus, geo, ask: askLocation } = useSignInLocation();
  const [cameraAvailable] = useState(() => browserCanUseCamera());

  // The location is asked for as soon as a method can be chosen — i.e. before any
  // sign-in attempt is possible, and never inside a click handler, so the user's
  // tap on "fingerprint" goes straight into the WebAuthn ceremony with its user
  // activation intact.
  useEffect(() => {
    if (step !== "choose" || geoStatus !== "idle") return;
    void askLocation();
  }, [step, geoStatus, askLocation]);

  function restart() {
    setStep("identify");
    setSubject(null);
    setPassword("");
    setEmail("");
    setError(null);
    setDegraded(false);
    setBusyMethod(null);
  }

  // Stable identity: `FaceSignIn`'s capture loop takes this as a dependency, and
  // a new function every render would restart the interval mid-ceremony.
  const onSignedIn = useCallback(
    (outcome: SignedIn) => {
      // Which method was used, named, on the way out. `sonner` lives above the
      // router, so this survives the navigation the session triggers.
      toast.success(signedInMessage(outcome.method));
      navigate(returnTo, { replace: true });
    },
    [navigate, returnTo],
  );

  function onRefused(outcome: SignInOutcome, method: SignInMethod) {
    if (outcome.kind === "signed_in") {
      onSignedIn(outcome);
      return;
    }
    setError(refusalMessage(outcome, method));
  }

  async function onIdentify(e: FormEvent) {
    e.preventDefault();
    const value = identifier.trim();
    if (!EMPLOYEE_CODE.test(value) && !EMAIL.test(value)) {
      toast.error(t("auth.login.invalidIdentifier"));
      return;
    }
    const typedEmail = EMAIL.test(value) ? value.toLowerCase() : null;

    setBusy(true);
    setError(null);
    try {
      const outcome = await identifyForSignIn(value);

      if (outcome.kind === "unknown") {
        // Anti-enumeration: the same generic copy for every miss.
        toast.error(t("auth.login.failed"), { description: t("auth.login.genericError") });
        return;
      }

      if (outcome.kind === "refused") {
        // Throttled or offline: say so and stay put. Walking on would only reach
        // methods that are about to fail for the same reason.
        if (outcome.reason === "rate_limited") {
          setError(outcome.message ?? t("auth.login.error.rateLimited"));
          return;
        }
        if (outcome.reason === "offline") {
          setError(t("auth.login.error.offline"));
          return;
        }
        // The lookup itself is unreachable (not deployed / server fault). Degrade
        // honestly: the passkey and face routes resolve an employee code
        // server-side without it, and password still works from a typed email.
        setDegraded(true);
        setSubject({
          identifier: value,
          email: typedEmail,
          firstName: null,
          maskedEmail: null,
          // Optimistic ONLY in this branch: nobody told us whether a passkey
          // exists, and `webauthn-login` answers that question itself with copy
          // written for exactly this case ("Fingerprint sign-in isn't available
          // for that account. Use your password instead."). Hiding the strongest
          // method because a lookup was down would be the worse failure.
          hasPasskey: true,
          portalState: null,
        });
        setEmail(typedEmail ?? "");
        setStep("choose");
        return;
      }

      const next: Subject = { ...outcome.identity, identifier: value, email: typedEmail };
      setSubject(next);
      setEmail(typedEmail ?? "");

      if (next.portalState === "none") {
        setStep("kioskOnly");
        return;
      }
      if (next.portalState === "suspended") {
        setStep("blocked");
        return;
      }
      setStep("choose");
    } finally {
      setBusy(false);
    }
  }

  async function onPasskey() {
    if (subject === null) return;
    setBusyMethod("passkey");
    setError(null);
    try {
      onRefused(await signInWithPasskey(subject.identifier), "passkey");
    } finally {
      setBusyMethod(null);
    }
  }

  function onPick(method: SignInMethod) {
    setError(null);
    if (method === "password") {
      setStep("password");
      return;
    }
    if (method === "face") {
      setStep("face");
      return;
    }
    void onPasskey();
  }

  async function onPasswordSubmit(e: FormEvent) {
    e.preventDefault();
    if (subject === null) return;
    const address = (subject.email ?? email).trim();
    if (!EMAIL.test(address)) {
      setError(t("auth.login.emailNeededNoMask"));
      return;
    }
    setBusyMethod("password");
    setError(null);
    try {
      const outcome = await signInWithPassword(address, password);
      if (outcome.kind === "signed_in") {
        // The session now exists, so `auth-session-record` can attribute the row
        // to the verified JWT and stamp ip/user_agent server-side. Only the
        // PASSWORD leg does this: the passkey and face functions already write
        // their own `login_success`, and a second row would double-count.
        //
        // Deliberately not awaited into the failure path: an audit write must
        // never block a sign-in that has already succeeded. A miss is logged
        // server-side and surfaces as `recorded: false`.
        void recordPasswordSignIn(geo);
      }
      onRefused(outcome, "password");
    } finally {
      setBusyMethod(null);
    }
  }

  const anyBusy = busy || busyMethod !== null;
  const accuracy = geo?.accuracy_m ?? null;
  /**
   * The identity confirmation banner (spec-employee E-01). First name when the
   * lookup gave us one — it never gives more — otherwise what was typed, with an
   * employee code normalised the way the database stores it.
   */
  const subjectLabel =
    subject === null
      ? null
      : (subject.firstName ??
        (EMPLOYEE_CODE.test(subject.identifier)
          ? subject.identifier.toUpperCase()
          : subject.identifier));

  function backToMethods() {
    setStep("choose");
    setError(null);
    setPassword("");
  }

  return (
    <AuthLayout
      title={t("auth.login.title")}
      description={
        subjectLabel === null ? undefined : t("auth.login.signingInAs", { name: subjectLabel })
      }
      footer={t("auth.login.noSignup")}
    >
      {step === "identify" ? (
        <form onSubmit={onIdentify} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="identifier">{t("auth.login.identifier")}</Label>
            <Input
              id="identifier"
              name="identifier"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="next"
              placeholder={t("auth.login.identifierPlaceholder")}
              value={identifier}
              onChange={(e) => setIdentifier(e.target.value)}
              required
            />
            <p className="text-xs text-muted-foreground">{t("auth.login.identifyHint")}</p>
          </div>
          {error !== null ? <AuthNotice tone="error">{error}</AuthNotice> : null}
          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {t("auth.login.continue")}
          </Button>
          <div className="text-center">
            <Link
              to="/login/forgot"
              className="text-sm text-muted-foreground underline-offset-4 hover:underline"
            >
              {t("auth.login.forgot")}
            </Link>
          </div>
        </form>
      ) : null}

      {step === "choose" && subject !== null ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <BackLink
              label={`${t("auth.login.notYou")} ${t("auth.login.startAgain")}`}
              onClick={restart}
            />
            {subject.maskedEmail !== null ? (
              <span className="text-xs text-muted-foreground">
                {t("auth.login.onFile", { masked: subject.maskedEmail })}
              </span>
            ) : null}
          </div>

          {degraded ? <AuthNotice tone="warning">{t("auth.login.degraded")}</AuthNotice> : null}

          <LocationConsent
            status={geoStatus}
            accuracyMetres={accuracy}
            onShare={() => void askLocation()}
          />

          <MethodPicker
            hasPasskey={subject.hasPasskey}
            passkey={passkey}
            cameraAvailable={cameraAvailable}
            busyMethod={busyMethod}
            disabled={anyBusy}
            onPick={onPick}
          />

          {busyMethod === "passkey" ? (
            <AuthNotice tone="info">{t("auth.login.passkey.prompting")}</AuthNotice>
          ) : null}
          {error !== null ? <AuthNotice tone="error">{error}</AuthNotice> : null}
        </div>
      ) : null}

      {step === "password" && subject !== null ? (
        <form onSubmit={onPasswordSubmit} className="space-y-4">
          <BackLink label={t("auth.login.back")} onClick={backToMethods} />
          <p className="text-xs text-muted-foreground">
            {t("auth.login.usingMethod", { method: methodName("password") })}
          </p>

          {subject.email === null ? (
            <div className="space-y-2">
              <Label htmlFor="email">{t("auth.login.emailLabel")}</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                enterKeyHint="next"
                placeholder={t("auth.login.emailPlaceholder")}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                {subject.maskedEmail !== null
                  ? t("auth.login.emailNeeded", { masked: subject.maskedEmail })
                  : t("auth.login.emailNeededNoMask")}
              </p>
            </div>
          ) : null}

          <div className="space-y-2">
            <Label htmlFor="password">{t("auth.login.password")}</Label>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              enterKeyHint="go"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus={subject.email !== null}
            />
          </div>

          {error !== null ? <AuthNotice tone="error">{error}</AuthNotice> : null}

          <Button type="submit" className="w-full" disabled={anyBusy}>
            {busyMethod === "password" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            {busyMethod === "password" ? t("auth.login.busy") : t("auth.login.submit")}
          </Button>

          <div className="text-center">
            <Link
              to="/login/forgot"
              className="text-sm text-muted-foreground underline-offset-4 hover:underline"
            >
              {t("auth.login.forgot")}
            </Link>
          </div>
        </form>
      ) : null}

      {step === "face" && subject !== null ? (
        <div className="space-y-4">
          <BackLink label={t("auth.login.back")} onClick={backToMethods} />
          <p className="text-xs text-muted-foreground">
            {t("auth.login.usingMethod", { method: methodName("face") })}
          </p>
          <FaceSignIn
            identifier={subject.identifier}
            onSignedIn={onSignedIn}
            onUsePassword={() => {
              setError(null);
              setStep("password");
            }}
            onCancel={() => {
              setError(null);
              setStep("choose");
            }}
          />
        </div>
      ) : null}

      {step === "kioskOnly" ? (
        <div className="space-y-4">
          <AuthNotice tone="info">
            <p className="font-medium">{t("auth.login.kioskOnly.title")}</p>
            <p className="text-muted-foreground">{t("auth.login.kioskOnly.body")}</p>
            <p className="mt-1 text-xs text-muted-foreground">{t("auth.login.kioskOnly.hint")}</p>
          </AuthNotice>
          <Button type="button" variant="outline" className="w-full" onClick={restart}>
            {t("auth.login.startAgain")}
          </Button>
        </div>
      ) : null}

      {step === "blocked" ? (
        <div className="space-y-4">
          <AuthNotice tone="error">
            <p className="font-medium">{t("auth.login.blocked.title")}</p>
            <p className="text-muted-foreground">{t("auth.login.blocked.body")}</p>
          </AuthNotice>
          <Button type="button" variant="outline" className="w-full" onClick={restart}>
            {t("auth.login.startAgain")}
          </Button>
        </div>
      ) : null}
    </AuthLayout>
  );
}
