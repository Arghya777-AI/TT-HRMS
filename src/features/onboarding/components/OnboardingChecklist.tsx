/**
 * OnboardingChecklist — the last step of first login: what HR still needs from you.
 *
 * WHAT IT SHOWS is entirely the server's answer. `v_my_onboarding_pack` returns the fields
 * HR configured for onboarding and the documents required at onboarding, each already
 * marked done or outstanding. This component sorts nothing, decides nothing, and requires
 * nothing of its own — `submit_onboarding()` re-checks the identical SQL, so a checklist
 * that disagreed with the server would only ever be wrong in the reader's favour.
 *
 * REQUIRED AND RECOMMENDED ARE DRAWN DIFFERENTLY. A cancelled cheque is recommended and a
 * bank proof is required; a joiner who cannot tell them apart will either be blocked by
 * something they thought was optional or skip something that matters. So the required ones
 * carry the count that gates the button, and the rest say plainly that they can wait.
 *
 * UPLOADING HAPPENS ON THE DOCUMENTS SCREEN, which the first-login gate deliberately lets
 * through. Re-implementing upload here would mean a second code path to the same storage
 * bucket and the same `documents` table — and the one on a wizard step would be the one
 * nobody maintains.
 */
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { CheckCircle2, Circle, FileUp, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { shouldRetryQuery } from "@/shared/api/query";
import { t } from "@/shared/i18n/en";
import { cn } from "@/lib/utils";
import {
  OnboardingIncomplete,
  fetchOnboardingPack,
  submitOnboarding,
  type PackItem,
} from "../api/onboarding.api";

const KEY = ["onboarding", "pack"] as const;

export interface OnboardingChecklistProps {
  /** Called once the server has accepted the submission. */
  readonly onSubmitted: () => void;
}

export function OnboardingChecklist({ onSubmitted }: OnboardingChecklistProps) {
  const qc = useQueryClient();
  const pack = useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => fetchOnboardingPack(signal),
    retry: shouldRetryQuery,
    // Coming back from uploading a document must show it as done, so this is never served
    // from cache on remount.
    staleTime: 0,
  });

  // Memoised: `?? []` makes a fresh array every render, which would re-run every useMemo
  // below it and defeat the point of having them.
  const items = useMemo(() => pack.data ?? [], [pack.data]);
  const required = useMemo(() => items.filter((i) => i.is_required), [items]);
  const optional = useMemo(() => items.filter((i) => !i.is_required), [items]);
  const outstanding = useMemo(() => required.filter((i) => !i.is_done), [required]);

  const submit = useMutation({
    mutationFn: () => submitOnboarding(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: KEY });
      onSubmitted();
    },
  });

  /**
   * Codes the SERVER refused on, if it did. Trusted over the local `outstanding` list: the
   * server also checks name and phone, which are not rows in the pack, so its answer can
   * legitimately be longer than anything visible here.
   */
  const refusedCodes =
    submit.error instanceof OnboardingIncomplete ? submit.error.missing : [];

  return (
    <div className="space-y-4">
      <StateBoundary
        loading={pack.isPending}
        error={pack.error}
        onRetry={() => void pack.refetch()}
        skeletonRows={3}
      >
        {required.length === 0 && optional.length === 0 ? (
          // A joiner with nothing configured against them — a delivery worker, where name
          // and phone are the only requirements and both were captured a step ago.
          <p className="text-sm text-muted-foreground">{t("onboarding.nothingRequired")}</p>
        ) : (
          <>
            {required.length > 0 ? (
              <section>
                <h3 className="text-sm font-medium">
                  {t("onboarding.required", { done: required.length - outstanding.length, total: required.length })}
                </h3>
                <ul className="mt-2 space-y-1.5">
                  {required.map((item) => (
                    <Row key={item.code} item={item} flagged={refusedCodes.includes(item.code)} />
                  ))}
                </ul>
              </section>
            ) : null}

            {optional.length > 0 ? (
              <section>
                <h3 className="text-sm font-medium">{t("onboarding.recommended")}</h3>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t("onboarding.recommendedHint")}
                </p>
                <ul className="mt-2 space-y-1.5">
                  {optional.map((item) => (
                    <Row key={item.code} item={item} flagged={false} />
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        )}
      </StateBoundary>

      {items.some((i) => i.kind === "document") ? (
        <Button asChild variant="outline" className="w-full">
          <Link to="/me/documents">
            <FileUp className="mr-2 size-4" aria-hidden />
            {t("onboarding.upload")}
          </Link>
        </Button>
      ) : null}

      {/*
        The server's refusal, in the reader's words. It also covers the two things that are
        always required and are not rows above — a name and a reachable phone — so the
        sentence names them rather than leaving somebody staring at a satisfied checklist
        and a button that will not go.
      */}
      {refusedCodes.length > 0 ? (
        <p className="rounded-md border border-warning/40 bg-warning/5 p-3 text-sm">
          {t("onboarding.stillNeeded", { items: refusedCodes.join(", ") })}
        </p>
      ) : submit.isError ? (
        <p className="text-sm text-destructive">
          {submit.error instanceof Error ? submit.error.message : t("onboarding.failed")}
        </p>
      ) : null}

      <Button
        className="w-full"
        onClick={() => submit.mutate()}
        // NOT disabled on the local count. The server decides, and a button that refuses to
        // be pressed cannot explain why — pressing it produces the exact list instead.
        disabled={submit.isPending}
      >
        {submit.isPending ? <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> : null}
        {t("onboarding.submit")}
      </Button>

      <p className="text-center text-xs text-muted-foreground">{t("onboarding.reviewNote")}</p>
    </div>
  );
}

function Row({ item, flagged }: { item: PackItem; flagged: boolean }) {
  return (
    <li
      className={cn(
        "flex items-start gap-2 rounded-md px-2 py-1.5 text-sm",
        flagged && "bg-warning/10",
      )}
    >
      {item.is_done ? (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
      ) : (
        <Circle className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <span className="min-w-0">
        <span className={cn(item.is_done && "text-muted-foreground")}>{item.label}</span>
        {item.help_text !== null && item.help_text !== "" ? (
          <span className="block text-xs text-muted-foreground">{item.help_text}</span>
        ) : null}
      </span>
    </li>
  );
}
