/**
 * §2 · /admin/people/changes — Change Requests. The HR/admin decision queue for
 * every field change an employee has proposed about their own record.
 *
 * Without this screen self-service is a dead letter box: migration 011 §2 lets
 * an employee INSERT into `employee_change_requests` and gives them no way to
 * apply one, and `apply_change_request` (011 §3) refuses anything whose status is
 * not already `'approved'`. Nothing could put it there — `authenticated` holds
 * SELECT + INSERT on that table and NO UPDATE (011 §4, re-asserted by 048), and
 * `act_on_approval` decides `approval_requests`, never the detail row behind one.
 * Migration 062 adds `public.decide_change_request`: a definer that stamps the
 * decision and calls the applier IN THE SAME TRANSACTION, so `applied` and the
 * new value on the employee master are one atomic fact.
 *
 * THE DESIGN CENTRE IS THE COMPARISON. Every row shows, side by side,
 *
 *     ON THE RECORD NOW   `old_value` — the jsonb the submitter captured
 *     ASKED FOR           `new_value` — what they want it to be
 *
 * plus who asked, when in IST, and their sentence. Neither value is derived,
 * reformatted or "cleaned up" here: an ISO date is printed through the IST
 * formatter and everything else is printed as it is, because a queue that
 * beautifies a value is a queue that hides a typo.
 *
 * FOUR THINGS THIS SCREEN IS HONEST ABOUT, EACH READ OUT OF THE MIGRATIONS:
 *
 *  1. THERE IS NO REASON COLUMN. `employee_change_requests` carries none. The
 *     sentence the employee typed lives in `approval_requests.summary->>'summary'`
 *     of the request whose `detail_table = 'employee_change_requests'` and
 *     `detail_id` is this row (029 §4; `submitRegimeElection` writes exactly
 *     that). The queue reads those rows and says so plainly when there is none,
 *     rather than showing an empty "Reason:" label.
 *  2. AN OPEN APPROVAL CHAIN OUTRANKS THIS SCREEN. AC-BANK-CHANGE has TWO levels
 *     — hr_admin then finance (045 §3). Applying the field after level 1 would
 *     forge an approval finance never gave, so 062 REFUSES while the chain is
 *     open and this screen disables the buttons, prints the request number and
 *     points at the approval inbox. The gate is the RPC's; the disabled button
 *     is only the courtesy.
 *  3. THE APPLIER CANNOT WRITE EVERY SHAPE. It updates a satellite with
 *     `WHERE id = $2 AND employee_id = $3`, and `employee_statutory` has no `id`
 *     column at all — a tax-regime election therefore has `entity_id IS NULL`
 *     and nothing to update. Such a row is flagged BEFORE the decision, the
 *     confirm button says "Approve without writing", and the result banner tells
 *     HR to record that one field themselves. "Approved, not written" is the
 *     truth; a red "failed" would not be.
 *  4. STEP-UP IS THE SERVER'S CALL, NOT A GUESS. `role_capabilities`
 *     (migration 050) carries `requires_step_up` per capability; the screen asks
 *     for the authenticator code when the matrix flags the capability behind
 *     this action (`employee.update`), and ALWAYS retries once when a server
 *     refuses with `MFA_STEP_UP_REQUIRED`. It does not invent a second factor
 *     the database has not declared — the UI gate is cosmetic either way.
 *
 * Every number is a server COUNT over the same predicate builder as the rows it
 * opens, and no figure on screen is computed in the browser.
 *
 * @route /admin/people/changes
 */
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ShieldCheck, Workflow } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { ReasonDialog } from "@/shared/ui/ReasonDialog";
import { isStepUpRequired, useStepUp } from "@/shared/auth/StepUpDialog";
import { fmtCivilDate, fmtDateTime } from "@/lib/datetime";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import { Notice } from "../components/Notice";
import { CountTile } from "../components/CountTile";
import { StatusMixCard } from "@/shared/ui/charts/StatusMixCard";
import { PersonCell } from "../components/PersonCell";
import { SelectField } from "../components/Field";
import { useEmployeeLabels } from "../hooks/useEmployeeLabels";
import { capRequiresStepUp, useProfileDirectory, useRoleCapabilities } from "../hooks/useSettingsExtra";
import {
  useChangeQueue,
  useChangeQueueCount,
  useDecideChangeRequest,
  useGoverningRequests,
} from "../hooks/useChangeRequestQueue";
import {
  entityTableSchema,
  isAppliableByServer,
  isChainOpen,
  readRequesterNote,
  QUEUE_ROW_CAP,
  type ApprovalStatus,
  type ChangeEntityTable,
  type ChangeQueueFilters,
  type ChangeRequestRow,
  type GoverningRequest,
} from "../api/change-requests.api";

/** The one capability the matrix is consulted for: approving edits a record. */
const DECISION_CAPABILITY = "employee.update";

const STATUS_CHIP: Readonly<Record<string, StatusChipEntry>> = {
  draft: { label: t("admin.chq.status.draft"), tone: "neutral" },
  pending: { label: t("admin.chq.status.pending"), tone: "warn" },
  in_progress: { label: t("admin.chq.status.inProgress"), tone: "info" },
  approved: { label: t("admin.chq.status.approved"), tone: "info" },
  rejected: { label: t("admin.chq.status.rejected"), tone: "danger" },
  cancelled: { label: t("admin.chq.status.cancelled"), tone: "neutral" },
  withdrawn: { label: t("admin.chq.status.withdrawn"), tone: "neutral" },
  expired: { label: t("admin.chq.status.expired"), tone: "neutral" },
  auto_approved: { label: t("admin.chq.status.autoApproved"), tone: "info" },
  escalated: { label: t("admin.chq.status.escalated"), tone: "warn" },
  applied: { label: t("admin.chq.status.applied"), tone: "success" },
  failed: { label: t("admin.chq.status.failed"), tone: "danger" },
};

/** `ck_ecr__entity_table`'s nine values, in words. */
function tableLabel(table: string): string {
  switch (table) {
    case "employees":
      return t("admin.chq.table.employees");
    case "employee_addresses":
      return t("admin.chq.table.addresses");
    case "employee_contacts":
      return t("admin.chq.table.contacts");
    case "employee_dependents":
      return t("admin.chq.table.dependents");
    case "employee_qualifications":
      return t("admin.chq.table.qualifications");
    case "employee_identity_documents":
      return t("admin.chq.table.identityDocuments");
    case "employee_statutory":
      return t("admin.chq.table.statutory");
    case "employee_bank_accounts":
      return t("admin.chq.table.bankAccounts");
    default:
      return t("admin.chq.table.customFields");
  }
}

function statusLabel(status: ApprovalStatus): string {
  return STATUS_CHIP[status]?.label ?? status;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A `jsonb` old/new value, in words. This is a RENDER, not a conversion: a
 * civil date goes through the IST formatter (a bare date must never be parsed as
 * an instant), a boolean becomes yes/no, and anything composite is printed as
 * the JSON it is rather than flattened into a sentence that would lose a field.
 */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return t("admin.chq.notSet");
  if (typeof value === "string") {
    if (value === "") return t("admin.chq.notSet");
    return ISO_DATE.test(value) ? fmtCivilDate(value) : value;
  }
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "boolean") return value ? t("common.yes") : t("common.no");
  return JSON.stringify(value);
}

type ViewSlice = "pending" | "awaiting-entry" | "failed" | "decided" | "all";

const VIEW_SLICES: readonly ViewSlice[] = [
  "pending",
  "awaiting-entry",
  "failed",
  "decided",
  "all",
];

const VIEW_LABEL: Readonly<Record<ViewSlice, string>> = {
  pending: t("admin.chq.view.pending"),
  "awaiting-entry": t("admin.chq.view.awaitingEntry"),
  failed: t("admin.chq.view.failed"),
  decided: t("admin.chq.view.decided"),
  all: t("admin.chq.view.all"),
};

/**
 * Each slice as a filter set. Module constants, not values built in render, so a
 * tile's count and the rows it opens are literally the same predicate and the
 * query keys stay stable across renders (DR-29).
 */
const PENDING_FILTERS: ChangeQueueFilters = { statuses: ["pending"] };
const SENSITIVE_PENDING_FILTERS: ChangeQueueFilters = {
  statuses: ["pending"],
  sensitiveOnly: true,
};
const AWAITING_ENTRY_FILTERS: ChangeQueueFilters = {
  statuses: ["approved"],
  notApplied: true,
};
const FAILED_FILTERS: ChangeQueueFilters = { failedOnly: true };
const DECIDED_FILTERS: ChangeQueueFilters = {
  statuses: ["applied", "approved", "rejected", "failed"],
};
const ALL_FILTERS: ChangeQueueFilters = {};

const SLICE_FILTERS: Readonly<Record<ViewSlice, ChangeQueueFilters>> = {
  pending: PENDING_FILTERS,
  "awaiting-entry": AWAITING_ENTRY_FILTERS,
  failed: FAILED_FILTERS,
  decided: DECIDED_FILTERS,
  all: ALL_FILTERS,
};

function isViewSlice(value: string | null): value is ViewSlice {
  return value !== null && (VIEW_SLICES as readonly string[]).includes(value);
}

/** One side of the comparison. */
function ValueBlock({
  label,
  value,
  highlight,
}: {
  label: string;
  value: unknown;
  highlight: boolean;
}) {
  return (
    <div
      className={cn(
        "rounded-md border p-3",
        highlight ? "border-primary/40" : "border-dashed",
      )}
    >
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 break-words text-sm">{renderValue(value)}</p>
    </div>
  );
}

/** The governing chain's line, when there is one. */
function ChainLine({ chain }: { chain: GoverningRequest }) {
  const open = isChainOpen(chain);
  return (
    <Notice
      tone={open ? "warning" : "info"}
      action={
        open ? (
          <Button asChild variant="ghost" size="sm">
            <Link to="/admin/workflow/inbox">{t("admin.chq.chain.inbox")}</Link>
          </Button>
        ) : null
      }
    >
      {open
        ? t("admin.chq.chain.open", {
            number: chain.request_number,
            status: statusLabel(chain.status),
            level: formatNumber(chain.current_level),
            levels: formatNumber(chain.total_levels),
          })
        : t("admin.chq.chain.settled", {
            number: chain.request_number,
            status: statusLabel(chain.status),
          })}
    </Notice>
  );
}

type Target = { row: ChangeRequestRow; action: "approve" | "reject" };

/**
 * What the decision dialog must say. `field_label` is authored by the client that
 * raised the request and is never re-derived server-side; only `field_name` is
 * validated (against public.employee_changeable_fields()), and
 * `apply_change_request` writes off `field_name`. So the sentence HR approves on
 * names the trusted column, with the submitted label kept only as context when it
 * differs — otherwise a crafted request could read "Blood group" while the column
 * being written was `mobile`.
 */
function decisionFieldLabel(row: { field_label: string; field_name: string }): string {
  const label = row.field_label.trim();
  return label === "" || label === row.field_name
    ? row.field_name
    : `${row.field_name} (submitted as "${label}")`;
}

export default function ChangeRequestsPage() {
  const [params, setParams] = useSearchParams();
  const rawView = params.get("view");
  const view: ViewSlice = isViewSlice(rawView) ? rawView : "pending";
  const [table, setTable] = useState<ChangeEntityTable | "">("");
  // URL state, not component state: the Sensitive TILE drills through to
  // `?sensitive=1`, and a tile whose number is counted with a predicate its own
  // link does not apply is the count-and-drill-disagree defect.
  const sensitiveOnly = params.get("sensitive") === "1";

  const filters = useMemo<ChangeQueueFilters>(
    () => ({
      ...SLICE_FILTERS[view],
      ...(table !== "" ? { entityTables: [table] } : {}),
      ...(sensitiveOnly ? { sensitiveOnly: true } : {}),
    }),
    [view, table, sensitiveOnly],
  );

  const queue = useChangeQueue(filters);
  const rows = useMemo(() => queue.data ?? [], [queue.data]);
  const matching = useChangeQueueCount(filters);

  const pendingCount = useChangeQueueCount(PENDING_FILTERS);
  const sensitiveCount = useChangeQueueCount(SENSITIVE_PENDING_FILTERS);
  const manualCount = useChangeQueueCount(AWAITING_ENTRY_FILTERS);
  const failedCount = useChangeQueueCount(FAILED_FILTERS);

  const labels = useEmployeeLabels();
  const profiles = useProfileDirectory();
  const capabilities = useRoleCapabilities();
  const { byChangeRequest } = useGoverningRequests(rows);
  const decide = useDecideChangeRequest();
  const stepUp = useStepUp();

  const [target, setTarget] = useState<Target | null>(null);
  const [outcomeDismissed, setOutcomeDismissed] = useState(false);

  const needsStepUp = capRequiresStepUp(capabilities.data, DECISION_CAPABILITY);

  const profileNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of profiles.data ?? []) map.set(p.id, p.full_name);
    return map;
  }, [profiles.data]);

  const setView = (next: ViewSlice) => {
    const p = new URLSearchParams(params);
    if (next === "pending") p.delete("view");
    else p.set("view", next);
    setParams(p, { replace: true });
  };

  const setSensitiveOnly = (next: boolean) => {
    const p = new URLSearchParams(params);
    if (next) p.set("sensitive", "1");
    else p.delete("sensitive");
    setParams(p, { replace: true });
  };

  const personOf = (employeeId: string) => labels.data?.get(employeeId) ?? null;
  const actorName = (profileId: string | null) =>
    profileId === null
      ? t("admin.chq.actorUnknown")
      : (profileNames.get(profileId) ?? t("admin.chq.actorUnknown"));

  /** Ask for the second factor when the matrix says so; retry once if refused. */
  async function withStepUp(write: () => Promise<unknown>): Promise<void> {
    if (needsStepUp) {
      const upgraded = await stepUp.ensureAal2();
      if (!upgraded) return;
    }
    try {
      await write();
    } catch (error) {
      if (!isStepUpRequired(error)) return;
      const upgraded = await stepUp.ensureAal2();
      if (!upgraded) return;
      await write().catch(() => undefined);
    }
  }

  const confirm = (comment: string) => {
    if (target === null) return;
    const { row, action } = target;
    setTarget(null);
    setOutcomeDismissed(false);
    // ONE typed sentence, two audiences: the audit reason 062 demands as the
    // X-Reason header, and the decision comment the employee reads on their own
    // record history.
    void withStepUp(() =>
      decide.saveAsync({ changeRequestId: row.id, decision: action, comment }, comment),
    );
  };

  const result = decide.data;
  const outcomeLine = useMemo(() => {
    if (result === undefined) return null;
    const subject = rows.find((r) => r.id === result.change_request_id);
    const whoName =
      (subject === undefined ? undefined : labels.data?.get(subject.employee_id)?.name) ??
      t("admin.common.unknownPerson");
    if (result.decision === "rejected") {
      return t("admin.chq.outcome.rejected", { field: result.field_label, who: whoName });
    }
    if (result.apply_error !== null) {
      return t("admin.chq.outcome.failed", {
        field: result.field_label,
        error: result.apply_error,
      });
    }
    if (!result.applied) {
      return t("admin.chq.outcome.approvedNotApplied", {
        field: result.field_label,
        who: whoName,
        table: tableLabel(result.entity_table),
      });
    }
    return t("admin.chq.outcome.applied", { field: result.field_label, who: whoName });
    // `rows` and `labels` only sharpen the name; the sentence itself is the RPC's.
  }, [result, rows, labels.data]);

  const outcomeTone =
    result === undefined
      ? "info"
      : result.decision === "rejected"
        ? "info"
        : result.apply_error !== null
          ? "error"
          : result.applied
            ? "success"
            : "warning";

  const targetChain = target === null ? undefined : byChangeRequest.get(target.row.id);
  const targetAppliable =
    target === null ? true : isAppliableByServer(target.row) && !isChainOpen(targetChain);

  return (
    <div className="container py-6">
      <PageHeader
        icon={Workflow}
        title={t("admin.chq.title")}
        subtitle={
          pendingCount.isSuccess
            ? t("admin.chq.subtitle", { n: formatNumber(pendingCount.data) })
            : t("admin.chq.subtitlePlain")
        }
      />

      {/*
        WHAT THE BACKLOG IS MADE OF — and it is the BACKLOG, not the register.
        The three bands are disjoint (`pending`, `approved ∧ not applied`,
        `status = failed`) but they are three of five states: applied and rejected
        requests are finished and deliberately absent, so the caption names what
        the whole is rather than letting a reader assume it is everything.

        `sensitive` is a tile above and NOT a band here: it is `pending ∧
        sensitive`, a subset of the first band, so drawing it would count those
        rows twice.

        The distinction the bar makes that four numbers do not: a backlog waiting
        on APPROVAL is a queue somebody has to work through, one waiting on MANUAL
        ENTRY is a queue somebody has already agreed to, and a FAILED one is
        broken. They need different people.
      */}
      <div className="mb-4">
        <StatusMixCard
          title={t("admin.chq.mix.title")}
          hint={t("admin.chq.mix.hint")}
          format={(v) => formatNumber(v)}
          totalCaption={(n) => t("admin.chq.mix.total", { n: formatNumber(n) })}
          segments={[
            {
              key: "pending",
              label: t("admin.chq.tile.pending"),
              value: pendingCount.data,
              tone: "late",
            },
            {
              key: "manual",
              label: t("admin.chq.tile.manual"),
              value: manualCount.data,
              tone: "employer",
            },
            {
              key: "failed",
              label: t("admin.chq.tile.failed"),
              value: failedCount.data,
              tone: "absent",
            },
          ]}
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <CountTile
          label={t("admin.chq.tile.pending")}
          hint={t("admin.chq.tile.pendingHint")}
          to="/admin/people/changes"
          drillLabel={t("admin.chq.tile.pendingDrill")}
          source={t("admin.chq.tile.pendingSource")}
          query={pendingCount}
          toneFor={(n) => (n > 0 ? "warn" : "success")}
        />
        <CountTile
          label={t("admin.chq.tile.sensitive")}
          hint={t("admin.chq.tile.sensitiveHint")}
          to="/admin/people/changes?sensitive=1"
          drillLabel={t("admin.chq.tile.sensitiveDrill")}
          source={t("admin.chq.tile.sensitiveSource")}
          query={sensitiveCount}
          toneFor={(n) => (n > 0 ? "info" : "neutral")}
        />
        <CountTile
          label={t("admin.chq.tile.manual")}
          hint={t("admin.chq.tile.manualHint")}
          to="/admin/people/changes?view=awaiting-entry"
          drillLabel={t("admin.chq.tile.manualDrill")}
          source={t("admin.chq.tile.manualSource")}
          query={manualCount}
          toneFor={(n) => (n > 0 ? "warn" : "neutral")}
        />
        <CountTile
          label={t("admin.chq.tile.failed")}
          hint={t("admin.chq.tile.failedHint")}
          to="/admin/people/changes?view=failed"
          drillLabel={t("admin.chq.tile.failedDrill")}
          source={t("admin.chq.tile.failedSource")}
          query={failedCount}
          toneFor={(n) => (n > 0 ? "danger" : "success")}
        />
      </div>

      <div className="mt-4 grid gap-3 rounded-lg border bg-card p-4 sm:grid-cols-4">
        <SelectField
          label={t("admin.chq.filter.view")}
          value={view}
          options={VIEW_SLICES.map((slice) => ({ value: slice, label: VIEW_LABEL[slice] }))}
          onChange={(value) => {
            if (isViewSlice(value)) setView(value);
          }}
        />
        <SelectField
          label={t("admin.chq.filter.table")}
          value={table}
          placeholder={t("admin.chq.filter.anyTable")}
          options={entityTableSchema.options.map((name) => ({
            value: name,
            label: tableLabel(name),
          }))}
          onChange={(value) => {
            const parsed = entityTableSchema.safeParse(value);
            setTable(parsed.success ? parsed.data : "");
          }}
        />
        <SelectField
          label={t("admin.chq.filter.sensitivity")}
          value={sensitiveOnly ? "only" : "any"}
          options={[
            { value: "any", label: t("admin.chq.sensitivity.any") },
            { value: "only", label: t("admin.chq.sensitivity.only") },
          ]}
          onChange={(value) => setSensitiveOnly(value === "only")}
        />
        <div className="flex items-end justify-between gap-2">
          {table !== "" || sensitiveOnly ? (
            <Button
              variant="ghost"
              onClick={() => {
                setTable("");
                setSensitiveOnly(false);
              }}
            >
              {t("admin.chq.filter.clear")}
            </Button>
          ) : (
            <span />
          )}
          <p className="pb-2 text-sm text-muted-foreground">
            {matching.isSuccess
              ? t("admin.chq.matching", { n: formatNumber(matching.data) })
              : t("admin.chq.matchingUnknown")}
          </p>
        </div>
      </div>

      {outcomeLine !== null && !outcomeDismissed ? (
        <div className="mt-4">
          <Notice
            tone={outcomeTone}
            action={
              <Button variant="ghost" size="sm" onClick={() => setOutcomeDismissed(true)}>
                {t("admin.chq.dismiss")}
              </Button>
            }
          >
            {outcomeLine}
          </Notice>
        </div>
      ) : null}

      {decide.userMessage !== null && target === null ? (
        <div className="mt-4">
          <Notice tone="error">{decide.userMessage}</Notice>
        </div>
      ) : null}

      {matching.isSuccess && matching.data > QUEUE_ROW_CAP ? (
        <div className="mt-4">
          <Notice tone="warning">
            {t("admin.chq.cap", { n: formatNumber(QUEUE_ROW_CAP) })}
          </Notice>
        </div>
      ) : null}

      <div className="mt-4">
        <StateBoundary
          loading={queue.isPending}
          error={queue.error}
          onRetry={() => void queue.refetch()}
          isEmpty={rows.length === 0}
          empty={
            <EmptyState
              icon={ShieldCheck}
              title={
                view === "pending"
                  ? t("admin.chq.empty.pendingTitle")
                  : t("admin.chq.empty.title")
              }
              hint={
                view === "pending"
                  ? t("admin.chq.empty.pendingHint")
                  : t("admin.chq.empty.hint")
              }
            />
          }
        >
          <ul className="space-y-3">
            {rows.map((row) => {
              const who = personOf(row.employee_id);
              const chain = byChangeRequest.get(row.id);
              const chainOpen = isChainOpen(chain);
              const note = readRequesterNote(chain);
              const appliable = isAppliableByServer(row);
              const decidable = row.status === "pending" && !chainOpen;
              return (
                <li key={row.id} className="rounded-lg border bg-card p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-4">
                      <PersonCell
                        name={who?.name ?? null}
                        code={who?.code ?? null}
                        secondary={who?.department ?? null}
                      />
                      <div className="min-w-0">
                        {/*
                          `field_label` is authored by the CLIENT that raised the
                          request and is never re-derived server-side — only
                          `field_name` is validated, against
                          public.employee_changeable_fields(). Approving on the
                          label alone would let a crafted request read
                          "Blood group" while `field_name` was `mobile`, and
                          `apply_change_request` writes off `field_name`. The
                          authoritative column is therefore shown next to the
                          label so the decision is made on the trusted fact.
                        */}
                        <p className="text-sm font-medium">
                          {row.field_label}
                          <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
                            {row.field_name}
                          </span>
                        </p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {tableLabel(row.entity_table)}
                          {" · "}
                          {t("admin.chq.raisedBy", {
                            who: actorName(row.requested_by),
                            at: fmtDateTime(row.requested_at),
                          })}
                        </p>
                        {row.effective_from !== null ? (
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {t("admin.chq.effectiveFrom", {
                              date: fmtCivilDate(row.effective_from),
                            })}
                          </p>
                        ) : null}
                      </div>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      {row.is_sensitive ? (
                        <Badge variant="warning">{t("admin.chq.sensitiveChip")}</Badge>
                      ) : null}
                      <StatusChip status={row.status} map={STATUS_CHIP} />
                    </div>
                  </div>

                  {/* The comparison: what the record says, and what was asked for. */}
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <ValueBlock
                      label={t("admin.chq.onRecord")}
                      value={row.old_value}
                      highlight={false}
                    />
                    <ValueBlock
                      label={t("admin.chq.proposed")}
                      value={row.new_value}
                      highlight={row.status === "pending"}
                    />
                  </div>

                  <p className="mt-3 text-sm">
                    <span className="text-muted-foreground">{t("admin.chq.theirReason")} </span>
                    {note ?? (
                      <span className="text-muted-foreground">{t("admin.chq.noReason")}</span>
                    )}
                  </p>

                  {chain !== undefined ? (
                    <div className="mt-3">
                      <ChainLine chain={chain} />
                    </div>
                  ) : null}

                  {row.status === "pending" && !appliable ? (
                    <div className="mt-3">
                      <Notice tone="warning">
                        {t("admin.chq.manual.warn", { table: tableLabel(row.entity_table) })}
                      </Notice>
                    </div>
                  ) : null}

                  {row.decision_comment !== null ? (
                    <p className="mt-3 text-sm">
                      <span className="text-muted-foreground">
                        {t("admin.chq.decisionComment")}{" "}
                      </span>
                      {row.decision_comment}
                    </p>
                  ) : null}

                  {row.decided_at !== null ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("admin.chq.decidedBy", {
                        who: actorName(row.decided_by),
                        at: fmtDateTime(row.decided_at),
                      })}
                      {row.applied_at !== null
                        ? " · " + t("admin.chq.appliedAt", { at: fmtDateTime(row.applied_at) })
                        : ""}
                    </p>
                  ) : null}

                  {row.apply_error !== null ? (
                    <div className="mt-3">
                      <Notice tone="error">
                        {t("admin.chq.applyError", { error: row.apply_error })}
                      </Notice>
                    </div>
                  ) : null}

                  <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                    {who?.code != null ? (
                      <Button asChild variant="ghost" size="sm">
                        <Link to={`/admin/people/${who.code}`}>
                          {t("admin.chq.openRecord")}
                        </Link>
                      </Button>
                    ) : null}
                    {decidable ? (
                      <>
                        <Button
                          variant="outline"
                          onClick={() => setTarget({ row, action: "reject" })}
                          disabled={decide.isPending}
                        >
                          {t("admin.chq.reject")}
                        </Button>
                        <Button
                          onClick={() => setTarget({ row, action: "approve" })}
                          disabled={decide.isPending}
                        >
                          {t("admin.chq.approve")}
                        </Button>
                      </>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </StateBoundary>
      </div>

      <div className="mt-4">
        <Notice tone="info">{t("admin.chq.footnote")}</Notice>
      </div>

      <ReasonDialog
        open={target !== null}
        title={
          target === null
            ? undefined
            : target.action === "reject"
              ? t("admin.chq.dialog.rejectTitle", {
                  field: decisionFieldLabel(target.row),
                  name: personOf(target.row.employee_id)?.name ?? "",
                })
              : t("admin.chq.dialog.approveTitle", {
                  field: decisionFieldLabel(target.row),
                  name: personOf(target.row.employee_id)?.name ?? "",
                })
        }
        description={
          target === null
            ? undefined
            : target.action === "reject"
              ? t("admin.chq.dialog.rejectDescription", {
                  to: renderValue(target.row.new_value),
                })
              : t("admin.chq.dialog.approveDescription", {
                  from: renderValue(target.row.old_value),
                  to: renderValue(target.row.new_value),
                })
        }
        confirmLabel={
          target?.action === "reject"
            ? t("admin.chq.dialog.rejectConfirm")
            : targetAppliable
              ? t("admin.chq.dialog.approveConfirm")
              : t("admin.chq.dialog.approveConfirmManual")
        }
        minLength={decide.minReasonLength}
        pending={decide.isPending}
        errorMessage={decide.userMessage}
        onConfirm={confirm}
        onCancel={() => setTarget(null)}
      />

      {stepUp.dialog}
    </div>
  );
}
