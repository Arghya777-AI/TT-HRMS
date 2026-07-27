/**
 * A-13.5 · /admin/audit/sessions — Login & Session Audit over `sessions_audit`.
 *
 * The table's shape drives the screen, and one detail matters more than the rest:
 * a FAILED login has no `profile_id`. It cannot — the credential did not resolve
 * to a user. All it carries is `attempted_email` and `failure_reason`. So the
 * "who" column falls back to the attempted address, rendered as what it is (an
 * attempt, not a person), and the email search box exists precisely so a
 * credential-stuffing run against an address that is not even in the system is
 * findable.
 *
 * §13.5 also asks for anomaly flags — new device / new city / impossible travel /
 * out-of-hours. Only the last is derivable from the deployed row: `geo` is a
 * nullable jsonb the auth edge functions populate opportunistically, and there is
 * no per-profile device or city baseline table to compare against. Out-of-hours
 * is flagged from the IST hour, which the row does carry. The other three are
 * called out in the footnote rather than faked from one row's worth of context.
 * (The employee-facing trail at /me/activity DOES flag a new device, because it
 * reads one profile's whole history and can prove novelty; a seven-day
 * company-wide window cannot, which is why the flag is not repeated here.)
 *
 * WHERE FROM. The `geo` jsonb and the `user_agent` are read through the shared
 * `readPlace` / `readDevice` (features/settings/signin/analysis) — the same two
 * functions the employee's own screen uses, so an administrator and the employee
 * never see the same row described as two different devices or two different
 * places. `readPlace` returns null unless the row genuinely carried a place or
 * coordinates: an IP address is never turned into a city here. `isOutsideNormalHours`
 * comes from the same module so the 07:00–21:00 IST rule has one definition.
 *
 * @route /admin/audit/sessions
 */
import { useMemo } from "react";
import { Link, useNavigate } from "react-router-dom";
import { KeyRound, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { KpiTile } from "@/shared/ui/KpiTile";
import { PageHeader } from "@/shared/ui/PageHeader";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip } from "@/shared/ui/StatusChip";
import { fmtCivilDate, fmtDateTime, istRangeInstantBounds } from "@/lib/datetime";
import { dash, formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import {
  isOutsideNormalHours,
  readDevice,
  readPlace,
} from "@/features/settings/signin/analysis";
import {
  sessionAuthMethodValues,
  sessionEventValues,
  type SessionAuditFilters,
  type SessionAuditRow,
} from "../api/audit-registers.api";
import {
  authMethodLabel,
  loadedLabel,
  sessionEventChip,
  sessionEventLabel,
} from "../audit/display";
import {
  AUDIT_PAGE_SIZE,
  flattenPages,
  useActorNames,
  useActorOptions,
  useSessionAudit,
} from "../audit/hooks";
import {
  AuditFilterBar,
  MultiSelectFilter,
  RangeFilter,
  TextFilter,
  ToggleFilter,
  type ActiveChip,
} from "../audit/components/AuditFilterBar";
import { LoadMoreFooter } from "../audit/components/AuditListShell";
import { readBool, readList, readText, useAuditUrlFilters } from "../audit/url-state";

export default function AuditSessionsPage() {
  const navigate = useNavigate();
  const { params, preset, window, patch, clearAll, hasActiveFilters } = useAuditUrlFilters("d7");

  const profileIds = readList(params, "actor");
  const events = readList(params, "event");
  const authMethods = readList(params, "method");
  const emailLike = readText(params, "email");
  const ipLike = readText(params, "ip");
  const onlyFailures = readBool(params, "failures");

  // Joined form = the stable identity of a URL-derived multi-select.
  const profileKey = profileIds.join(",");
  const eventKey = events.join(",");
  const methodKey = authMethods.join(",");

  // `recorded_at` is a timestamptz: the window must be UTC INSTANTS spanning the
  // IST days, or the first 05:30 of every day silently disappears.
  const instantWindow = useMemo(
    () => istRangeInstantBounds(window.from, window.to),
    [window.from, window.to],
  );

  const filters: SessionAuditFilters = useMemo(
    () => ({
      from: instantWindow.fromInstant,
      to: instantWindow.toInstantExclusive,
      ...(profileIds.length > 0 ? { profileIds } : {}),
      ...(events.length > 0 ? { events } : {}),
      ...(authMethods.length > 0 ? { authMethods } : {}),
      ...(emailLike !== "" ? { emailLike } : {}),
      ...(ipLike !== "" ? { ipLike } : {}),
      ...(onlyFailures ? { onlyFailures: true } : {}),
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      instantWindow.fromInstant,
      instantWindow.toInstantExclusive,
      profileKey,
      eventKey,
      methodKey,
      emailLike,
      ipLike,
      onlyFailures,
    ],
  );

  const sessions = useSessionAudit(filters);
  const rows = useMemo(() => flattenPages(sessions.data), [sessions.data]);

  const loadedProfileIds = useMemo(() => {
    const set = new Set<string>();
    for (const row of rows) if (row.profile_id !== null) set.add(row.profile_id);
    return [...set].sort();
  }, [rows]);
  const names = useActorNames(loadedProfileIds);
  const actorOptions = useActorOptions();

  const failures = useMemo(() => rows.filter((r) => r.event === "login_failed").length, [rows]);
  const revocations = useMemo(() => rows.filter((r) => r.event === "session_revoked").length, [rows]);
  const outOfHours = useMemo(
    () => rows.filter((r) => isOutsideNormalHours(r.recorded_at)).length,
    [rows],
  );

  const scopeNumbers = t("adminAudit.sessions.scopeNumbers", {
    n: formatNumber(rows.length),
    from: fmtCivilDate(window.from),
    to: fmtCivilDate(window.to),
  });

  const columns: DataGridColumn<SessionAuditRow>[] = useMemo(
    () => [
      {
        key: "recorded_at",
        header: t("adminAudit.col.when"),
        width: "12rem",
        sortable: true,
        sortValue: (row) => row.recorded_at,
        render: (row) => (
          <span className="num whitespace-nowrap">{fmtDateTime(row.recorded_at)}</span>
        ),
      },
      {
        key: "event",
        header: t("adminAudit.sessions.col.event"),
        width: "11rem",
        render: (row) => <StatusChip status={row.event} map={sessionEventChip(row.event)} />,
      },
      {
        key: "who",
        header: t("adminAudit.sessions.col.who"),
        render: (row) => {
          if (row.profile_id !== null) {
            const profile = names.data?.get(row.profile_id);
            return (
              <span onClick={(e) => e.stopPropagation()}>
                <Link
                  to={`/admin/audit/user/${row.profile_id}`}
                  className="flex flex-col leading-tight rounded underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="truncate">
                    {profile?.full_name ?? row.attempted_email ?? t("adminAudit.actor.unknown")}
                  </span>
                  {profile?.email !== undefined ? (
                    <span className="truncate text-xs text-muted-foreground">{profile.email}</span>
                  ) : null}
                </Link>
              </span>
            );
          }
          // No profile_id: this is an ATTEMPT, and saying so is the whole value
          // of the row. Rendering it as a person would invent a user.
          return (
            <span className="flex flex-col leading-tight">
              <span className="truncate font-mono text-xs">{dash(row.attempted_email)}</span>
              <span className="text-xs text-muted-foreground">
                {t("adminAudit.sessions.notAUser")}
              </span>
            </span>
          );
        },
      },
      {
        key: "auth_method",
        header: t("adminAudit.sessions.col.method"),
        width: "8rem",
        hideBelow: "md",
        render: (row) => authMethodLabel(row.auth_method),
      },
      {
        key: "ip",
        header: t("adminAudit.field.ip"),
        width: "10rem",
        hideBelow: "lg",
        render: (row) => <span className="font-mono text-xs">{dash(row.ip)}</span>,
      },
      {
        // The place the row CARRIED, not one inferred from the address beside it.
        key: "geo",
        header: t("signIn.admin.col.from"),
        width: "11rem",
        hideBelow: "lg",
        render: (row) => {
          const place = readPlace(row.geo);
          if (place === null) {
            return (
              <span className="text-xs italic text-muted-foreground">
                {t("signIn.admin.place.none")}
              </span>
            );
          }
          return (
            <span className="flex flex-col leading-tight">
              <span className="truncate text-xs">{place.label}</span>
              {place.accuracy === null ? null : (
                <span className="text-xs text-muted-foreground">{place.accuracy}</span>
              )}
            </span>
          );
        },
      },
      {
        key: "device_id",
        header: t("adminAudit.field.device"),
        hideBelow: "lg",
        render: (row) => {
          // Named in words, with the opaque id underneath — the console showed
          // only `device_id`, which for a browser sign-in is usually NULL.
          const device = readDevice(row);
          return (
            <span className="flex flex-col leading-tight">
              <span className="truncate text-xs">{device.label}</span>
              {device.deviceId === null ? null : (
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {device.deviceId}
                </span>
              )}
            </span>
          );
        },
      },
      {
        key: "failure_reason",
        header: t("adminAudit.sessions.col.outcome"),
        hideBelow: "md",
        render: (row) =>
          row.failure_reason !== null && row.failure_reason.trim() !== "" ? (
            <span className="text-sm text-destructive">{row.failure_reason}</span>
          ) : (
            <span className="text-sm text-muted-foreground">
              {t("adminAudit.sessions.noFailure")}
            </span>
          ),
      },
      {
        key: "flags",
        header: t("adminAudit.col.flags"),
        width: "7rem",
        align: "center",
        hideBelow: "lg",
        render: (row) =>
          isOutsideNormalHours(row.recorded_at) ? (
            <span className="inline-flex items-center gap-1 text-xs text-warning">
              <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
              {t("adminAudit.sessions.outOfHours")}
            </span>
          ) : (
            dash(null)
          ),
      },
    ],
    [names.data],
  );

  const chips: readonly ActiveChip[] = useMemo(() => {
    const out: ActiveChip[] = [];
    const nameOf = (id: string): string =>
      (actorOptions.data ?? []).find((a) => a.id === id)?.full_name ?? t("adminAudit.actor.unknown");
    for (const id of profileIds) {
      out.push({
        id: `actor:${id}`,
        label: t("adminAudit.chip.actor", { value: nameOf(id) }),
        onRemove: () => patch({ actor: profileIds.filter((v) => v !== id) }),
      });
    }
    for (const e of events) {
      out.push({
        id: `event:${e}`,
        label: t("adminAudit.chip.event", { value: sessionEventLabel(e) }),
        onRemove: () => patch({ event: events.filter((v) => v !== e) }),
      });
    }
    for (const m of authMethods) {
      out.push({
        id: `method:${m}`,
        label: t("adminAudit.chip.method", { value: authMethodLabel(m) }),
        onRemove: () => patch({ method: authMethods.filter((v) => v !== m) }),
      });
    }
    if (emailLike !== "")
      out.push({
        id: "email",
        label: t("adminAudit.chip.email", { value: emailLike }),
        onRemove: () => patch({ email: null }),
      });
    if (ipLike !== "")
      out.push({
        id: "ip",
        label: t("adminAudit.chip.ip", { value: ipLike }),
        onRemove: () => patch({ ip: null }),
      });
    if (onlyFailures)
      out.push({
        id: "failures",
        label: t("adminAudit.sessions.filter.failuresOnly"),
        onRemove: () => patch({ failures: null }),
      });
    return out;
  }, [profileIds, events, authMethods, emailLike, ipLike, onlyFailures, actorOptions.data, patch]);

  return (
    <div className="container py-6">
      <PageHeader
        icon={KeyRound}
        title={t("adminAudit.sessions.title")}
        subtitle={t("adminAudit.sessions.subtitle")}
      />

      <AuditFilterBar
        chips={chips}
        onClearAll={clearAll}
        resultLabel={loadedLabel(rows.length, sessions.hasNextPage)}
      >
        <RangeFilter preset={preset} window={window} patch={patch} />
        <MultiSelectFilter
          label={t("adminAudit.filter.actor")}
          options={(actorOptions.data ?? []).map((a) => ({
            value: a.id,
            label: a.full_name,
            hint: a.email,
          }))}
          selected={profileIds}
          onChange={(next) => patch({ actor: next })}
          searchable
          loading={actorOptions.isLoading}
          emptyHint={t("adminAudit.filter.noActors")}
        />
        <MultiSelectFilter
          label={t("adminAudit.sessions.filter.event")}
          options={sessionEventValues.map((e) => ({ value: e, label: sessionEventLabel(e) }))}
          selected={events}
          onChange={(next) => patch({ event: next })}
        />
        <MultiSelectFilter
          label={t("adminAudit.sessions.filter.method")}
          options={sessionAuthMethodValues.map((m) => ({ value: m, label: authMethodLabel(m) }))}
          selected={authMethods}
          onChange={(next) => patch({ method: next })}
        />
        <TextFilter
          label={t("adminAudit.sessions.filter.email")}
          value={emailLike}
          onChange={(next) => patch({ email: next })}
          placeholder={t("adminAudit.sessions.filter.emailPlaceholder")}
          widthClass="w-48"
        />
        <TextFilter
          label={t("adminAudit.field.ip")}
          value={ipLike}
          onChange={(next) => patch({ ip: next })}
          placeholder={t("adminAudit.sessions.filter.ipPlaceholder")}
          widthClass="w-36"
        />
        <ToggleFilter
          label={t("adminAudit.sessions.filter.failuresOnly")}
          on={onlyFailures}
          onChange={(next) => patch({ failures: next })}
        />
      </AuditFilterBar>

      <StateBoundary
        loading={sessions.isLoading}
        error={sessions.error ?? undefined}
        onRetry={() => void sessions.refetch()}
        partialError={names.error ?? undefined}
        partialLabel={t("adminAudit.sessions.col.who")}
        skeletonRows={8}
      >
        {rows.length > 0 ? (
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiTile
              label={t("adminAudit.sessions.kpi.events")}
              value={formatNumber(rows.length)}
              explainer={{
                formula: t("adminAudit.sessions.kpi.eventsFormula"),
                numbers: scopeNumbers,
              }}
            />
            <KpiTile
              label={t("adminAudit.sessions.kpi.failures")}
              value={formatNumber(failures)}
              tone={failures > 0 ? "warn" : "neutral"}
              explainer={{
                formula: t("adminAudit.sessions.kpi.failuresFormula"),
                numbers: scopeNumbers,
              }}
            />
            <KpiTile
              label={t("adminAudit.sessions.kpi.revoked")}
              value={formatNumber(revocations)}
              tone={revocations > 0 ? "danger" : "neutral"}
              explainer={{
                formula: t("adminAudit.sessions.kpi.revokedFormula"),
                numbers: scopeNumbers,
              }}
            />
            <KpiTile
              label={t("adminAudit.sessions.kpi.outOfHours")}
              value={formatNumber(outOfHours)}
              tone={outOfHours > 0 ? "info" : "neutral"}
              explainer={{
                formula: t("adminAudit.sessions.kpi.outOfHoursFormula"),
                numbers: scopeNumbers,
              }}
            />
          </div>
        ) : null}

        <DataGrid
          columns={columns}
          rows={rows}
          rowKey={(row) => row.id}
          pageSize={AUDIT_PAGE_SIZE}
          onRowClick={(row) => {
            if (row.profile_id !== null) navigate(`/admin/audit/user/${row.profile_id}`);
          }}
          emptyState={
            hasActiveFilters ? (
              <EmptyState
                icon={ShieldCheck}
                title={t("adminAudit.sessions.emptyFiltered.title")}
                hint={t("adminAudit.timeline.emptyFiltered.hint")}
                action={
                  <Button variant="outline" onClick={clearAll}>
                    {t("adminAudit.filters.clearAll")}
                  </Button>
                }
              />
            ) : (
              <EmptyState
                icon={ShieldCheck}
                title={t("adminAudit.sessions.empty.title")}
                hint={t("adminAudit.sessions.empty.hint")}
              />
            )
          }
        />

        <LoadMoreFooter
          loadedCount={rows.length}
          hasNextPage={sessions.hasNextPage}
          isFetchingNextPage={sessions.isFetchingNextPage}
          onLoadMore={() => void sessions.fetchNextPage()}
          unitLabel={t("adminAudit.unit.signIns")}
        />
      </StateBoundary>

      <p className="mt-4 text-xs text-muted-foreground">{t("adminAudit.sessions.footnote")}</p>
    </div>
  );
}
