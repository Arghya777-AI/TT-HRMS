/**
 * A-KIOSK-02 · /admin/kiosk/operators — the guards permitted to run the scanner
 * (spec-admin §17).
 *
 * `kiosk_operators` is admin FOR ALL, so unlike the device fleet these controls
 * are available to an admin. What is NOT available here is deliberate:
 *   * `profile_id` / `employee_id` are never patched — re-pointing an operator
 *     row at a different person would move a punching credential without any of
 *     the §17 grant ceremony (admin plus super-admin counter-approval).
 *   * PIN reset, force sign-out and the live session list are remote commands
 *     with no browser-callable endpoint and no table behind them, so the screen
 *     does not offer buttons that would do nothing.
 *
 * The employee name comes from `v_admin_employee`; when that read fails the grid
 * still renders with codes and the partial banner says the names are missing.
 *
 * @route /admin/kiosk/operators
 */
import { useMemo, useState } from "react";
import { ShieldCheck, Users } from "lucide-react";
import { Input } from "@/components/ui/input";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { useQuery } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { fmtDateTime } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { fetchEmployeeOptions, type DirectoryRow } from "../api/employees.api";
import type { KioskOperator } from "../api/kiosk.api";
import {
  useKioskDevices,
  useKioskOperators,
  useOperatorMutation,
  useSetOperatorPin,
  useOperatorRevokeMutation,
} from "../hooks/useKioskConsole";
import { operatorStateChip } from "../kiosk-display";
import { ReasonActionButton } from "../components/ReasonActionButton";
import { KioskSectionNav } from "../components/KioskSectionNav";

export default function KioskOperatorsPage() {
  const operators = useKioskOperators();
  const devices = useKioskDevices();

  // Names for the operator rows. `fetchEmployeeOptions` is the sanctioned
  // directory read; the grid degrades to codes if it fails.
  const employees = useQuery({
    queryKey: qk.admin.employees({ scope: "kiosk-operators" }),
    queryFn: ({ signal }) => fetchEmployeeOptions({}, 300, signal),
    retry: shouldRetryQuery,
  });

  const edit = useOperatorMutation();
  const setPin = useSetOperatorPin();
  const revoke = useOperatorRevokeMutation();

  const employeeById = useMemo(() => {
    const map = new Map<string, DirectoryRow>();
    for (const row of employees.data ?? []) map.set(row.id, row);
    return map;
  }, [employees.data]);

  const deviceById = useMemo(() => {
    const map = new Map<string, { code: string; label: string }>();
    for (const d of devices.data ?? []) map.set(d.id, { code: d.device_code, label: d.label });
    return map;
  }, [devices.data]);

  const rows = operators.data ?? [];
  const activeCount = rows.filter((r) => r.is_active).length;
  const enrolCount = rows.filter((r) => r.is_active && r.can_enrol_faces).length;
  const manualCount = rows.filter((r) => r.is_active && r.can_manual_punch).length;

  function nameOf(row: KioskOperator): string {
    if (row.employee_id === null) return t("admin.kiosk.operators.unknownEmployee");
    const employee = employeeById.get(row.employee_id);
    return employee?.display_name ?? t("admin.kiosk.operators.unknownEmployee");
  }

  const columns: DataGridColumn<KioskOperator>[] = [
    {
      key: "operator",
      header: t("admin.kiosk.operators.col.operator"),
      sortable: true,
      sortValue: (row) => nameOf(row),
      render: (row) => {
        const employee = row.employee_id === null ? undefined : employeeById.get(row.employee_id);
        return (
          <span className="flex flex-col leading-tight">
            <span className="text-sm font-medium">{nameOf(row)}</span>
            {employee ? (
              <span className="font-mono text-xs text-muted-foreground">{employee.employee_code}</span>
            ) : null}
          </span>
        );
      },
    },
    {
      key: "device",
      header: t("admin.kiosk.operators.col.device"),
      hideBelow: "md",
      render: (row) => {
        if (row.kiosk_device_id === null) {
          return (
            <span className="text-xs text-muted-foreground">{t("admin.kiosk.operators.anyDevice")}</span>
          );
        }
        const device = deviceById.get(row.kiosk_device_id);
        if (device === undefined) return dash(null);
        return (
          <span className="flex flex-col leading-tight">
            <span className="font-mono text-xs">{device.code}</span>
            <span className="text-sm">{device.label}</span>
          </span>
        );
      },
    },
    {
      key: "permissions",
      header: t("admin.kiosk.operators.col.permissions"),
      render: (row) => {
        const parts: string[] = [];
        if (row.can_enrol_faces) parts.push(t("admin.kiosk.operators.perm.enrol"));
        if (row.can_manual_punch) parts.push(t("admin.kiosk.operators.perm.manual"));
        if (parts.length === 0) parts.push(t("admin.kiosk.operators.perm.scanOnly"));
        return <span className="text-sm">{parts.join(" · ")}</span>;
      },
    },
    {
      key: "shift_window",
      header: t("admin.kiosk.operators.col.window"),
      hideBelow: "lg",
      render: (row) => dash(row.shift_window),
    },
    {
      key: "last_signed_in_at",
      header: t("admin.kiosk.operators.col.lastSignIn"),
      hideBelow: "md",
      sortable: true,
      render: (row) => dash(row.last_signed_in_at, fmtDateTime),
    },
    {
      key: "state",
      header: t("admin.kiosk.operators.col.state"),
      width: "8rem",
      render: (row) => (
        <StatusChip
          status={row.is_active ? "active" : "revoked"}
          map={operatorStateChip(row.is_active)}
        />
      ),
    },
    {
      key: "actions",
      header: t("admin.kiosk.operators.col.actions"),
      align: "right",
      width: "16rem",
      render: (row) => (
        <span className="inline-flex flex-wrap items-center justify-end gap-1">
          <SetPinAction row={row} nameOf={nameOf} setPin={setPin} />
          <ReasonActionButton
            label={
              row.can_enrol_faces
                ? t("admin.kiosk.operators.action.blockEnrol")
                : t("admin.kiosk.operators.action.allowEnrol")
            }
            variant="ghost"
            title={t("admin.kiosk.operators.enrolChange.title", { name: nameOf(row) })}
            description={t("admin.kiosk.operators.enrolChange.description")}
            onConfirm={(reason) =>
              edit.saveAsync({ id: row.id, patch: { can_enrol_faces: !row.can_enrol_faces } }, reason)
            }
          />
          {row.is_active ? (
            <ReasonActionButton
              label={t("admin.kiosk.operators.action.revoke")}
              variant="outline"
              minLength={revoke.minReasonLength}
              title={t("admin.kiosk.operators.revoke.title", { name: nameOf(row) })}
              description={t("admin.kiosk.operators.revoke.description")}
              onConfirm={(reason) => revoke.saveAsync(row.id, reason)}
            />
          ) : (
            <ReasonActionButton
              label={t("admin.kiosk.operators.action.reinstate")}
              variant="outline"
              title={t("admin.kiosk.operators.reinstate.title", { name: nameOf(row) })}
              description={t("admin.kiosk.operators.reinstate.description")}
              onConfirm={(reason) =>
                edit.saveAsync({ id: row.id, patch: { is_active: true } }, reason)
              }
            />
          )}
        </span>
      ),
    },
  ];

  return (
    <div className="container py-6">
      <PageHeader
        icon={Users}
        title={t("admin.kiosk.operators.title")}
        subtitle={t("admin.kiosk.operators.subtitle")}
      />

      <KioskSectionNav />

      <p className="mb-4 flex items-start gap-2 rounded-md border bg-card px-3 py-2 text-sm text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        {t("admin.kiosk.operators.grantHint")}
      </p>

      <StateBoundary
        loading={operators.isLoading}
        error={operators.error ?? undefined}
        onRetry={() => void operators.refetch()}
        partialError={employees.error ?? devices.error ?? undefined}
        partialLabel={t("admin.kiosk.operators.col.operator")}
        isEmpty={operators.isSuccess && rows.length === 0}
        empty={
          <EmptyState
            icon={Users}
            title={t("admin.kiosk.operators.empty.title")}
            hint={t("admin.kiosk.operators.empty.hint")}
          />
        }
        skeletonRows={4}
      >
        <section className="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
          <KpiTile
            label={t("admin.kiosk.operators.kpi.active")}
            value={formatNumber(activeCount)}
            tone={activeCount > 0 ? "success" : "warn"}
          />
          <KpiTile
            label={t("admin.kiosk.operators.kpi.enrolers")}
            value={formatNumber(enrolCount)}
          />
          <KpiTile
            label={t("admin.kiosk.operators.kpi.manual")}
            value={formatNumber(manualCount)}
            tone={manualCount > 0 ? "warn" : "neutral"}
          />
        </section>

        <DataGrid columns={columns} rows={rows} rowKey={(row) => row.id} pageSize={25} />
      </StateBoundary>
    </div>
  );
}

/**
 * Set PIN — the one action here needing an extra field. The PIN is typed
 * inline; the button opens the standard reason dialog and stays disabled until
 * the PIN is 4–10 digits. On success the field clears and a one-line receipt
 * appears; the PIN itself is never echoed back.
 */
function SetPinAction({
  row,
  nameOf,
  setPin,
}: {
  row: KioskOperator;
  nameOf: (row: KioskOperator) => string;
  setPin: ReturnType<typeof useSetOperatorPin>;
}) {
  const [pin, setPinValue] = useState("");
  const valid = /^\d{4,10}$/.test(pin);
  return (
    <span className="inline-flex items-center gap-1">
      <Input
        value={pin}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => setPinValue(e.target.value.replace(/\D/g, "").slice(0, 10))}
        placeholder={t("admin.kiosk.operators.pin.field")}
        inputMode="numeric"
        type="password"
        autoComplete="off"
        className="h-8 w-36 text-xs"
        aria-label={t("admin.kiosk.operators.pin.field")}
      />
      <ReasonActionButton
        label={t("admin.kiosk.operators.action.setPin")}
        variant="ghost"
        disabled={!valid || setPin.isPending}
        title={t("admin.kiosk.operators.pin.title", { name: nameOf(row) })}
        description={t("admin.kiosk.operators.pin.description")}
        onConfirm={async (reason) => {
          await setPin.saveAsync({ operatorId: row.id, pin }, reason);
          setPinValue("");
        }}
      />
    </span>
  );
}
