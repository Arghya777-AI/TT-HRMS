/**
 * FaceLoginSwitch — the button that turns face sign-in on or off for one person.
 *
 * ONE CONTROL, THREE PLACES. The employee's own Security page, a manager's reportee
 * profile, and the admin's enrolment console all render THIS, because the question is
 * identical in all three and the authority is settled in Postgres. Three bespoke
 * toggles would be three chances to disagree about what the switch means.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 * WHAT IT REFUSES TO IMPLY
 *
 * "On" does not mean "will work". Three separate things must all hold before a face
 * can open a session, and the switch is only one of them:
 *
 *   * a live, consented template must exist         -> `has_live_template`
 *   * the account must not be privileged            -> `is_privileged`
 *   * this switch must be on                        -> `allow_face_login`
 *
 * A screen that showed a green toggle while sign-in kept refusing would be worse than
 * no screen. So each unmet condition gets its own sentence, and the switch itself is
 * still shown and still operable — a manager should be able to pre-emptively disable
 * face sign-in for somebody who has not enrolled yet.
 *
 * PRIVILEGED ACCOUNTS ARE THE SUBTLE ONE. `face-login` refuses managers, admins and
 * super_admins outright: a privileged session is the one worth stealing, and its
 * refusal is deliberately indistinguishable from "no template" so it cannot be used to
 * discover which accounts are privileged. That is invisible from the sign-in screen by
 * design — which is exactly why it has to be said HERE, to an authenticated reader who
 * already administers the person.
 */
import { ScanFace, ShieldCheck, ShieldOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { t } from "@/shared/i18n/en";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { useSetFaceLogin } from "@/features/settings/hooks/useFaceLogin";
import type { FaceLoginAccess } from "@/features/settings/api/faceLogin.api";

const STATE_CHIP: Readonly<Record<"on" | "off", StatusChipEntry>> = {
  on: { label: t("faceLogin.state.on"), tone: "success" },
  off: { label: t("faceLogin.state.off"), tone: "neutral" },
};

export interface FaceLoginSwitchProps {
  readonly row: FaceLoginAccess;
  /**
   * `self` changes the copy from "this person" to "you". The permission is not
   * affected — the database decides that — only who the sentences address.
   */
  readonly audience: "self" | "other";
  /**
   * Suppress the switch's own heading when the host already provides one — the
   * Security page wraps this in a titled Card, and without this the title rendered
   * twice, one line apart.
   */
  readonly hideTitle?: boolean;
  readonly className?: string;
}

export function FaceLoginSwitch({ row, audience, hideTitle = false, className }: FaceLoginSwitchProps) {
  const set = useSetFaceLogin();
  const on = row.allow_face_login;
  const self = audience === "self";

  /**
   * Every reason this will not work today, in the order a reader can act on them.
   * An empty list means face sign-in is genuinely usable.
   */
  const blockers: string[] = [];
  if (row.is_privileged) {
    blockers.push(self ? t("faceLogin.block.privilegedSelf") : t("faceLogin.block.privileged"));
  }
  if (!row.has_live_template) {
    blockers.push(
      row.has_enrolled
        ? self
          ? t("faceLogin.block.templateGoneSelf")
          : t("faceLogin.block.templateGone")
        : self
          ? t("faceLogin.block.notEnrolledSelf")
          : t("faceLogin.block.notEnrolled"),
    );
  }

  return (
    <div className={`rounded-lg border bg-card p-4 ${className ?? ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <ScanFace className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="min-w-0">
            {!hideTitle && (
              <h3 className="font-medium">
                {self ? t("faceLogin.title.self") : t("faceLogin.title.other")}
              </h3>
            )}
            <p className="text-sm text-muted-foreground">
              {self ? t("faceLogin.hint.self") : t("faceLogin.hint.other")}
            </p>
          </div>
        </div>
        <StatusChip status={on ? "on" : "off"} map={STATE_CHIP} />
      </div>

      {/* Each unmet condition, said plainly. The switch stays usable regardless: a
          manager may disable face sign-in for somebody who has not enrolled yet. */}
      {blockers.length > 0 && (
        <ul className="mt-3 space-y-1 text-sm text-muted-foreground">
          {blockers.map((line) => (
            <li key={line} className="flex gap-2">
              <span aria-hidden="true">·</span>
              <span>{line}</span>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {row.can_manage ? (
          <Button
            type="button"
            variant={on ? "outline" : "default"}
            size="sm"
            disabled={set.isPending}
            onClick={() => set.mutate({ employeeId: row.employee_id, enabled: !on })}
          >
            {on ? (
              <ShieldOff className="mr-2 size-4" aria-hidden="true" />
            ) : (
              <ShieldCheck className="mr-2 size-4" aria-hidden="true" />
            )}
            {on ? t("faceLogin.action.disable") : t("faceLogin.action.enable")}
          </Button>
        ) : (
          // Reached only if the view and the setter ever disagree. Saying so beats a
          // button that would 403.
          <p className="text-sm text-muted-foreground">{t("faceLogin.noPermission")}</p>
        )}

        {set.isError && (
          <p className="text-sm text-destructive">
            {set.error instanceof Error ? set.error.message : t("faceLogin.error")}
          </p>
        )}
      </div>
    </div>
  );
}
