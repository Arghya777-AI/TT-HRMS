/**
 * FaceEnrolmentConsole — ADMIN-INITIATED face enrolment, one employee at a time
 * (`/admin/kiosk/enrolment`, spec-admin §5.10, spec-kiosk §2 mode M2).
 *
 * The gap grid on this page answers "who cannot use the gate". This console
 * answers the other four questions an administrator actually has about a PERSON,
 * and gives them the four acts that follow:
 *
 *   who is enrolled          `employees.face_enrolled_at` — stamped by the
 *                            approval, cleared by a forced re-enrolment. It is
 *                            the employee record's own answer, and it needs no
 *                            access to the secure schema.
 *   whose consent is missing  `v_enrolment_coverage` for the gap subset, the
 *   or withdrawn              template's own `consent` block for everyone else.
 *                            Where NEITHER source can see it, the console says
 *                            "not known here" instead of guessing — there is no
 *                            consent view an admin browser may read.
 *   template age             days since the active set was captured, in IST,
 *                            from the sanctioned date helpers.
 *   what may I do now        record consent · initiate enrolment · register now
 *                            · approve · revoke · force re-enrolment, each with
 *                            the reason the audit engine demands.
 *
 * FOUR RULES THIS SCREEN IS BUILT AROUND, all verified against the deployed
 * functions rather than assumed:
 *
 *  1. CONSENT FIRST. `face-enrol` refuses with `BIOMETRIC_CONSENT_MISSING` /
 *     `BIOMETRIC_CONSENT_STALE` before it looks at a single frame, so the camera
 *     is refused outright where consent is known to be absent or withdrawn rather
 *     than after five wasted poses. The button that records consent says out loud
 *     that a newer notice version WITHDRAWS the older row rather than sitting
 *     beside it (`uq_biometric_consents__active`).
 *  2. AN INVITATION IS NOT A PENDING ENROLMENT. `face-enrol` also refuses
 *     (`FACE_ENROLMENT_PENDING`) while ANY `face_enrolment_requests` row for the
 *     employee is `pending`. So "Initiate enrolment" writes `draft` — the ask —
 *     and only a real capture ever writes `pending`. Getting this backwards would
 *     make the invitation block the capture it asks for.
 *  3. NOTHING HERE ACTIVATES A FACE. A capture parks as pending; activation is a
 *     second human act behind an MFA step-up, which is the whole DPDP design.
 *  4. NO DESCRIPTOR, EVER, AND A FACE ONLY ON REQUEST. Quality is the band the
 *     server computed (good/fair/poor), never the score — a face-similarity
 *     number on screen is a match score by another name. The reference photo is
 *     signed for 60 seconds by a per-employee reveal that writes its own
 *     `data_access` row, and the button is hidden from a role that does not hold
 *     `biometric.template.manage`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Camera,
  Fingerprint,
  IdCard,
  Mail,
  ScanFace,
  ShieldAlert,
  ShieldCheck,
  UserCheck,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry, type StatusTone } from "@/shared/ui/StatusChip";
import { isStepUpRequired, useStepUp } from "@/shared/auth/StepUpDialog";
import { TTApiError, newIdempotencyKey } from "@/shared/api/invoke";
import { mutationUserMessage } from "@/shared/api/query";
import { civilDayOffset, fmtCivilDate, fmtDateTime, istDate, istToday } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { t, type MessageKey } from "@/shared/i18n/en";
import { EMPLOYMENT_STATUS_LABELS } from "../api/employees.api";
import type { EnrolmentGap } from "../api/system.api";
import type { EnrolmentRequest, FaceTemplate } from "../api/kiosk.api";
import {
  CAP_BIOMETRIC_ENROL,
  CAP_TEMPLATE_MANAGE,
  INVITATION_CANCELLED_STATUS,
  INVITATION_FULFILLED_STATUS,
  INVITATION_OPEN_STATUS,
  INVITATION_SUBMITTED_STATUS,
  isOpenRequest,
  type EnrolmentRosterRow,
} from "../api/face-enrolment.api";
import {
  useEnrolmentGaps,
  useEnrolmentRequests,
  useForceReenrolMutation,
  useRecordConsentMutation,
  useTemplateApproveMutation,
  useTemplateRetireMutation,
} from "../hooks/useKioskConsole";
import {
  useCloseEnrolmentRequestMutation,
  useEmployeeTemplates,
  useEnrolmentNoticeMutation,
  useEnrolmentRoster,
  useInitiateEnrolmentMutation,
  useMyCapabilities,
  useTemplateRevealMutation,
  type NoticeOutcome,
} from "../hooks/useFaceEnrolment";
import { qualityChip, qualityLabel, templateStateChip } from "../kiosk-display";
import {
  enrolmentState,
  representativeSets,
  type ConsentState,
  type EnrolmentConsoleState,
} from "../face-enrol-state";
import { EnrolCapture } from "./EnrolCapture";
import { Notice } from "./Notice";
import { ReasonActionButton } from "./ReasonActionButton";
import { asArray } from "@/lib/asArray";

// ─────────────────────────────────────────────────────────────────────────────
// Vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/** The state machine and the set-collapse rule live in `face-enrol-state.ts`. */
type ConsoleState = EnrolmentConsoleState;

const STATE_KEY: Readonly<Record<ConsoleState, MessageKey>> = {
  enrolled: "admin.faceEnrol.status.enrolled",
  awaiting_approval: "admin.faceEnrol.status.awaiting_approval",
  not_enrolled: "admin.faceEnrol.status.not_enrolled",
  no_consent: "admin.faceEnrol.status.no_consent",
  consent_withdrawn: "admin.faceEnrol.status.consent_withdrawn",
  excluded: "admin.faceEnrol.status.excluded",
};

const STATE_TONE: Readonly<Record<ConsoleState, StatusTone>> = {
  enrolled: "success",
  awaiting_approval: "warn",
  not_enrolled: "info",
  no_consent: "warn",
  // A withdrawal is a lawful choice, not a to-do (§5.10).
  consent_withdrawn: "neutral",
  excluded: "neutral",
};

function stateChip(state: ConsoleState): Record<string, StatusChipEntry> {
  return { [state]: { label: t(STATE_KEY[state]), tone: STATE_TONE[state] } };
}

/** `public.approval_status` values a face enrolment request can hold, in words. */
const REQUEST_STATUS_KEY: Readonly<Record<string, MessageKey>> = {
  draft: "admin.faceEnrol.request.draft",
  pending: "admin.faceEnrol.request.pending",
  applied: "admin.faceEnrol.request.applied",
  cancelled: "admin.faceEnrol.request.cancelled",
  approved: "admin.faceEnrol.request.approved",
  rejected: "admin.faceEnrol.request.rejected",
};

const REQUEST_STATUS_TONE: Readonly<Record<string, StatusTone>> = {
  draft: "info",
  pending: "warn",
  applied: "success",
  cancelled: "neutral",
  approved: "success",
  rejected: "danger",
};

function requestChip(status: string): Record<string, StatusChipEntry> {
  const key = REQUEST_STATUS_KEY[status];
  if (key === undefined) return {};
  return { [status]: { label: t(key), tone: REQUEST_STATUS_TONE[status] ?? "neutral" } };
}

const CONSENT_KEY: Readonly<Record<ConsentState, MessageKey>> = {
  granted: "admin.faceEnrol.consent.granted",
  withdrawn: "admin.faceEnrol.consent.withdrawn",
  none: "admin.faceEnrol.consent.none",
  unknown: "admin.faceEnrol.consent.unknown",
};

const CONSENT_TONE: Readonly<Record<ConsentState, StatusTone>> = {
  granted: "success",
  withdrawn: "neutral",
  none: "warn",
  unknown: "neutral",
};

function consentStateChip(state: ConsentState): Record<string, StatusChipEntry> {
  return { [state]: { label: t(CONSENT_KEY[state]), tone: CONSENT_TONE[state] } };
}

/**
 * Days since the set was captured, as whole IST civil days from the sanctioned
 * helpers — never a millisecond subtraction in the browser.
 */
function templateAge(enrolledAt: string | null): string {
  if (enrolledAt === null) return t("admin.faceEnrol.template.ageUnknown");
  const days = civilDayOffset(istDate(enrolledAt), istToday());
  return days <= 0
    ? t("admin.faceEnrol.template.ageToday")
    : t("admin.faceEnrol.template.age", { days: formatNumber(days) });
}

/**
 * Age of the LIVE set measured from `employees.face_enrolled_at`, which is the
 * moment an approver activated it — NOT the moment the face was captured. The
 * two differ by however long the set sat in the review queue, so this is worded
 * separately from `templateAge`: the summary line above and the capture age on
 * the set card are both on screen at once for an enrolled employee, and one
 * label over two different numbers reads as a bug.
 */
function approvalAge(approvedAt: string): string {
  const days = civilDayOffset(istDate(approvedAt), istToday());
  return days <= 0
    ? t("admin.faceEnrol.template.approvedAgeToday")
    : t("admin.faceEnrol.template.approvedAge", { days: formatNumber(days) });
}

/** True when `face-template-admin` refused for want of a fresh second factor. */
function isStepUpRefusal(error: unknown): boolean {
  return (
    error instanceof TTApiError &&
    error.status === 403 &&
    (error.problem.code === "MFA_STEP_UP_REQUIRED" || error.problem.code === "MFA_STEP_UP_STALE")
  );
}

function noticeSentence(outcome: NoticeOutcome, name: string): { tone: "success" | "warning" | "error"; text: string } {
  switch (outcome.kind) {
    case "sent":
      return {
        tone: "success",
        text: t("admin.faceEnrol.notify.sent", {
          name,
          count: formatNumber(outcome.total),
          sent: formatNumber(outcome.sent),
        }),
      };
    case "no_email":
      return { tone: "warning", text: t("admin.faceEnrol.notify.noEmail") };
    case "transport_unconfigured":
      return { tone: "warning", text: t("admin.faceEnrol.notify.unconfigured") };
    case "failed":
      return { tone: "error", text: outcome.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The assembled per-employee record
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One employee's position, assembled from the three reads that cover EVERYONE.
 *
 * None of it needs the secure schema: `face_enrolled_at` is on the employee row,
 * the consent gap kinds come from `v_enrolment_coverage`, and a capture waiting
 * for a decision is a `pending` row in `face_enrolment_requests` (written by
 * `face-enrol` in the same transaction as the template set). Template DETAIL —
 * version, quality, age, and the decisions — is loaded for the selected employee
 * only, because it is an audited biometric read.
 */
interface ConsoleRow {
  readonly employee: EnrolmentRosterRow;
  readonly state: ConsoleState;
  readonly consent: ConsentState;
  readonly consentGrantedAt: string | null;
  /** The admin's ask: a `draft` row with no capture behind it. */
  readonly invitation: EnrolmentRequest | null;
  /** A real capture waiting for a decision: `pending`, written by `face-enrol`. */
  readonly submission: EnrolmentRequest | null;
  readonly requests: readonly EnrolmentRequest[];
}

function consentFromGap(gap: EnrolmentGap): ConsentState {
  if (gap.consent_withdrawn) return "withdrawn";
  return gap.has_active_consent ? "granted" : "none";
}

function consentFromTemplates(templates: readonly FaceTemplate[]): {
  state: ConsentState;
  grantedAt: string | null;
  withdrawnAt: string | null;
  version: string | null;
} {
  // Prefer the active set's consent, then the newest row in hand: they share one
  // consent row per version, and the active one is the consent in force.
  const ordered = [...templates].sort((a, b) => {
    if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
    return b.version - a.version;
  });
  const first = ordered[0];
  if (first === undefined) {
    return { state: "unknown", grantedAt: null, withdrawnAt: null, version: null };
  }
  const state: ConsentState =
    first.consent.withdrawnAt !== null
      ? "withdrawn"
      : first.consent.grantedAt !== null
        ? "granted"
        : "unknown";
  return {
    state,
    grantedAt: first.consent.grantedAt,
    withdrawnAt: first.consent.withdrawnAt,
    version: first.consent.version,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Filters
// ─────────────────────────────────────────────────────────────────────────────

type RosterFilter = "all" | ConsoleState;

const FILTERS: readonly { key: RosterFilter; label: string }[] = [
  { key: "all", label: t("admin.faceEnrol.filter.all") },
  { key: "enrolled", label: t("admin.faceEnrol.filter.enrolled") },
  { key: "awaiting_approval", label: t("admin.faceEnrol.filter.awaiting") },
  { key: "not_enrolled", label: t("admin.faceEnrol.filter.notEnrolled") },
  { key: "no_consent", label: t("admin.faceEnrol.filter.noConsent") },
  { key: "consent_withdrawn", label: t("admin.faceEnrol.filter.withdrawn") },
  { key: "excluded", label: t("admin.faceEnrol.filter.excluded") },
];

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

export function FaceEnrolmentConsole() {
  const roster = useEnrolmentRoster();
  const gaps = useEnrolmentGaps();
  const requests = useEnrolmentRequests(false);
  const caps = useMyCapabilities();

  /**
   * `?employee=<EMPLOYEE_CODE>` deep link, used by the "Enrol face" button on
   * /admin/people/:code. Without this the button would carry a parameter nothing
   * reads and drop the admin on an unfiltered roster — the person they had open
   * would have to be found again by hand, which is precisely the friction the
   * button exists to remove.
   *
   * The code goes into the SEARCH box rather than straight into `selectedId`,
   * because the roster is loaded asynchronously and an id cannot be resolved from
   * a code until it arrives. Search narrows immediately, and the effect below
   * selects the row the moment it is there.
   */
  const [searchParams] = useSearchParams();
  const requestedCode = (searchParams.get("employee") ?? "").trim();

  const [search, setSearch] = useState(requestedCode);
  const [filter, setFilter] = useState<RosterFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Template metadata is an audited biometric read (a `data_access` row per
  // call), so it is opt-in and scoped to the person on screen — the same contract
  // as /admin/kiosk/templates, narrowed to one subject.
  const [detailOn, setDetailOn] = useState(false);
  const templates = useEmployeeTemplates(selectedId, detailOn);

  const [cameraFor, setCameraFor] = useState<string | null>(null);
  const [revealedFor, setRevealedFor] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: "success" | "warning" | "error"; text: string } | null>(null);

  const stepUp = useStepUp();
  const consent = useRecordConsentMutation();
  const initiate = useInitiateEnrolmentMutation();
  const resend = useEnrolmentNoticeMutation();
  const closeRequest = useCloseEnrolmentRequestMutation();
  const reveal = useTemplateRevealMutation();
  const approve = useTemplateApproveMutation();
  const retire = useTemplateRetireMutation();
  const reenrol = useForceReenrolMutation();

  // One idempotency key per (action, subject), minted on first use and reused on
  // every retry — a refused-then-retried approve cannot approve twice.
  const keys = useRef(new Map<string, string>());
  function keyFor(scope: string): string {
    const existing = keys.current.get(scope);
    if (existing !== undefined) return existing;
    const fresh = newIdempotencyKey();
    keys.current.set(scope, fresh);
    return fresh;
  }

  /**
   * After any template decision. Three reads move, and only one of them is
   * covered by the mutations' own invalidation:
   *   * the SETS change state (that prefix IS invalidated);
   *   * `employees.face_enrolled_at` is stamped by an approval and CLEARED by a
   *     retire that leaves no active row, or by a forced re-enrolment;
   *   * the request row is closed as approved / rejected / cancelled by the same
   *     transaction.
   * Without this the roster would keep calling a revoked face "Enrolled".
   */
  function refreshAfterDecision(): void {
    void templates.refetch();
    void roster.refetch();
    void requests.refetch();
  }

  /** Run a step-up-gated call, verify once if the server asks, then retry it. */
  async function withStepUp<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (!isStepUpRequired(error)) throw error;
      const upgraded = await stepUp.ensureAal2();
      if (!upgraded) throw error;
      return run();
    }
  }

  const canManageTemplates = asArray(caps.data).includes(CAP_TEMPLATE_MANAGE);
  const canEnrol = asArray(caps.data).includes(CAP_BIOMETRIC_ENROL);

  const rows: ConsoleRow[] = useMemo(() => {
    const gapById = new Map(asArray(gaps.data).map((gap) => [gap.employee_id, gap]));
    const requestsById = new Map<string, EnrolmentRequest[]>();
    for (const req of asArray(requests.data)) {
      const list = requestsById.get(req.employee_id);
      if (list === undefined) requestsById.set(req.employee_id, [req]);
      else list.push(req);
    }

    return asArray(roster.data).map((employee) => {
      const employeeRequests = requestsById.get(employee.id) ?? [];
      const invitation =
        employeeRequests.find((req) => req.status === INVITATION_OPEN_STATUS) ?? null;
      const submission =
        employeeRequests.find((req) => req.status === INVITATION_SUBMITTED_STATUS) ?? null;

      // `v_enrolment_coverage` covers only the operational set (in service, not
      // excluded, and missing consent or a template). Absence from it is NOT
      // consent: a pre-joining or long-leave employee is never in the view at all.
      const gap = gapById.get(employee.id);
      const consent: ConsentState = gap !== undefined ? consentFromGap(gap) : "unknown";

      return {
        employee,
        state: enrolmentState({
          excludedFromAttendance: employee.exclude_from_attendance,
          consent,
          hasSubmission: submission !== null,
          faceEnrolledAt: employee.face_enrolled_at,
        }),
        consent,
        consentGrantedAt: gap?.consent_granted_at ?? null,
        invitation,
        submission,
        requests: employeeRequests,
      };
    });
  }, [roster.data, gaps.data, requests.data]);

  const counts = useMemo(() => {
    const tally: Record<ConsoleState, number> = {
      enrolled: 0,
      awaiting_approval: 0,
      not_enrolled: 0,
      no_consent: 0,
      consent_withdrawn: 0,
      excluded: 0,
    };
    for (const row of rows) tally[row.state] += 1;
    return tally;
  }, [rows]);

  const visible = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (filter !== "all" && row.state !== filter) return false;
      if (needle === "") return true;
      return (
        row.employee.display_name.toLowerCase().includes(needle) ||
        row.employee.employee_code.toLowerCase().includes(needle)
      );
    });
  }, [rows, search, filter]);

  /**
   * Select the deep-linked employee as soon as the roster can resolve the code.
   * Runs once per requested code: after the admin clicks a different row,
   * `selectedId` is theirs and this must not yank it back.
   */
  const appliedCodeRef = useRef<string | null>(null);
  useEffect(() => {
    if (requestedCode === "" || appliedCodeRef.current === requestedCode) return;
    const wanted = rows.find(
      (row) => row.employee.employee_code.toLowerCase() === requestedCode.toLowerCase(),
    );
    if (wanted === undefined) return;
    appliedCodeRef.current = requestedCode;
    setSelectedId(wanted.employee.id);
  }, [requestedCode, rows]);

  /**
   * Captures that exist and are NOT yet active — the thing nobody was ever told
   * about. Derived from the roster rows already in hand (`submission` is the
   * `pending` enrolment request `face-enrol` writes), so it costs no extra query
   * and, critically, no audited biometric read: naming WHO is waiting does not
   * require opening anyone's template metadata.
   *
   * Admin-led captures now activate themselves, so this list should normally be
   * empty. It will hold two kinds of row: kiosk-originated captures, which still
   * queue for review by design, and anything whose auto-activation failed.
   */
  const awaitingActivation = useMemo(
    () => rows.filter((row) => row.submission !== null),
    [rows],
  );

  const selected = rows.find((row) => row.employee.id === selectedId) ?? null;

  // The selected employee's sets, one row per version. The query key carries the
  // employee id, so this is never another person's data mid-switch.
  const sets = useMemo(() => representativeSets(asArray(templates.data?.templates)), [templates.data]);
  const activeSet = sets.find((tpl) => tpl.state === "active") ?? null;
  const pendingSet = sets.find((tpl) => tpl.state === "pending_approval") ?? null;
  const historySets = sets.filter((tpl) => tpl !== activeSet && tpl !== pendingSet);
  const consentDetail = consentFromTemplates(sets);

  /**
   * The coverage view is LIVE and wins where it can see the employee; the
   * template's own consent block fills in the rest (notice version always, and
   * the whole answer for anyone the view's predicate excludes).
   */
  const consentState: ConsentState =
    selected === null
      ? "unknown"
      : selected.consent !== "unknown"
        ? selected.consent
        : consentDetail.state;
  const consentGrantedAt = selected?.consentGrantedAt ?? consentDetail.grantedAt;

  /** A capture is waiting on a decision. Known without the audited detail read. */
  const hasSubmission = selected !== null && (selected.submission !== null || pendingSet !== null);
  const hasTemplate =
    selected !== null && (selected.employee.face_enrolled_at !== null || activeSet !== null);

  function select(id: string): void {
    setSelectedId(id);
    setCameraFor(null);
    setRevealedFor(null);
    setNotice(null);
    reveal.reset();
    consent.reset();
  }

  const revealedTemplates = revealedFor === null ? [] : asArray(reveal.data?.templates);

  return (
    <section className="rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="font-display text-sm font-semibold">{t("admin.faceEnrol.title")}</h2>
          <p className="mt-1 max-w-prose text-xs text-muted-foreground">
            {t("admin.faceEnrol.subtitle")}
          </p>
        </div>
        {detailOn ? null : (
          <Button variant="outline" size="sm" onClick={() => setDetailOn(true)}>
            <Fingerprint className="mr-1.5 size-4" aria-hidden />
            {t("admin.faceEnrol.load")}
          </Button>
        )}
      </div>

      {awaitingActivation.length > 0 ? (
        <div className="mt-3 rounded-lg border border-warning/50 bg-warning/5 p-3">
          <h3 className="text-sm font-semibold">
            {t("admin.faceEnrol.waiting.title", {
              count: formatNumber(awaitingActivation.length),
            })}
          </h3>
          <p className="mt-1 max-w-prose text-xs text-muted-foreground">
            {t("admin.faceEnrol.waiting.body")}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {awaitingActivation.map((row) => (
              <Button
                key={row.employee.id}
                size="sm"
                variant="outline"
                onClick={() => {
                  // Land them exactly where the Approve button is: select the
                  // person AND open the template detail, which is what the button
                  // lives inside. Two clicks became one.
                  select(row.employee.id);
                  setDetailOn(true);
                }}
              >
                {row.employee.display_name} · {row.employee.employee_code}
              </Button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="mt-3 space-y-2">
        <Notice tone="info">{t("admin.faceEnrol.dpdp")}</Notice>
        <p className="text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{t("admin.faceEnrol.ceremony.title")}</span>{" "}
          {t("admin.faceEnrol.ceremony.body")}
        </p>
        {detailOn ? null : (
          <p className="text-xs text-muted-foreground">{t("admin.faceEnrol.loadHint")}</p>
        )}
        {detailOn && isStepUpRefusal(templates.error) ? (
          <Notice
            tone="warning"
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  void (async () => {
                    const upgraded = await stepUp.ensureAal2();
                    if (upgraded) void templates.refetch();
                  })();
                }}
              >
                {t("admin.faceEnrol.stepUp.verify")}
              </Button>
            }
          >
            <span className="font-medium">{t("admin.faceEnrol.stepUp.title")}</span>{" "}
            {t("admin.faceEnrol.stepUp.hint")}
          </Notice>
        ) : null}
        {detailOn && templates.isSuccess ? (
          <p className="text-xs text-muted-foreground">
            {t("admin.faceEnrol.loaded", { count: formatNumber(sets.length) })}
          </p>
        ) : null}
      </div>

      <StateBoundary
        loading={roster.isLoading}
        error={roster.error ?? undefined}
        onRetry={() => void roster.refetch()}
        partialError={gaps.error ?? undefined}
        partialLabel={t("admin.faceEnrol.consent.heading")}
        isEmpty={roster.isSuccess && rows.length === 0}
        empty={
          <EmptyState
            icon={UserCheck}
            title={t("admin.faceEnrol.roster.empty.title")}
            hint={t("admin.faceEnrol.roster.empty.hint")}
          />
        }
        skeletonRows={4}
      >
        {/*
          SIX TILES, ONE PER STATE. There were five, and `excluded` — a real state this
          machine assigns, with its own filter — had none. So the tiles summed to 77 of
          78 people and disagreed with the roster below by exactly the one employee
          excluded from attendance (TT0017, who is also stamped enrolled, so he was
          counted here as neither enrolled nor anything else visible). A state the
          machine can assign must have somewhere to be counted, or the arithmetic on
          screen is quietly wrong.
        */}
        <section className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-6">
          <KpiTile
            label={t("admin.faceEnrol.kpi.enrolled")}
            value={formatNumber(counts.enrolled)}
            hint={t("admin.faceEnrol.kpi.enrolledHint")}
            tone={counts.enrolled > 0 ? "success" : "neutral"}
          />
          <KpiTile
            label={t("admin.faceEnrol.kpi.awaiting")}
            value={formatNumber(counts.awaiting_approval)}
            tone={counts.awaiting_approval > 0 ? "warn" : "neutral"}
          />
          <KpiTile
            label={t("admin.faceEnrol.kpi.notEnrolled")}
            value={formatNumber(counts.not_enrolled)}
            hint={t("admin.faceEnrol.kpi.notEnrolledHint")}
            tone={counts.not_enrolled > 0 ? "info" : "neutral"}
          />
          <KpiTile
            label={t("admin.faceEnrol.kpi.noConsent")}
            value={formatNumber(counts.no_consent)}
            tone={counts.no_consent > 0 ? "warn" : "neutral"}
          />
          <KpiTile
            label={t("admin.faceEnrol.kpi.withdrawn")}
            value={formatNumber(counts.consent_withdrawn)}
            hint={t("admin.faceEnrol.kpi.withdrawnHint")}
            tone="neutral"
          />
          <KpiTile
            label={t("admin.enrolStatus.kpi.excluded")}
            value={formatNumber(counts.excluded)}
            hint={t("admin.enrolStatus.kpi.excludedHint")}
            tone="neutral"
          />
        </section>

        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)]">
          {/* ── The roster ──────────────────────────────────────────────── */}
          <div className="space-y-2">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t("admin.faceEnrol.search")}
              aria-label={t("admin.faceEnrol.search")}
              className="h-9"
            />
            <div className="flex flex-wrap gap-1" role="group" aria-label={t("admin.faceEnrol.filter.label")}>
              {FILTERS.map((f) => (
                <Button
                  key={f.key}
                  size="sm"
                  variant={filter === f.key ? "default" : "outline"}
                  aria-pressed={filter === f.key}
                  onClick={() => setFilter(f.key)}
                >
                  {f.label}
                </Button>
              ))}
            </div>
            <p className="text-xs text-muted-foreground" aria-live="polite">
              {t("admin.faceEnrol.list.count", {
                shown: formatNumber(visible.length),
                total: formatNumber(rows.length),
              })}
            </p>

            {visible.length === 0 ? (
              <EmptyState
                icon={ScanFace}
                title={t("admin.faceEnrol.list.empty.title")}
                hint={t("admin.faceEnrol.list.empty.hint")}
                action={
                  <Button
                    variant="outline"
                    onClick={() => {
                      setFilter("all");
                      setSearch("");
                    }}
                  >
                    {t("admin.faceEnrol.filter.all")}
                  </Button>
                }
              />
            ) : (
              <ul className="max-h-[32rem] space-y-1 overflow-y-auto pr-1">
                {visible.map((row) => (
                  <li key={row.employee.id}>
                    <button
                      type="button"
                      onClick={() => select(row.employee.id)}
                      aria-current={row.employee.id === selectedId ? "true" : undefined}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 rounded-md border px-3 py-2 text-left transition-colors",
                        row.employee.id === selectedId
                          ? "border-primary/60 bg-primary/5"
                          : "border-border hover:bg-muted/50",
                      )}
                    >
                      <span className="flex min-w-0 flex-col leading-tight">
                        <span className="truncate text-sm font-medium">
                          {row.employee.display_name}
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {row.employee.employee_code}
                        </span>
                      </span>
                      <StatusChip status={row.state} map={stateChip(row.state)} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* ── The person ──────────────────────────────────────────────── */}
          {selected === null ? (
            <EmptyState
              icon={IdCard}
              title={t("admin.faceEnrol.pick.title")}
              hint={t("admin.faceEnrol.pick.hint")}
            />
          ) : (
            <div className="min-w-0 space-y-4">
              <header className="rounded-lg border bg-background p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="font-display text-base font-semibold">
                      {selected.employee.display_name}
                    </h3>
                    <p className="font-mono text-xs text-muted-foreground">
                      {selected.employee.employee_code}
                    </p>
                  </div>
                  <StatusChip status={selected.state} map={stateChip(selected.state)} />
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
                  <div>
                    <dt className="text-muted-foreground">{t("admin.faceEnrol.detail.department")}</dt>
                    <dd>{dash(selected.employee.department_name)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t("admin.faceEnrol.detail.status")}</dt>
                    <dd>{EMPLOYMENT_STATUS_LABELS[selected.employee.employment_status]}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t("admin.faceEnrol.detail.joined")}</dt>
                    <dd className="num">{fmtCivilDate(selected.employee.date_of_join)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t("admin.faceEnrol.detail.email")}</dt>
                    <dd className="truncate">
                      {selected.employee.work_email ?? t("admin.faceEnrol.detail.noEmail")}
                    </dd>
                  </div>
                </dl>
                {selected.employee.exclude_from_attendance ? (
                  <p className="mt-3 text-xs text-muted-foreground">
                    {t("admin.faceEnrol.detail.excluded")}
                  </p>
                ) : null}
              </header>

              {notice !== null ? <Notice tone={notice.tone}>{notice.text}</Notice> : null}

              {/* Consent */}
              <section className="rounded-lg border bg-background p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h4 className="flex items-center gap-2 text-sm font-semibold">
                    <ShieldCheck className="size-4 text-info" aria-hidden />
                    {t("admin.faceEnrol.consent.heading")}
                  </h4>
                  <StatusChip status={consentState} map={consentStateChip(consentState)} />
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
                  <div>
                    <dt className="text-muted-foreground">{t("admin.faceEnrol.consent.grantedAt")}</dt>
                    <dd className="num">{dash(consentGrantedAt, fmtDateTime)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t("admin.faceEnrol.consent.withdrawnAt")}</dt>
                    <dd className="num">{dash(consentDetail.withdrawnAt, fmtDateTime)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{t("admin.faceEnrol.consent.notice")}</dt>
                    <dd>{dash(consentDetail.version)}</dd>
                  </div>
                </dl>
                {consentState === "unknown" ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t("admin.faceEnrol.consent.unknownHint")}
                  </p>
                ) : null}
                {consentState === "withdrawn" ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t("admin.faceEnrol.consent.withdrawnNote")}
                  </p>
                ) : null}
                <div className="mt-3">
                  <ReasonActionButton
                    label={t("admin.faceEnrol.consent.record")}
                    title={t("admin.faceEnrol.consent.recordTitle", {
                      name: selected.employee.display_name,
                    })}
                    description={t("admin.faceEnrol.consent.recordDescription")}
                    minLength={consent.minReasonLength}
                    onConfirm={async (reason) => {
                      const result = await consent.saveAsync(selected.employee.id, reason);
                      setNotice({
                        tone: result.alreadyOnFile ? "warning" : "success",
                        text: result.alreadyOnFile
                          ? t("admin.faceEnrol.consent.already", { version: result.consentVersion })
                          : t("admin.faceEnrol.consent.recorded", { version: result.consentVersion }),
                      });
                      if (detailOn) void templates.refetch();
                    }}
                  />
                </div>
              </section>

              {/* Enrolment request */}
              <section className="rounded-lg border bg-background p-3">
                <h4 className="flex items-center gap-2 text-sm font-semibold">
                  <Mail className="size-4 text-info" aria-hidden />
                  {t("admin.faceEnrol.invite.heading")}
                </h4>

                <div className="mt-2 space-y-2 text-xs">
                  {selected.invitation === null && selected.submission === null ? (
                    <p className="text-muted-foreground">{t("admin.faceEnrol.invite.none")}</p>
                  ) : null}
                  {selected.invitation !== null ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusChip
                        status={selected.invitation.status}
                        map={requestChip(selected.invitation.status)}
                      />
                      <span className="num text-muted-foreground">
                        {t("admin.faceEnrol.invite.open", {
                          when: fmtDateTime(selected.invitation.requested_at),
                        })}
                      </span>
                    </div>
                  ) : null}
                  {selected.submission !== null ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <StatusChip
                        status={selected.submission.status}
                        map={requestChip(selected.submission.status)}
                      />
                      <span className="num text-muted-foreground">
                        {t("admin.faceEnrol.invite.pending", {
                          when: fmtDateTime(selected.submission.requested_at),
                        })}
                      </span>
                    </div>
                  ) : null}
                  <p className="text-muted-foreground">{t("admin.faceEnrol.notify.inAppGap")}</p>
                  {selected.invitation !== null ? (
                    <p className="text-muted-foreground">{t("admin.faceEnrol.invite.captureless")}</p>
                  ) : null}
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  <ReasonActionButton
                    label={t("admin.faceEnrol.invite.button")}
                    variant="default"
                    title={t("admin.faceEnrol.invite.title", {
                      name: selected.employee.display_name,
                    })}
                    description={t("admin.faceEnrol.invite.description")}
                    minLength={initiate.minReasonLength}
                    disabled={selected.requests.some(isOpenRequest)}
                    disabledHint={t("admin.faceEnrol.invite.exists")}
                    onConfirm={async (reason) => {
                      const result = await initiate.saveAsync(
                        {
                          employeeId: selected.employee.id,
                          workEmail: selected.employee.work_email,
                        },
                        reason,
                      );
                      const sentence = noticeSentence(
                        result.notice,
                        selected.employee.display_name,
                      );
                      setNotice(sentence);
                      toast.success(t("admin.faceEnrol.invite.created"));
                    }}
                  />

                  {selected.invitation !== null ? (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={resend.isPending || selected.employee.work_email === null}
                        title={
                          selected.employee.work_email === null
                            ? t("admin.faceEnrol.notify.noEmail")
                            : undefined
                        }
                        onClick={() => {
                          void (async () => {
                            const outcome = await resend.saveAsync({
                              employeeId: selected.employee.id,
                              workEmail: selected.employee.work_email,
                            });
                            setNotice(noticeSentence(outcome, selected.employee.display_name));
                          })();
                        }}
                      >
                        {t("admin.faceEnrol.notify.button")}
                      </Button>

                      {/* The capture happened: the ask is spent, so close it. */}
                      {hasSubmission || hasTemplate ? (
                        <ReasonActionButton
                          label={t("admin.faceEnrol.invite.fulfil")}
                          title={t("admin.faceEnrol.invite.fulfilTitle", {
                            name: selected.employee.display_name,
                          })}
                          description={t("admin.faceEnrol.invite.fulfilDescription")}
                          minLength={closeRequest.minReasonLength}
                          onConfirm={async (reason) => {
                            const request = selected.invitation;
                            if (request === null) return;
                            await closeRequest.saveAsync(
                              { requestId: request.id, outcome: INVITATION_FULFILLED_STATUS },
                              reason,
                            );
                            toast.success(t("admin.faceEnrol.invite.fulfilled"));
                          }}
                        />
                      ) : null}

                      <ReasonActionButton
                        label={t("admin.faceEnrol.invite.cancel")}
                        variant="ghost"
                        title={t("admin.faceEnrol.invite.cancelTitle", {
                          name: selected.employee.display_name,
                        })}
                        description={t("admin.faceEnrol.invite.cancelDescription")}
                        minLength={closeRequest.minReasonLength}
                        onConfirm={async (reason) => {
                          const request = selected.invitation;
                          if (request === null) return;
                          await closeRequest.saveAsync(
                            { requestId: request.id, outcome: INVITATION_CANCELLED_STATUS },
                            reason,
                          );
                          toast.success(t("admin.faceEnrol.invite.cancelled"));
                        }}
                      />
                    </>
                  ) : null}
                </div>

                {selected.requests.length > 1 ? (
                  <details className="mt-3 text-xs">
                    <summary className="cursor-pointer text-muted-foreground">
                      {t("admin.faceEnrol.invite.history")}
                    </summary>
                    <ul className="mt-2 space-y-1">
                      {selected.requests.map((request) => (
                        <li key={request.id} className="flex flex-wrap items-center gap-2">
                          <StatusChip status={request.status} map={requestChip(request.status)} />
                          <span className="num text-muted-foreground">
                            {fmtDateTime(request.requested_at)}
                          </span>
                          {request.review_comment !== null ? (
                            <span className="text-muted-foreground">{request.review_comment}</span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </details>
                ) : null}
              </section>

              {/* Template */}
              <section className="rounded-lg border bg-background p-3">
                <h4 className="flex items-center gap-2 text-sm font-semibold">
                  <Fingerprint className="size-4 text-info" aria-hidden />
                  {t("admin.faceEnrol.template.heading")}
                </h4>

                {/*
                 * Age is answerable WITHOUT the audited read: `face_enrolled_at`
                 * is the moment the live set was activated, and it sits on the
                 * employee record.
                 */}
                {selected.employee.face_enrolled_at !== null ? (
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
                    <div>
                      <dt className="text-muted-foreground">
                        {t("admin.faceEnrol.template.approvedAt")}
                      </dt>
                      <dd className="num">{fmtDateTime(selected.employee.face_enrolled_at)}</dd>
                    </div>
                    <div>
                      <dt className="text-muted-foreground">
                        {t("admin.faceEnrol.template.approvedAgeLabel")}
                      </dt>
                      <dd>{approvalAge(selected.employee.face_enrolled_at)}</dd>
                    </div>
                  </dl>
                ) : null}

                {!detailOn ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {selected.employee.face_enrolled_at !== null
                      ? t("admin.faceEnrol.template.notLoaded")
                      : t("admin.faceEnrol.loadHint")}
                  </p>
                ) : templates.isLoading ? (
                  <p className="mt-2 text-xs text-muted-foreground">{t("app.loading")}</p>
                ) : templates.error !== null ? (
                  // A failed read must never render as "no template on file".
                  isStepUpRefusal(templates.error) ? (
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t("admin.faceEnrol.stepUp.hint")}
                    </p>
                  ) : (
                    <Notice tone="error" className="mt-2">
                      {mutationUserMessage(templates.error)}
                    </Notice>
                  )
                ) : activeSet === null && pendingSet === null ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t("admin.faceEnrol.template.none")}
                  </p>
                ) : null}

                <div className="mt-3 space-y-3">
                  {[pendingSet, activeSet]
                    .filter((tpl): tpl is FaceTemplate => tpl !== null)
                    .map((tpl) => (
                      <div key={tpl.templateId} className="rounded-md border p-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <StatusChip status={tpl.state} map={templateStateChip(tpl.state)} />
                          <span className="num text-xs text-muted-foreground">
                            {t("admin.faceEnrol.template.version")} {formatNumber(tpl.version)}
                          </span>
                          <StatusChip status={tpl.qualityBand} map={qualityChip(tpl.qualityBand)} />
                          <span className="text-xs text-muted-foreground">
                            {t("admin.faceEnrol.template.samples", {
                              count: formatNumber(tpl.sampleCount),
                            })}
                          </span>
                        </div>
                        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
                          <div>
                            <dt className="text-muted-foreground">
                              {t("admin.faceEnrol.template.enrolledAt")}
                            </dt>
                            <dd className="num">{dash(tpl.enrolledAt, fmtDateTime)}</dd>
                            {tpl.enrolledByName !== null ? (
                              <dd className="text-muted-foreground">
                                {t("admin.faceEnrol.template.enrolledBy", {
                                  name: tpl.enrolledByName,
                                })}
                              </dd>
                            ) : null}
                          </div>
                          <div>
                            <dt className="text-muted-foreground">
                              {t("admin.faceEnrol.template.approvedAt")}
                            </dt>
                            <dd className="num">{dash(tpl.approvedAt, fmtDateTime)}</dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">
                              {t("admin.faceEnrol.template.ageLabel")}
                            </dt>
                            <dd>{templateAge(tpl.enrolledAt)}</dd>
                          </div>
                        </dl>

                        <div className="mt-3 flex flex-wrap gap-1">
                          {tpl.state === "pending_approval" ? (
                            <>
                              <ReasonActionButton
                                label={t("admin.faceEnrol.action.approve")}
                                variant="default"
                                minLength={approve.minReasonLength}
                                title={t("admin.faceEnrol.action.approveTitle", {
                                  version: tpl.version,
                                  name: selected.employee.display_name,
                                })}
                                description={t("admin.faceEnrol.action.approveDescription", {
                                  band: qualityLabel(tpl.qualityBand),
                                  samples: formatNumber(tpl.sampleCount),
                                })}
                                onConfirm={async (reason) => {
                                  await withStepUp(() =>
                                    approve.saveAsync(
                                      {
                                        templateId: tpl.templateId,
                                        idempotencyKey: keyFor(`approve:${tpl.templateId}`),
                                      },
                                      reason,
                                    ),
                                  );
                                  toast.success(
                                    t("admin.faceEnrol.action.approved", {
                                      name: selected.employee.display_name,
                                    }),
                                  );
                                  refreshAfterDecision();
                                }}
                              />
                              <ReasonActionButton
                                label={t("admin.faceEnrol.action.reject")}
                                minLength={retire.minReasonLength}
                                title={t("admin.faceEnrol.action.rejectTitle", {
                                  name: selected.employee.display_name,
                                })}
                                description={t("admin.faceEnrol.action.rejectDescription")}
                                onConfirm={async (reason) => {
                                  await withStepUp(() =>
                                    retire.saveAsync(
                                      {
                                        templateId: tpl.templateId,
                                        idempotencyKey: keyFor(`retire:${tpl.templateId}`),
                                      },
                                      reason,
                                    ),
                                  );
                                  toast.success(
                                    t("admin.faceEnrol.action.retired", {
                                      name: selected.employee.display_name,
                                    }),
                                  );
                                  refreshAfterDecision();
                                }}
                              />
                            </>
                          ) : null}

                          {tpl.state === "active" ? (
                            <>
                              <ReasonActionButton
                                label={t("admin.faceEnrol.action.retire")}
                                minLength={retire.minReasonLength}
                                title={t("admin.faceEnrol.action.retireTitle", {
                                  version: tpl.version,
                                  name: selected.employee.display_name,
                                })}
                                description={t("admin.faceEnrol.action.retireDescription")}
                                onConfirm={async (reason) => {
                                  await withStepUp(() =>
                                    retire.saveAsync(
                                      {
                                        templateId: tpl.templateId,
                                        idempotencyKey: keyFor(`retire:${tpl.templateId}`),
                                      },
                                      reason,
                                    ),
                                  );
                                  toast.success(
                                    t("admin.faceEnrol.action.retired", {
                                      name: selected.employee.display_name,
                                    }),
                                  );
                                  refreshAfterDecision();
                                }}
                              />
                              <ReasonActionButton
                                label={t("admin.faceEnrol.action.reenrol")}
                                variant="ghost"
                                minLength={reenrol.minReasonLength}
                                title={t("admin.faceEnrol.action.reenrolTitle", {
                                  name: selected.employee.display_name,
                                })}
                                description={t("admin.faceEnrol.action.reenrolDescription")}
                                onConfirm={async (reason) => {
                                  await withStepUp(() =>
                                    reenrol.saveAsync(
                                      {
                                        employeeId: selected.employee.id,
                                        // Keyed by the version being revoked, not
                                        // by the employee: a LATER, genuine forced
                                        // re-enrolment must not replay this one's
                                        // stored response.
                                        idempotencyKey: keyFor(`reenrol:${tpl.templateId}`),
                                      },
                                      reason,
                                    ),
                                  );
                                  toast.success(
                                    t("admin.faceEnrol.action.reenrolled", {
                                      name: selected.employee.display_name,
                                    }),
                                  );
                                  refreshAfterDecision();
                                }}
                              />
                            </>
                          ) : null}

                          {canManageTemplates ? (
                            <ReasonActionButton
                              label={t("admin.faceEnrol.reveal.button")}
                              variant="ghost"
                              minLength={reveal.minReasonLength}
                              title={t("admin.faceEnrol.reveal.title", {
                                name: selected.employee.display_name,
                              })}
                              description={t("admin.faceEnrol.reveal.description")}
                              onConfirm={async (reason) => {
                                await withStepUp(() =>
                                  reveal.saveAsync(selected.employee.id, reason),
                                );
                                setRevealedFor(selected.employee.id);
                              }}
                            />
                          ) : null}
                        </div>
                      </div>
                    ))}

                  {!canManageTemplates ? (
                    <p className="text-xs text-muted-foreground">
                      {t("admin.faceEnrol.reveal.noCap")}
                    </p>
                  ) : null}

                  {revealedFor === selected.employee.id ? (
                    <div className="space-y-2">
                      {revealedTemplates.filter((tpl) => tpl.captureUrl !== null).length === 0 ? (
                        <Notice tone="warning">{t("admin.faceEnrol.reveal.none")}</Notice>
                      ) : (
                        <>
                          <div className="flex flex-wrap gap-3">
                            {revealedTemplates
                              .filter((tpl) => tpl.captureUrl !== null)
                              .map((tpl) => (
                                <figure key={tpl.templateId} className="w-40">
                                  <img
                                    src={tpl.captureUrl ?? ""}
                                    alt={t("admin.faceEnrol.reveal.alt", {
                                      name: selected.employee.display_name,
                                    })}
                                    className="w-40 rounded-md border object-cover"
                                  />
                                  <figcaption className="num mt-1 text-xs text-muted-foreground">
                                    {t("admin.faceEnrol.template.version")}{" "}
                                    {formatNumber(tpl.version)}
                                  </figcaption>
                                </figure>
                              ))}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {t("admin.faceEnrol.reveal.expiry")}
                          </p>
                          <Button variant="ghost" size="sm" onClick={() => setRevealedFor(null)}>
                            {t("admin.faceEnrol.reveal.hide")}
                          </Button>
                        </>
                      )}
                    </div>
                  ) : null}

                  {reveal.userMessage !== null ? (
                    <Notice tone="error">{reveal.userMessage}</Notice>
                  ) : null}

                  {historySets.length > 0 ? (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-muted-foreground">
                        {t("admin.faceEnrol.template.history")}
                      </summary>
                      <ul className="mt-2 space-y-1">
                        {historySets.map((tpl) => (
                          <li key={tpl.templateId} className="flex flex-wrap items-center gap-2">
                            <StatusChip status={tpl.state} map={templateStateChip(tpl.state)} />
                            <span className="num text-muted-foreground">
                              {t("admin.faceEnrol.template.version")} {formatNumber(tpl.version)}
                            </span>
                            <span className="num text-muted-foreground">
                              {dash(tpl.enrolledAt, fmtDateTime)}
                            </span>
                            {tpl.deactivationReason !== null ? (
                              <span className="text-muted-foreground">
                                {tpl.deactivationReason}
                              </span>
                            ) : null}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}

                  <p className="text-xs text-muted-foreground">
                    {t("admin.faceEnrol.action.purgeElsewhere")}
                  </p>
                </div>
              </section>

              {/* Register now */}
              <section className="rounded-lg border bg-background p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h4 className="flex items-center gap-2 text-sm font-semibold">
                      <Camera className="size-4 text-info" aria-hidden />
                      {t("admin.faceEnrol.register.heading")}
                    </h4>
                    <p className="mt-1 max-w-prose text-xs text-muted-foreground">
                      {t("admin.faceEnrol.register.hint")}
                    </p>
                  </div>
                  {cameraFor === selected.employee.id ? (
                    <Button variant="ghost" size="sm" onClick={() => setCameraFor(null)}>
                      {t("admin.faceEnrol.register.close")}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      // CONSENT IS NO LONGER A DEAD END HERE. It used to disable this
                      // button, so an admin with the employee standing in front of
                      // them saw "Register now" greyed out and had to find a
                      // separate consent action first — which reads as "the
                      // enrolment request is blocking registration". Consent is
                      // still REQUIRED (face-enrol refuses without it, and the DPDP
                      // Act is the reason), but it is now collected as the first
                      // step INSIDE this flow, one tap, with the employee present.
                      // `withdrawn` still blocks: someone who has actively revoked
                      // consent must not be re-enrolled by a button press.
                      disabled={hasSubmission || consentState === "withdrawn" || !canEnrol}
                      title={
                        hasSubmission
                          ? t("admin.faceEnrol.register.blockedPending")
                          : consentState === "withdrawn"
                            ? t("admin.faceEnrol.consent.withdrawnNote")
                            : consentState === "none"
                              ? t("admin.faceEnrol.register.needConsent")
                              : !canEnrol
                                ? t("admin.faceEnrol.register.noCap")
                                : undefined
                      }
                      onClick={() => setCameraFor(selected.employee.id)}
                    >
                      {t("admin.faceEnrol.register.open", {
                        name: selected.employee.display_name,
                      })}
                    </Button>
                  )}
                </div>

                {hasSubmission ? (
                  <Notice tone="warning" className="mt-3">
                    {t("admin.faceEnrol.register.blockedPending")}
                  </Notice>
                ) : null}
                {consentState === "none" ? (
                  <Notice tone="warning" className="mt-3">
                    {t("admin.faceEnrol.register.needConsent")}
                  </Notice>
                ) : null}
                {!canEnrol ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    <ShieldAlert className="mr-1 inline size-3.5" aria-hidden />
                    {t("admin.faceEnrol.register.noCap")}
                  </p>
                ) : null}

                {cameraFor === selected.employee.id ? (
                  <div className="mt-3">
                    {consentState === "none" ? (
                      /*
                        STEP ONE, INLINE. The employee is standing here; asking for
                        the notice to be signed is one tap, not a separate screen to
                        hunt for. `face-enrol` refuses without an un-withdrawn
                        consent row for the current notice version, so this cannot
                        be skipped — but it must not be a dead end either, which is
                        what it was.
                      */
                      <div className="rounded-lg border border-warning/40 bg-warning/5 p-4">
                        <h5 className="text-sm font-semibold">
                          {t("admin.faceEnrol.inlineConsent.heading")}
                        </h5>
                        <p className="mt-1 max-w-prose text-xs text-muted-foreground">
                          {t("admin.faceEnrol.inlineConsent.body", {
                            name: selected.employee.display_name,
                          })}
                        </p>
                        <div className="mt-3">
                          <ReasonActionButton
                            label={t("admin.faceEnrol.inlineConsent.button")}
                            title={t("admin.faceEnrol.consent.recordTitle", {
                              name: selected.employee.display_name,
                            })}
                            description={t("admin.faceEnrol.inlineConsent.confirm")}
                            minLength={consent.minReasonLength}
                            onConfirm={async (reason) => {
                              const result = await consent.saveAsync(selected.employee.id, reason);
                              setNotice({
                                tone: result.alreadyOnFile ? "warning" : "success",
                                text: result.alreadyOnFile
                                  ? t("admin.faceEnrol.consent.already", {
                                      version: result.consentVersion,
                                    })
                                  : t("admin.faceEnrol.consent.recorded", {
                                      version: result.consentVersion,
                                    }),
                              });
                              // The roster carries the consent flag the gate reads,
                              // so refresh it before the camera opens — otherwise
                              // the capture would submit against a stale "none".
                              await roster.refetch();
                              await gaps.refetch();
                              if (detailOn) void templates.refetch();
                            }}
                          />
                        </div>
                      </div>
                    ) : (
                      <EnrolCapture
                        employeeId={selected.employee.id}
                        employeeName={selected.employee.display_name}
                        onEnrolled={() => {
                          void requests.refetch();
                          void roster.refetch();
                          if (detailOn) void templates.refetch();
                        }}
                      />
                    )}
                  </div>
                ) : null}
              </section>
            </div>
          )}
        </div>
      </StateBoundary>

      {stepUp.dialog}
    </section>
  );
}
