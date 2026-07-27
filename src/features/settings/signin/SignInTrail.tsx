/**
 * SignInTrail.tsx — one row per recorded auth event, in words.
 *
 * A list rather than a DataGrid, on purpose. Most of these staff will read this on
 * a phone, and the seven facts a row carries (what happened, method, place, device,
 * time, note, reason) do not survive being squeezed into columns: the grid's mobile
 * card mode would drop exactly the columns that make a row understandable. The list
 * keeps the sentence first and the machine strings behind a disclosure.
 *
 * What is on screen and what is one click away:
 *   * ALWAYS: the sentence, the IST instant, the method, the place (or the fact that
 *     no place was recorded), the device, and any notes.
 *   * ON REQUEST: the network address, the device id, the exact user-agent string,
 *     the raw location and the event code. These are the employee's own rows under
 *     `sessions_audit__self_read`, so nothing is withheld — it is only ordered.
 *
 * Every instant is rendered with `fmtDateTime`, which is IST-only and appends 'IST'.
 * There is no other date call in this file, so no screen state can show UTC.
 */
import { useState } from "react";
import {
  CircleDashed,
  KeyRound,
  LogIn,
  LogOut,
  MapPin,
  MonitorSmartphone,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import type { ComponentType } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fmtDateTime } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { cn } from "@/lib/utils";
import {
  SIGNIN_FLAG_ORDER,
  type SignInEventKind,
  type SignInFlag,
  type SignInRowView,
} from "./analysis";

type BadgeVariant = "success" | "warning" | "danger" | "info" | "neutral";

const KIND_ICON: Readonly<Record<SignInEventKind, ComponentType<{ className?: string }>>> = {
  success: LogIn,
  failure: ShieldAlert,
  signOut: LogOut,
  renewal: RefreshCw,
  credential: KeyRound,
  challenge: ShieldCheck,
  other: CircleDashed,
};

const KIND_ICON_CLASS: Readonly<Record<SignInEventKind, string>> = {
  success: "bg-success/10 text-success",
  failure: "bg-destructive/10 text-destructive",
  signOut: "bg-muted text-muted-foreground",
  renewal: "bg-muted text-muted-foreground",
  credential: "bg-info/10 text-info",
  challenge: "bg-info/10 text-info",
  other: "bg-muted text-muted-foreground",
};

const FLAG_LABEL: Readonly<Record<SignInFlag, string>> = {
  failed: t("signIn.flag.failed"),
  newDevice: t("signIn.flag.newDevice"),
  newPlace: t("signIn.flag.newPlace"),
  outOfHours: t("signIn.flag.outOfHours"),
  thisBrowser: t("signIn.flag.thisBrowser"),
};

const FLAG_VARIANT: Readonly<Record<SignInFlag, BadgeVariant>> = {
  failed: "danger",
  newDevice: "warning",
  newPlace: "warning",
  outOfHours: "info",
  thisBrowser: "neutral",
};

const FLAG_LEGEND: Readonly<Record<SignInFlag, string>> = {
  failed: t("signIn.legend.failed"),
  newDevice: t("signIn.legend.newDevice"),
  newPlace: t("signIn.legend.newPlace"),
  outOfHours: t("signIn.legend.outOfHours"),
  thisBrowser: t("signIn.legend.thisBrowser"),
};

/** The five notes explained once, so a badge never has to be guessed at. */
export function SignInFlagLegend() {
  return (
    <section className="rounded-md border bg-muted/30 p-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t("signIn.legend.title")}
      </h3>
      <ul className="mt-2 space-y-1.5">
        {SIGNIN_FLAG_ORDER.map((flag) => (
          <li key={flag} className="flex flex-wrap items-start gap-2 text-xs">
            <Badge variant={FLAG_VARIANT[flag]}>{FLAG_LABEL[flag]}</Badge>
            <span className="min-w-0 flex-1 text-muted-foreground">{FLAG_LEGEND[flag]}</span>
          </li>
        ))}
      </ul>
      <p className="mt-2.5 text-xs text-muted-foreground">{t("signIn.legend.action")}</p>
    </section>
  );
}

function DetailLine({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex flex-wrap gap-x-2">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="num min-w-0 break-all">{value}</dd>
    </div>
  );
}

/**
 * One event. The `<details>` is native rather than a Radix collapsible: there is
 * one per row, it must be keyboard-operable with no JavaScript state, and the repo
 * has no collapsible primitive to borrow.
 */
function SignInTrailRow({ row }: { readonly row: SignInRowView }) {
  const Icon = KIND_ICON[row.kind];
  const placeLabel = row.place === null ? t("signIn.place.none") : row.place.label;
  const hasDetail =
    row.ip !== null ||
    row.device.deviceId !== null ||
    row.device.userAgent !== null ||
    row.attemptedEmail !== null ||
    row.place !== null;

  return (
    <li className="flex gap-3 py-3.5">
      <span
        className={cn("mt-0.5 grid size-8 shrink-0 place-items-center rounded-full", KIND_ICON_CLASS[row.kind])}
        aria-hidden
      >
        <Icon className="size-4" />
      </span>

      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{row.headline}</p>

        <p className="num mt-0.5 text-xs text-muted-foreground">{fmtDateTime(row.recordedAt)}</p>

        <ul className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <li className="flex items-center gap-1">
            <KeyRound className="size-3" aria-hidden />
            {row.methodLabel}
          </li>
          <li className="flex items-center gap-1">
            <MapPin className="size-3" aria-hidden />
            <span className={row.place === null ? "italic" : undefined}>{placeLabel}</span>
            {row.place !== null && row.place.accuracy !== null ? (
              <span>({row.place.accuracy})</span>
            ) : null}
          </li>
          <li className="flex min-w-0 items-center gap-1">
            <MonitorSmartphone className="size-3" aria-hidden />
            <span className="truncate">{row.device.label}</span>
          </li>
        </ul>

        {row.failureReason !== null && row.failureReason.trim() !== "" ? (
          <p className="mt-1 text-xs text-destructive">
            {t("signIn.detail.reason")}: {row.failureReason}
          </p>
        ) : null}

        {row.flags.length > 0 ? (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {row.flags.map((flag) => (
              <Badge key={flag} variant={FLAG_VARIANT[flag]}>
                {FLAG_LABEL[flag]}
              </Badge>
            ))}
          </div>
        ) : null}

        {hasDetail ? (
          <details className="mt-1.5">
            <summary className="inline-flex cursor-pointer list-none items-center rounded text-xs text-muted-foreground underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              {t("signIn.detail.summary")}
            </summary>
            <dl className="mt-1.5 space-y-1 rounded-md border bg-muted/30 p-2.5 text-xs">
              <DetailLine label={t("signIn.detail.event")} value={row.event} />
              <DetailLine
                label={t("signIn.detail.ip")}
                value={row.ip ?? t("signIn.detail.none")}
              />
              <DetailLine
                label={t("signIn.detail.deviceId")}
                value={row.device.deviceId ?? t("signIn.detail.none")}
              />
              <DetailLine
                label={t("signIn.detail.userAgent")}
                value={row.device.userAgent ?? t("signIn.detail.none")}
              />
              <DetailLine
                label={t("signIn.detail.place")}
                value={row.place === null ? t("signIn.detail.none") : row.place.label}
              />
              {row.attemptedEmail !== null ? (
                <DetailLine label={t("signIn.detail.email")} value={row.attemptedEmail} />
              ) : null}
            </dl>
          </details>
        ) : null}
      </div>
    </li>
  );
}

export interface SignInTrailProps {
  /** Newest first, already analysed by `buildSignInTrail`. */
  readonly rows: readonly SignInRowView[];
  /** How many rows to show before "Show older events". Default 20. */
  readonly initialCount?: number;
  /** The five-note legend under the list. Off for the compact security card. */
  readonly showLegend?: boolean;
  /** The "showing X of Y" line. Off when the caller already states the scope. */
  readonly showCount?: boolean;
}

/**
 * The trail. Paging is a client-side reveal over rows that are ALREADY loaded — it
 * never implies more history exists than was read, and the caller is the one that
 * says how much of the record the list represents.
 */
export function SignInTrail({
  rows,
  initialCount = 20,
  showLegend = true,
  showCount = true,
}: SignInTrailProps) {
  const [visible, setVisible] = useState(initialCount);
  const shown = rows.slice(0, visible);
  const hasMore = rows.length > shown.length;

  return (
    <div className="space-y-3">
      <ol className="divide-y">
        {shown.map((row) => (
          <SignInTrailRow key={row.id} row={row} />
        ))}
      </ol>

      {hasMore ? (
        <Button variant="outline" size="sm" onClick={() => setVisible((n) => n + initialCount)}>
          {t("signIn.showMore")}
        </Button>
      ) : null}

      {showCount ? (
        <p className="num text-xs text-muted-foreground">
          {t("signIn.showing", { shown: shown.length, loaded: rows.length })}
        </p>
      ) : null}

      {showLegend ? <SignInFlagLegend /> : null}
    </div>
  );
}
