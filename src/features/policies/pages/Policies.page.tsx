/**
 * E-13 · /me/policies — the browser.
 *
 * Always renders the category rail and the list frame, never a blank card
 * waiting on a dropdown (the reference product showed nothing until you picked a
 * sub-category — DR-55/48). The rail is the policy document TYPES from the
 * server; the "All" entry is always present and always selected by default.
 *
 * Search is a client filter over the already-loaded titles. spec-employee §5
 * E-13 asks for full-text search on `policies.body_text`; there is no such
 * column (a policy is a file, see the api module), so what is searched is what is
 * on screen — and the empty state says the search is what hid the rows (DR-07).
 *
 * @route /me/policies
 */
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ScrollText, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/shared/ui/PageHeader";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { t } from "@/shared/i18n/en";
import { fmtCivilDate, fmtDateTime, nowIstDate } from "@/lib/datetime";
import { dash } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { PolicyListRow } from "../api/policies.api";
import { usePolicyList } from "../hooks/usePolicies";

const ALL = "all";

function ackCell(row: PolicyListRow) {
  const ack = row.ack;
  if (ack === null) return <span className="text-muted-foreground">{dash(null)}</span>;
  if (ack.acknowledged_at !== null) {
    return (
      <span className="flex flex-col gap-0.5">
        <Badge variant="success" className="w-fit">
          {t("policies.ack.done")}
        </Badge>
        <span className="num text-xs text-muted-foreground">
          {fmtDateTime(ack.acknowledged_at)}
        </span>
      </span>
    );
  }
  if (ack.status === "waived") {
    return <Badge variant="neutral">{t("policies.ack.waived")}</Badge>;
  }
  const started = ack.first_opened_at !== null;
  return (
    <Badge variant={started ? "info" : "warning"}>
      {started ? t("policies.ack.opened") : t("policies.ack.pending")}
    </Badge>
  );
}

export default function PoliciesPage() {
  const list = usePolicyList();
  const [params, setParams] = useSearchParams();
  const [search, setSearch] = useState("");

  const category = params.get("category") ?? ALL;

  const categories = useMemo(() => {
    const names = new Set<string>();
    for (const row of list.data?.rows ?? []) {
      if (row.categoryName !== null) names.add(row.categoryName);
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [list.data]);

  const rows = useMemo(() => {
    const all = list.data?.rows ?? [];
    const needle = search.trim().toLowerCase();
    return all.filter((row) => {
      if (category !== ALL && row.categoryName !== category) return false;
      if (needle.length === 0) return true;
      return (row.title ?? "").toLowerCase().includes(needle);
    });
  }, [list.data, category, search]);

  function selectCategory(next: string) {
    const nextParams = new URLSearchParams(params);
    if (next === ALL) nextParams.delete("category");
    else nextParams.set("category", next);
    setParams(nextParams, { replace: true });
  }

  const columns: DataGridColumn<PolicyListRow>[] = [
    {
      key: "title",
      header: t("policies.col.policy"),
      render: (row) =>
        row.title === null ? (
          <span className="text-muted-foreground">{t("policies.title.unavailable")}</span>
        ) : (
          <Link
            to={`/me/policies/${row.documentId}`}
            className="font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {row.title}
          </Link>
        ),
    },
    {
      key: "category",
      header: t("policies.col.category"),
      hideBelow: "md",
      render: (row) => dash(row.categoryName),
    },
    {
      key: "version",
      header: t("policies.col.version"),
      width: "6rem",
      hideBelow: "lg",
      render: (row) => dash(row.version, (v) => `v${v}`),
    },
    {
      key: "effective",
      header: t("policies.col.effective"),
      width: "9rem",
      hideBelow: "lg",
      render: (row) => dash(row.effectiveFrom, fmtCivilDate),
    },
    {
      key: "ack",
      header: t("policies.col.ack"),
      width: "13rem",
      render: ackCell,
    },
    {
      key: "due",
      header: t("policies.col.due"),
      width: "9rem",
      render: (row) => (
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="num">{dash(row.dueOn, fmtCivilDate)}</span>
          {row.dueOn !== null &&
          row.dueOn < nowIstDate() &&
          (row.ack === null || row.ack.acknowledged_at === null) ? (
            <Badge variant="danger">{t("policies.overdue")}</Badge>
          ) : null}
        </span>
      ),
    },
    {
      key: "action",
      header: t("policies.col.action"),
      align: "right",
      width: "7rem",
      render: (row) => (
        <Button variant="outline" size="sm" asChild>
          <Link to={`/me/policies/${row.documentId}`}>{t("policies.read")}</Link>
        </Button>
      ),
    },
  ];

  const searching = search.trim().length > 0 || category !== ALL;

  return (
    <div className="container py-6">
      <PageHeader
        icon={ScrollText}
        title={t("policies.title")}
        subtitle={t("policies.subtitle")}
      />

      <div className="grid gap-5 lg:grid-cols-[13rem_minmax(0,1fr)]">
        {/* Category rail — always rendered, even before the list resolves. */}
        <nav aria-label={t("policies.categories")} className="lg:sticky lg:top-4 lg:self-start">
          <ul className="flex flex-wrap gap-2 lg:flex-col">
            <li>
              <button
                type="button"
                onClick={() => selectCategory(ALL)}
                aria-current={category === ALL ? "true" : undefined}
                className={cn(
                  "w-full rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-muted/50",
                  category === ALL && "border-primary bg-primary/5 font-medium",
                )}
              >
                {t("policies.category.all")}
              </button>
            </li>
            {categories.map((name) => (
              <li key={name}>
                <button
                  type="button"
                  onClick={() => selectCategory(name)}
                  aria-current={category === name ? "true" : undefined}
                  className={cn(
                    "w-full rounded-md border px-3 py-2 text-left text-sm transition-colors hover:bg-muted/50",
                    category === name && "border-primary bg-primary/5 font-medium",
                  )}
                >
                  {name}
                </button>
              </li>
            ))}
          </ul>
        </nav>

        <div className="min-w-0">
          <label className="mb-3 flex items-center gap-2 rounded-md border bg-card px-3">
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
            <span className="sr-only">{t("policies.search")}</span>
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("policies.search")}
              className="border-0 px-0 focus-visible:ring-0"
              type="search"
            />
          </label>

          <StateBoundary
            loading={list.isLoading}
            error={list.error ?? undefined}
            onRetry={() => void list.refetch()}
          >
            {(list.data?.unreadableCount ?? 0) > 0 ? (
              <p className="mb-3 rounded-md border border-warning/40 bg-warning/5 px-3 py-2 text-sm">
                {t("policies.assigned.unreadable", { count: list.data?.unreadableCount ?? 0 })}
              </p>
            ) : null}
            <DataGrid
              columns={columns}
              rows={rows}
              rowKey={(row) => row.documentId}
              pageSize={25}
              emptyState={
                searching ? (
                  <EmptyState
                    icon={Search}
                    title={t("policies.searchEmpty.title")}
                    hint={t("policies.searchEmpty.hint")}
                  />
                ) : (
                  <EmptyState
                    icon={ScrollText}
                    title={t("policies.empty.title")}
                    hint={t("policies.empty.hint")}
                  />
                )
              }
            />
          </StateBoundary>
        </div>
      </div>
    </div>
  );
}
