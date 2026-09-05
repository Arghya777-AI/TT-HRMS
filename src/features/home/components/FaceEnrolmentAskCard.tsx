/**
 * FaceEnrolmentAskCard — tells the employee that HR has asked them to register
 * their face, on the one screen they actually open.
 *
 * WHY IT EXISTS
 * -------------
 * An admin could "initiate enrolment" and the employee was never told. The only
 * notification path is an EMAIL (`public.notifications` is partitioned and its
 * INSERT is revoked from `authenticated`, so no browser code can write the in-app
 * row), and most venue staff have no work address — 8 of 15 here. So the ask
 * existed in a table nobody looked at.
 *
 * `face_enrolment_requests__self_select` (migration 012) already lets an employee
 * read their own rows: `USING (employee_id = app.current_employee_id())`. Nothing
 * had to change in the database; the row simply needed a screen.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It does not offer the employee a "register my face" button. Registration is
 * admin-supervised by design — the admin captures on their own device, with the
 * employee present, so that a face cannot be enrolled from a photograph sent to
 * an unattended browser. The card therefore tells the employee what will happen
 * and what to bring, rather than starting something they cannot finish.
 *
 * A `draft` row is the admin's ask ("please come and enrol"). A `pending` row means
 * a capture has already been taken and is waiting for approval — a different
 * sentence, because the employee has nothing left to do.
 *
 * ── IT IS A ROW, AND IT IS CLICKABLE ─────────────────────────────────────────
 * It used to be a four-line paragraph sitting between the shift band and the punch card,
 * which pushed the one button on this page below the fold. A notice that costs somebody the
 * thing they came to do is worse than no notice.
 *
 * So it is one line with the detail behind a disclosure, it sits BELOW the punch card, and —
 * on a `draft` — the whole row is a link to the helpdesk, because "see HR" is not an
 * instruction anybody can act on from a dashboard at 8am. A `pending` row is NOT a link:
 * there is nothing for the employee to do while somebody else approves a capture, and a
 * button that leads nowhere useful teaches people to stop pressing them.
 */
import { ChevronRight, ScanFace } from "lucide-react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { fmtDateTime } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { useMyFaceEnrolmentAsk } from "../hooks/useFaceEnrolmentAsk";

export function FaceEnrolmentAskCard() {
  const ask = useMyFaceEnrolmentAsk();

  // Silent when there is nothing to say. A card that renders "nothing to do" on
  // every visit trains people to stop reading the dashboard.
  if (ask.data === undefined || ask.data === null) return null;

  const awaitingApproval = ask.data.status === "pending";

  const body = (
    <>
      <ScanFace
        className={cn("mt-0.5 size-4 shrink-0", awaitingApproval ? "text-muted-foreground" : "text-info")}
        aria-hidden
      />
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">
          {awaitingApproval ? t("me.faceAsk.pending.title") : t("me.faceAsk.draft.title")}
        </span>
        {/*
          One line. The full explanation — who captures it, what to bring, why it cannot be
          done from here — is behind the disclosure below, where somebody who wants it can
          read it and everybody else is not made to scroll past it.
        */}
        <span className="block truncate text-xs text-muted-foreground">
          {awaitingApproval ? t("me.faceAsk.pending.lead") : t("me.faceAsk.draft.lead")}
        </span>
      </span>
      {!awaitingApproval ? (
        <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      ) : null}
    </>
  );

  return (
    <section
      className={cn(
        "mt-4 rounded-lg border",
        awaitingApproval ? "bg-muted/30" : "border-info/40 bg-info/5",
      )}
      aria-labelledby="face-ask-heading"
    >
      <h2 id="face-ask-heading" className="sr-only">
        {awaitingApproval ? t("me.faceAsk.pending.title") : t("me.faceAsk.draft.title")}
      </h2>

      {awaitingApproval ? (
        <span className="flex items-start gap-2.5 px-3 py-2.5">{body}</span>
      ) : (
        /*
          The helpdesk, not a face-capture screen. Registration is admin-supervised by design
          — the admin captures on their own device with the employee present, so a face cannot
          be enrolled from a photograph sent to an unattended browser. What the employee CAN
          do from here is ask HR when to come, and that is what this opens.
        */
        <Link
          to="/me/helpdesk"
          className="flex items-start gap-2.5 rounded-lg px-3 py-2.5 hover:bg-info/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {body}
        </Link>
      )}

      <details className="border-t px-3 py-2">
        <summary className="cursor-pointer text-xs text-muted-foreground">
          {t("me.faceAsk.more")}
        </summary>
        <p className="mt-2 max-w-prose text-xs text-muted-foreground">
          {awaitingApproval ? t("me.faceAsk.pending.body") : t("me.faceAsk.draft.body")}
        </p>
        <p className="mt-2 text-xs text-muted-foreground">
          {t("me.faceAsk.asked", { at: fmtDateTime(ask.data.requested_at) })}
        </p>
      </details>
    </section>
  );
}
