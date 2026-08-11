/**
 * E-12 · /me/approvals — "Awaiting your action", then "Tracking".
 *
 * The reference product's version of this screen was one sentence: "No Approvals
 * Pending." (DR-47). This one is structurally different: it always renders both
 * sections with their columns, it merges the four things that can actually be
 * waiting on an employee (a decision, a policy acknowledgement, a missing
 * document, an unconfirmed handover), and when there is genuinely nothing it says
 * "You're all caught up." — an outcome, not an absence.
 *
 * Order is `overdue DESC, due ASC, oldest first`, exactly as spec-employee §5
 * E-12 states. Every date, flag and deadline in the list is a server column; the
 * page sorts, it does not judge.
 *
 * The manager "Awaiting your decision" heading is not rendered separately — a
 * decision routed to you is one KIND of pending action, so a non-manager never
 * sees an empty manager section (spec E-12).
 *
 * @route /me/approvals
 */
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Inbox } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/shared/ui/PageHeader";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StateBoundary, PartialBanner } from "@/shared/ui/StateBoundary";
import { t } from "@/shared/i18n/en";
import { fmtCivilDate, fmtDateTime, nowIstDate } from "@/lib/datetime";
import { dash } from "@/lib/format";
import type { ActionKind, PendingAction, PendingActionsResult } from "../api/approvals.api";
import { usePendingActions } from "../hooks/useApprovals";
import { RequestRegister } from "@/features/apply/components/RequestRegister";
import { isRequestSlice, type RequestSlice } from "@/features/apply/api/apply.api";

const KIND_LABEL: Record<ActionKind, string> = {
  decision: t("approvals.kind.decision"),
  policy: t("approvals.kind.policy"),
  document: t("approvals.kind.document"),
  asset: t("approvals.kind.asset"),
};

/** True when a civil date is strictly before today IST — a calendar comparison. */
function isPastCivilDate(isoDate: string | null): boolean {
  return isoDate !== null && isoDate < nowIstDate();
}

/**
 * Merge the four sources into one ordered list.
 *
 * Every field is copied from a server column. The only decision made here is the
 * ORDER, and it is the order the spec dictates.
 */
function buildActions(data: PendingActionsResult): PendingAction[] {
  const out: PendingAction[] = [];

  for (const row of data.decisions) {
    out.push({
      id: `decision:${row.approval_request_id}`,
      kind: "decision",
      what: row.title,
      detail: `${row.request_type_name} · ${row.subject_display_name ?? dash(null)}`,
      dueOn: row.sla_due_at,
      dueIsTimestamp: true,
      overdue: row.is_overdue === true,
      to: "/team/approvals",
    });
  }

  for (const ack of data.acknowledgements) {
    const title = ack.documents?.title ?? null;
    out.push({
      id: `policy:${ack.id}`,
      kind: "policy",
      what:
        title === null
          ? t("approvals.item.policyUnnamed")
          : t("approvals.item.policy", { title }),
      detail: t("approvals.item.policyDetail"),
      dueOn: ack.due_on,
      dueIsTimestamp: false,
      overdue: ack.status === "overdue" || isPastCivilDate(ack.due_on),
      to: `/me/policies/${ack.document_id}`,
    });
  }

  for (const gap of data.documentGaps) {
    const type = gap.document_type_name;
    const what =
      gap.compliance_status === "missing"
        ? t("approvals.item.documentMissing", { type })
        : gap.compliance_status === "expired"
          ? t("approvals.item.documentExpired", { type })
          : t("approvals.item.documentExpiring", { type });
    out.push({
      id: `document:${gap.document_type_id}`,
      kind: "document",
      what,
      detail: t("approvals.item.documentDetail"),
      dueOn: gap.expiry_date,
      dueIsTimestamp: false,
      overdue: gap.compliance_status === "expired",
      to: "/me/profile/documents",
    });
  }

  for (const asset of data.assets) {
    const name = asset.asset_name ?? asset.asset_category_name ?? asset.asset_tag;
    out.push({
      id: `asset:${asset.allocation_id}`,
      kind: "asset",
      what:
        name === null
          ? t("approvals.item.assetUnnamed")
          : t("approvals.item.asset", { asset: name }),
      detail: t("approvals.item.assetDetail"),
      dueOn: asset.expected_return_date,
      dueIsTimestamp: false,
      overdue: asset.is_return_overdue === true,
      to: "/me/assets",
    });
  }

  // overdue DESC, then due ASC (no deadline last), then stable by id.
  return out.sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    if (a.dueOn === null && b.dueOn !== null) return 1;
    if (a.dueOn !== null && b.dueOn === null) return -1;
    if (a.dueOn !== null && b.dueOn !== null && a.dueOn !== b.dueOn) {
      return a.dueOn < b.dueOn ? -1 : 1;
    }
    return a.id.localeCompare(b.id);
  });
}

export default function ApprovalsPage() {
  const actions = usePendingActions();
  const [searchParams, setSearchParams] = useSearchParams();
  const sliceParam = searchParams.get("slice");
  const slice: RequestSlice = isRequestSlice(sliceParam) ? sliceParam : "open";

  const rows = useMemo(
    () => (actions.data ? buildActions(actions.data) : []),
    [actions.data],
  );
  const failures = actions.data?.failures ?? [];

  const columns: DataGridColumn<PendingAction>[] = [
    { key: "what", header: t("approvals.col.what"), render: (row) => row.what },
    {
      key: "kind",
      header: t("approvals.col.kind"),
      width: "9rem",
      render: (row) => <Badge variant="neutral">{KIND_LABEL[row.kind]}</Badge>,
    },
    {
      key: "detail",
      header: t("approvals.col.detail"),
      hideBelow: "md",
      render: (row) => row.detail,
    },
    {
      key: "due",
      header: t("approvals.col.due"),
      width: "14rem",
      render: (row) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="num">
            {row.dueOn === null
              ? dash(null)
              : row.dueIsTimestamp
                ? fmtDateTime(row.dueOn)
                : fmtCivilDate(row.dueOn)}
          </span>
          {row.overdue ? <Badge variant="danger">{t("approvals.overdue")}</Badge> : null}
        </span>
      ),
    },
    {
      key: "action",
      header: t("approvals.col.action"),
      align: "right",
      width: "7rem",
      render: (row) => (
        <Button variant="outline" size="sm" asChild>
          <Link to={row.to}>{t("approvals.open")}</Link>
        </Button>
      ),
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={Inbox}
        title={t("approvals.title")}
        subtitle={t("approvals.subtitle")}
      />

      <section className="mb-8" aria-labelledby="approvals-mine-heading">
        <h2 id="approvals-mine-heading" className="mb-3 font-display text-lg font-semibold">
          {t("approvals.mine.title")}
        </h2>
        <StateBoundary
          loading={actions.isLoading}
          error={actions.error ?? undefined}
          onRetry={() => void actions.refetch()}
        >
          {failures.length > 0 ? <PartialBanner label={t("approvals.partial")} /> : null}
          <DataGrid
            columns={columns}
            rows={rows}
            rowKey={(row) => row.id}
            pageSize={25}
            emptyState={
              <EmptyState
                icon={Inbox}
                title={t("approvals.mine.empty.title")}
                hint={t("approvals.mine.empty.hint")}
              />
            }
          />
        </StateBoundary>
      </section>

      {/*
        ── THE REGISTER, NOT A LIST OF WHAT IS IN FLIGHT ────────────────────

        This section showed `OpenRequestsGrid`, which filters to the three open
        statuses — so a request VANISHED the moment it was decided, and "was mine
        approved or rejected?" had no answer on any screen. The register keeps
        every request of every type, with the stage it reached, who holds it now,
        and the trail of who acted.

        The slice lives in the URL so a filtered view can be linked and survives
        a reload — the same pattern the lifecycle and payroll registers use.
      */}
      <section aria-labelledby="approvals-tracking-heading">
        <h2 id="approvals-tracking-heading" className="font-display text-lg font-semibold">
          {t("approvals.tracking.title")}
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">{t("approvals.tracking.hint")}</p>
        <RequestRegister
          slice={slice}
          onSliceChange={(next) => {
            const params = new URLSearchParams(searchParams);
            if (next === "open") params.delete("slice");
            else params.set("slice", next);
            setSearchParams(params, { replace: true });
          }}
        />
        <p className="mt-2 text-xs text-muted-foreground">{t("approvals.nudge.unavailable")}</p>
      </section>
    </div>
  );
}
