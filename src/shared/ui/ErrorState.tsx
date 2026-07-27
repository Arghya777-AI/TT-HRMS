import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TTApiError } from "@/shared/api/invoke";
import { t } from "@/shared/i18n/en";

export interface ErrorStateProps {
  error: unknown;
  retry?: () => void;
}

function messageOf(error: unknown): string {
  if (error instanceof TTApiError) return error.problem.title ?? error.message;
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return t("error.hint");
}

/** Card-level error with optional retry; surfaces the server error_ref on 5xx. */
export function ErrorState({ error, retry }: ErrorStateProps) {
  const errorRef = error instanceof TTApiError ? error.problem.error_ref : undefined;
  return (
    <div className="grid place-items-center rounded-lg border border-destructive/30 bg-destructive/5 px-6 py-12 text-center" role="alert">
      <div className="max-w-sm">
        <div className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-destructive/10 text-destructive" aria-hidden>
          <AlertTriangle className="h-6 w-6" />
        </div>
        <h2 className="mt-4 font-display text-lg font-semibold">{t("error.title")}</h2>
        <p className="mt-1.5 break-words text-sm text-muted-foreground">{messageOf(error)}</p>
        {errorRef ? (
          <p className="mt-1 font-mono text-xs text-muted-foreground">ref: {errorRef}</p>
        ) : null}
        {retry ? (
          <Button variant="outline" size="sm" className="mt-5" onClick={retry}>
            {t("error.retry")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
