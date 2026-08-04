/**
 * RolePanel — set who is an admin, a manager or a normal user.
 *
 * Mounted on the People directory, because "what can this person see" is a question
 * about a person and HR is already looking at people when they ask it.
 *
 * THE MISMATCH COLUMN IS THE POINT OF THE SCREEN. Two states can be wrong and neither
 * is visible anywhere else:
 *
 *   · `team_without_manager_role` — somebody has reportees and no manager role. This
 *     is what hid three teams in this deployment, and the symptom was a manager being
 *     told "as an employee your access is limited to your own records".
 *   · `manager_without_team` — a leftover manager grant after a reorganisation.
 *
 * They are REPORTED, not auto-corrected. A role is somebody's access and it should not
 * change silently because a reportee moved department.
 *
 * NOTHING IS DISABLED ON A GUESS beyond the two things the screen can know for
 * certain: an employee with no login has no role to set, and `can_manage` is the
 * server's own answer. Everything else — scope, super-admin, the self-demotion rule,
 * the manager rule — is left to the server, whose refusals are shown verbatim because
 * they explain themselves better than a greyed-out button can.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { KeyRound, Mail, ShieldCheck, TriangleAlert, Users } from "lucide-react";
import { isStepUpRequired, useStepUp } from "@/shared/auth/StepUpDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DataGrid, type DataGridColumn } from "@/shared/ui/DataGrid";
import { EmptyState } from "@/shared/ui/EmptyState";
import { StateBoundary } from "@/shared/ui/StateBoundary";
import { StatusChip, type StatusChipEntry } from "@/shared/ui/StatusChip";
import { shouldRetryQuery } from "@/shared/api/query";
import { asArray } from "@/lib/asArray";
import { formatNumber } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import { PersonCell } from "./PersonCell";
import { SelectField } from "./Field";
import {
  assignableRoles,
  fetchEmployeeRoles,
  setEmployeeRole,
  type AssignableRole,
  type EffectiveRole,
  type EmployeeRoleRow,
} from "../api/roles.api";
import { createEmployeeAccount, forcePasswordChange, type AccountCreated } from "../api/account-create.api";
import { sendCredentialEmail, sendPasswordResetLink } from "../api/credential-mail.api";

const KEY = ["admin", "employee-roles"] as const;

/**
 * `<employee_code>@tamarindtree.co` is a LOGIN IDENTITY, not a mailbox — minted by
 * `employee-account-create` for staff with no email of their own, using the
 * `security.login_email_domain` setting. Mail to it is accepted by the sender and
 * delivered nowhere, so any screen offering to email somebody has to tell the two
 * apart.
 *
 * MATCH THE WHOLE DOMAIN, NOT A CODE PATTERN. The first version tested
 * /^tt\d+@tamarindtree\.co$/, which caught `tt0016@` and missed `005@`, `S7@` and
 * `PR11@` — the venue's own employee numbers are not all `TT####`. That would have
 * sent 35 messages into a domain with no mailboxes, and the bounces land on the
 * sending reputation of the account HR actually uses.
 */
const LOGIN_IDENTITY_DOMAIN = "tamarindtree.co";

function isSyntheticIdentity(email: string | null): boolean {
  const at = (email ?? "").trim().toLowerCase().split("@")[1] ?? "";
  return at === LOGIN_IDENTITY_DOMAIN;
}

const ROLE_CHIP: Readonly<Record<EffectiveRole, StatusChipEntry>> = {
  employee: { label: t("admin.roles.role.employee"), tone: "neutral" },
  manager: { label: t("admin.roles.role.manager"), tone: "info" },
  // HR and admin are the same role here, which is what was asked for.
  admin: { label: t("admin.roles.role.admin"), tone: "success" },
  super_admin: { label: t("admin.roles.role.superAdmin"), tone: "warn" },
  no_login: { label: t("admin.roles.role.noLogin"), tone: "neutral" },
};

/**
 * Provision a login for an employee who has none.
 *
 * MOUNTED WHERE THE PROBLEM APPEARS. This cell used to read "No login yet, so no access level
 * to set" — a true statement and a dead end. Adding somebody in People creates the employee row
 * and nothing else, because nothing ever called `employee-account-create`, so a live confirmed
 * employee could sit there indefinitely with no way into the portal and no way to be enrolled
 * for face sign-in either (consent and templates both hang off a profile).
 *
 * THE PASSWORD IS SHOWN ONCE AND CANNOT BE RE-READ. The function returns it a single time and
 * nulls it on an idempotent replay, so it is rendered here the moment it arrives, selectable,
 * with a copy button and a plain warning. No mail is sent — `emailSent` comes back false — so
 * the screen says the slip has to be handed over rather than implying one is in flight.
 */
function CreateLoginCell(
  { row, onIssued }: { row: EmployeeRoleRow; onIssued: (issued: AccountCreated) => void },
) {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);

  const stepUp = useStepUp();

  /*
    STEP-UP IS PART OF THIS ACTION, NOT AN ERROR FROM IT.

    `employee-account-create` is a D-21 write and refuses with MFA_STEP_UP_REQUIRED unless the
    session is aal2 — confirmed by calling it: HTTP 403, "Confirm your identity with your
    authenticator app to continue." Without this, the button would show that sentence and stop,
    leaving the operator to guess that an authenticator prompt was what they needed. So a
    step-up refusal opens the prompt and retries the SAME request, which is exactly what the
    face-enrolment capture already does.
  */
  const provision = async (): Promise<AccountCreated> =>
    createEmployeeAccount({
      employeeId: row.employee_id,
      ...(email.trim() !== "" ? { loginEmail: email.trim() } : {}),
      reason: `provisioning a portal login for ${row.employee_code ?? "this employee"}`,
    });

  const create = useMutation({
    mutationFn: async () => {
      try {
        return await provision();
      } catch (err) {
        if (!isStepUpRequired(err)) throw err;
        const upgraded = await stepUp.ensureAal2();
        if (!upgraded) throw err;
        return await provision();
      }
    },
    /*
      THE CREDENTIAL IS HANDED TO THE PARENT, AND NOTHING IS REFETCHED YET.

      This used to `setIssued(result)` here and then invalidate the roles query. The
      function has just set `employees.profile_id`, so the refetched row was no
      longer `profile_id === null` — RoleCell switched to the role picker and
      unmounted THIS component, destroying the temporary password it was in the
      middle of displaying. The password is returned exactly once and nulled on
      replay, and no admin reset exists to issue another, so those few hundred
      milliseconds were the only chance anyone had to read it.

      So the parent holds it, and the refetch waits until the admin dismisses it.
    */
    onSuccess: (result) => {
      setError(null);
      onIssued(result);
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  return (
    <div className="flex flex-col items-end gap-1">
      {/* Only asked for when there is nothing on file to fall back to. */}
      <Input
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder={t("admin.roles.login.emailPlaceholder")}
        className="h-8 max-w-[14rem] text-xs"
        disabled={create.isPending}
      />
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={create.isPending}
        onClick={() => create.mutate()}
      >
        <KeyRound className="mr-2 size-4" aria-hidden />
        {create.isPending ? t("admin.roles.login.creating") : t("admin.roles.login.create")}
      </Button>
      {error !== null ? (
        <span className="max-w-[18rem] text-right text-xs text-destructive">{error}</span>
      ) : null}
      {/* Without this mounted, `ensureAal2` has no prompt to show. */}
      {stepUp.dialog}
    </div>
  );
}

/**
 * The issued credential, rendered by the PARENT of the cell that created it.
 *
 * It lives here because `RoleCell` survives the refetch that flips
 * `row.profile_id` from null to a uuid, and `CreateLoginCell` does not. The
 * temporary password comes back from the function exactly once — nulled on an
 * idempotent replay — and there is no admin reset anywhere in the product to
 * issue another, so losing it on screen means the account has to be reached some
 * other way entirely.
 *
 * Dismissal is explicit for the same reason: an accidental click elsewhere should
 * not be what destroys it.
 */
function IssuedCredential(
  { issued, row, onDismiss }: { issued: AccountCreated; row: EmployeeRoleRow; onDismiss: () => void },
) {
  const [copied, setCopied] = useState(false);

  /*
    EMAILING IT IS ONLY POSSIBLE HERE, WHILE THE PASSWORD IS STILL IN HAND.

    The database keeps a bcrypt hash and nothing else, and the function nulls the
    password on replay — so there is no later screen that could offer to send it.
    Hence a button on the credential itself rather than a general action on the row.

    Not automatic: an admin who is provisioning ten accounts to hand over on paper
    should not be mailing ten passwords as a side effect of clicking Create login.
  */
  const mail = useMutation({
    mutationFn: () =>
      sendCredentialEmail({
        employeeId: row.employee_id,
        displayName: row.display_name ?? row.employee_code ?? "",
        loginEmail: issued.account.email ?? "",
        tempPassword: issued.tempPassword ?? "",
      }),
    onSuccess: (r) => {
      toast.success(
        r.sandboxed === true
          ? t("admin.roles.login.mailSandboxed")
          : t("admin.roles.login.mailSent", { email: issued.account.email ?? "" }),
      );
    },
    onError: (e: unknown) => toast.error(e instanceof Error ? e.message : String(e)),
  });

  return (
    <div className="flex flex-col items-end gap-1 text-right">
      <span className="text-xs font-medium text-success">
        {t("admin.roles.login.created", { email: issued.account.email ?? "" })}
      </span>
      {issued.tempPassword !== null ? (
        <>
          <code className="select-all rounded bg-muted px-2 py-1 text-sm">{issued.tempPassword}</code>
          <button
            type="button"
            className="text-xs text-muted-foreground hover:text-foreground"
            onClick={() => {
              void navigator.clipboard.writeText(issued.tempPassword ?? "").then(() => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1_500);
              }).catch(() => {
                // Clipboard refused; the password is selectable on screen.
              });
            }}
          >
            {copied ? t("admin.roles.login.copied") : t("admin.roles.login.copy")}
          </button>
          {/* Said plainly, because it is true and there is no second chance. */}
          <span className="max-w-[18rem] text-xs text-warning">
            {t("admin.roles.login.onceOnly")}
          </span>
        </>
      ) : (
        <span className="max-w-[18rem] text-xs text-muted-foreground">
          {t("admin.roles.login.replayed")}
        </span>
      )}
      {/* Offered only when there is something to send and somewhere to send it. */}
      {issued.tempPassword !== null && (issued.account.email ?? "") !== "" ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={mail.isPending}
          onClick={() => mail.mutate()}
        >
          <Mail className="mr-2 size-4" aria-hidden />
          {mail.isPending
            ? t("admin.roles.login.mailSending")
            : mail.isSuccess
              ? t("admin.roles.login.mailAgain")
              : t("admin.roles.login.mail")}
        </Button>
      ) : null}
      <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>
        {t("admin.roles.login.dismiss")}
      </Button>
    </div>
  );
}

function RoleCell({ row }: { row: EmployeeRoleRow }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  // Held HERE, not in CreateLoginCell: this component survives the refetch that
  // gives the row a profile_id, and that cell does not. See IssuedCredential.
  const [issued, setIssued] = useState<AccountCreated | null>(null);
  // The reason travels WITH the mutation, not through a module-level or window
  // variable: two rows changed in quick succession would otherwise race and one
  // would be audited with the other's reason.
  /*
    Forcing a change is a SEPARATE mutation from setting a role, because they fail
    differently and the operator needs to know which one refused: a role change can
    be rejected by the manager-needs-a-team rule, this one only by scope.
  */
  const force = useMutation({
    mutationFn: (reason: string) => forcePasswordChange(row.profile_id ?? "", reason),
    onSuccess: () => {
      setError(null);
      toast.success(t("admin.roles.login.forced"));
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  /*
    Emails a set-your-password link. Separate from `force`, which only re-arms the
    flag and sends nothing: an admin who wants somebody to change their password
    usually also wants them TOLD, and those are two different failures to report.
  */
  const invite = useMutation({
    mutationFn: (email: string) => sendPasswordResetLink(email),
    onSuccess: () => {
      setError(null);
      toast.success(t("admin.roles.login.linkSent"));
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  const change = useMutation({
    mutationFn: (v: { role: AssignableRole; reason: string }) =>
      setEmployeeRole(row.employee_id, v.role, v.reason),
    onSuccess: () => {
      setError(null);
      void qc.invalidateQueries({ queryKey: KEY });
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
  });

  if (issued !== null) {
    return (
      <IssuedCredential
        issued={issued}
        row={row}
        onDismiss={() => {
          setIssued(null);
          void qc.invalidateQueries({ queryKey: KEY });
        }}
      />
    );
  }
  if (!row.can_manage) {
    return <span className="text-xs text-muted-foreground">{t("admin.roles.adminOnly")}</span>;
  }
  if (row.profile_id === null) {
    /*
      No account — so instead of saying so and stopping, offer to make one. Adding somebody in
      People never created a login, which is why a confirmed employee could have no way in at
      all. Once the login exists this cell becomes the ordinary role picker on the next refetch.
    */
    return <CreateLoginCell row={row} onIssued={setIssued} />;
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <SelectField
        label=""
        value={row.effective_role === "no_login" ? "" : row.effective_role}
        options={assignableRoles.map((r) => ({ value: r, label: ROLE_CHIP[r].label }))}
        disabled={change.isPending}
        onChange={(v) => {
          if (v === "" || v === row.effective_role) return;
          // A prompt, not a silent write: the server wants ten characters and this
          // sentence is what the audit row carries months from now.
          const reason = window.prompt(t("admin.roles.reasonPrompt", { name: row.display_name ?? "" }));
          if (reason === null || reason.trim().length < 10) return;
          change.mutate({ role: v as AssignableRole, reason: reason.trim() });
        }}
      />
      {/*
        The only way to make somebody replace a credential that has been handed
        over, shared or simply grown old. It sets no password — see
        forcePasswordChange — so the person signs in with what they have and is
        held at step 1 until they change it.
      */}
      <button
        type="button"
        className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        disabled={force.isPending}
        onClick={() => {
          const reason = window.prompt(
            t("admin.roles.login.forceReasonPrompt", { name: row.display_name ?? "" }),
          );
          if (reason === null || reason.trim().length < 10) return;
          force.mutate(reason.trim());
        }}
      >
        {force.isPending ? t("admin.roles.login.forcing") : t("admin.roles.login.force")}
      </button>
      {/*
        Only offered where there is a real mailbox to reach. A synthetic
        <employee_code>@tamarindtree.co identity has none, so a link sent there
        would be silently discarded and HR would believe it had arrived.
      */}
      {(row.login_email ?? "").trim() !== "" && !isSyntheticIdentity(row.login_email) ? (
        <button
          type="button"
          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
          disabled={invite.isPending}
          onClick={() => invite.mutate(row.login_email ?? "")}
        >
          {invite.isPending ? t("admin.roles.login.linkSending") : t("admin.roles.login.link")}
        </button>
      ) : null}
      {error !== null ? (
        <span className="max-w-[20rem] text-right text-xs text-destructive">{error}</span>
      ) : null}
    </div>
  );
}

export function RolePanel() {
  const roles = useQuery({
    queryKey: KEY,
    queryFn: ({ signal }) => fetchEmployeeRoles(signal),
    retry: shouldRetryQuery,
  });
  const rows = asArray(roles.data);
  const mismatches = rows.filter((r) => r.manager_without_team || r.team_without_manager_role);

  const columns: DataGridColumn<EmployeeRoleRow>[] = [
    {
      key: "display_name",
      header: t("admin.roles.col.person"),
      width: "16rem",
      render: (row) => <PersonCell name={row.display_name ?? "—"} code={row.employee_code ?? ""} />,
    },
    {
      key: "effective_role",
      header: t("admin.roles.col.access"),
      width: "10rem",
      render: (row) => <StatusChip status={row.effective_role} map={ROLE_CHIP} />,
    },
    {
      key: "reportee_count",
      header: t("admin.roles.col.reportees"),
      width: "9rem",
      align: "right",
      hideBelow: "md",
      render: (row) => <span className="num text-sm">{formatNumber(row.reportee_count)}</span>,
    },
    {
      key: "mismatch",
      header: t("admin.roles.col.check"),
      width: "17rem",
      hideBelow: "lg",
      /* The whole reason this screen exists. Named in full rather than as a warning
         icon, because the fix is different for each and the reader has to know which. */
      render: (row) =>
        row.team_without_manager_role ? (
          <span className="inline-flex items-start gap-1.5 text-xs text-warning">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {t("admin.roles.check.teamNoRole")}
          </span>
        ) : row.manager_without_team ? (
          <span className="inline-flex items-start gap-1.5 text-xs text-warning">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {t("admin.roles.check.managerNoTeam")}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">{t("admin.roles.check.ok")}</span>
        ),
    },
    {
      key: "set",
      header: t("admin.roles.col.set"),
      align: "right",
      width: "16rem",
      render: (row) => <RoleCell row={row} />,
    },
  ];

  return (
    <section className="mt-8">
      <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
        <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />
        {t("admin.roles.title")}
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        {mismatches.length > 0
          ? t("admin.roles.subtitle.mismatch", { n: formatNumber(mismatches.length) })
          : t("admin.roles.subtitle.ok")}
      </p>

      <div className="mt-3">
        <StateBoundary
          loading={roles.isPending}
          error={roles.error}
          onRetry={() => void roles.refetch()}
          isEmpty={!roles.isPending && roles.error === null && rows.length === 0}
          empty={<EmptyState icon={Users} title={t("admin.roles.empty")} />}
          skeletonRows={5}
        >
          <DataGrid columns={columns} rows={rows} rowKey={(r) => r.employee_id} pageSize={15} />
        </StateBoundary>
      </div>
    </section>
  );
}
