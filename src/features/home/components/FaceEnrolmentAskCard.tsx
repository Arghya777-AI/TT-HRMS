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
 */
import { ScanFace } from "lucide-react";
import { fmtDateTime } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { useMyFaceEnrolmentAsk } from "../hooks/useFaceEnrolmentAsk";

export function FaceEnrolmentAskCard() {
  const ask = useMyFaceEnrolmentAsk();

  // Silent when there is nothing to say. A card that renders "nothing to do" on
  // every visit trains people to stop reading the dashboard.
  if (ask.data === undefined || ask.data === null) return null;

  const awaitingApproval = ask.data.status === "pending";

  return (
    <section
      className="rounded-lg border border-info/40 bg-info/5 p-4"
      aria-labelledby="face-ask-heading"
    >
      <div className="flex items-start gap-3">
        <ScanFace className="mt-0.5 size-5 shrink-0 text-info" aria-hidden />
        <div className="min-w-0">
          <h2 id="face-ask-heading" className="text-sm font-semibold">
            {awaitingApproval
              ? t("me.faceAsk.pending.title")
              : t("me.faceAsk.draft.title")}
          </h2>
          <p className="mt-1 max-w-prose text-xs text-muted-foreground">
            {awaitingApproval
              ? t("me.faceAsk.pending.body")
              : t("me.faceAsk.draft.body")}
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            {t("me.faceAsk.asked", { at: fmtDateTime(ask.data.requested_at) })}
          </p>
        </div>
      </div>
    </section>
  );
}
