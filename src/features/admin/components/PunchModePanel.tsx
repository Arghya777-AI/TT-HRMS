/**
 * PunchModePanel — the admin chooses how each person's hours are counted.
 *
 * It lives on Policy Assignments because that is where an admin already decides which
 * shift, weekly-off rule and attendance policy apply to whom; "and how do we count their
 * day" is the same question.
 *
 * TWO THINGS THIS PANEL IS CAREFUL ABOUT
 *
 * 1. IT EXPLAINS THE CONSEQUENCE BEFORE THE CONTROL. The difference between the two modes
 *    is not obvious from their names, and getting it wrong silently changes what somebody
 *    is paid — a day with a lunchtime scan reported five minutes worked under
 *    `multi_punch`. So the two models are described in words above the list, with the
 *    example that actually happened.
 *
 * 2. IT SAYS THAT HISTORY DOES NOT MOVE. The mode is read when a day is COMPUTED, so
 *    changing it affects tomorrow and leaves last month exactly as it was. An admin who
 *    assumes otherwise will conclude the setting did nothing. The panel names the
 *    recompute screen instead of quietly running one.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Timer } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { shouldRetryQuery } from "@/shared/api/query";
import { asArray } from "@/lib/asArray";
import { t } from "@/shared/i18n/en";
import { PersonCell } from "./PersonCell";
import {
  fetchPunchModes,
  setPunchMode,
  type PunchMode,
  type PunchModeAccess,
} from "../api/punchMode.api";

const MODE_CHIP: Readonly<Record<PunchMode, StatusChipEntry>> = {
  single_punch: { label: t("admin.punchMode.single"), tone: "success" },
  multi_punch: { label: t("admin.punchMode.multi"), tone: "info" },
};

const KEY = ["admin", "punch-mode"] as const;

function ModeButton({ row }: { row: PunchModeAccess }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const next: PunchMode = row.punch_mode === "single_punch" ? "multi_punch" : "single_punch";

  const mutation = useMutation({
    mutationFn: () => setPunchMode(row.employee_id, next),
    onSuccess: (stored) => {
      setError(null);
      // The DATABASE's answer, not the one we asked for.
      qc.setQueriesData<PunchModeAccess[]>({ queryKey: KEY }, (rows) =>
        rows?.map((r) => (r.employee_id === row.employee_id ? { ...r, punch_mode: stored } : r)),
      );
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  if (!row.can_manage) {
    return <span className="text-xs text-muted-foreground">{t("admin.punchMode.noPermission")}</span>;
  }
  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        {next === "single_punch" ? t("admin.punchMode.toSingle") : t("admin.punchMode.toMulti")}
      </Button>
      {error !== null ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}

export function PunchModePanel() {
  const modes = useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => fetchPunchModes(undefined, signal),
    retry: shouldRetryQuery,
  });
  const rows = asArray(modes.data);

  const columns: DataGridColumn<PunchModeAccess>[] = [
    {
      key: "display_name",
      header: t("admin.punchMode.col.person"),
      width: "18rem",
      render: (row) => <PersonCell name={row.display_name ?? "—"} code={row.employee_code ?? ""} />,
    },
    {
      key: "department_name",
      header: t("admin.punchMode.col.department"),
      hideBelow: "md",
      render: (row) => row.department_name ?? "—",
    },
    {
      key: "punch_mode",
      header: t("admin.punchMode.col.mode"),
      width: "13rem",
      render: (row) => <StatusChip status={row.punch_mode} map={MODE_CHIP} />,
    },
    {
      key: "action",
      header: "",
      align: "right",
      width: "15rem",
      render: (row) => <ModeButton row={row} />,
    },
  ];

  return (
    <section className="mt-8">
      <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
        <Timer className="size-4 text-muted-foreground" aria-hidden />
        {t("admin.punchMode.title")}
      </h2>

      {/* The consequence, before the control. */}
      <div className="mt-2 space-y-2 rounded-lg border bg-muted/40 p-3 text-sm leading-relaxed">
        <p>
          <strong>{t("admin.punchMode.single")}</strong> — {t("admin.punchMode.singleExplain")}
        </p>
        <p>
          <strong>{t("admin.punchMode.multi")}</strong> — {t("admin.punchMode.multiExplain")}
        </p>
        <p className="text-muted-foreground">{t("admin.punchMode.historyNote")}</p>
      </div>

      <div className="mt-3">
        <StateBoundary
          loading={modes.isPending}
          error={modes.error}
          onRetry={() => void modes.refetch()}
          isEmpty={!modes.isPending && modes.error === null && rows.length === 0}
          empty={<EmptyState icon={Timer} title={t("admin.punchMode.empty")} />}
          skeletonRows={4}
        >
          <DataGrid columns={columns} rows={rows} rowKey={(r) => r.employee_id} pageSize={15} />
        </StateBoundary>
      </div>
    </section>
  );
}
