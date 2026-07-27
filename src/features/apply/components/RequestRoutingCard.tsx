/**
 * RequestRoutingCard — "who decides this, and above what amount", read from the
 * server for ONE request type.
 *
 * Shared by the four E-10 request screens so that they answer the question the
 * same way, from `approval_chains` + `approval_chain_levels` (029 §2/§3, both
 * readable by every authenticated employee). The bands and the approver labels
 * come from `admin/workflow-vocab` — the same vocabulary the Workflow Designer
 * uses, so an employee and an administrator cannot read a different sentence off
 * the same chain row.
 *
 * AN EMPTY CHAIN LIST IS THE POINT, not an empty state to be padded: with no
 * chain and no `request_types.default_approval_chain_id`,
 * `create_approval_request` raises `no approval chain matches request type %` and
 * the request cannot be raised by anyone, through any client. 046 §3 seeds
 * chains for 11 of the 18 request types; `WEB_LOGIN` and `ASSET_REQUEST` are two
 * of the seven with none.
 */
import { GitBranch } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Notice } from "@/features/admin/components/Notice";
import { amountBandLabel, approverKindLabel, roleLabel } from "@/features/admin/workflow-vocab";
import { t } from "@/shared/i18n/en";
import type { ApprovalChain, ApprovalChainLevel, RequestRouting } from "../api/apply-requests.api";

export interface RequestRoutingCardProps {
  routing: RequestRouting | undefined;
  /** Rendered when the server has no chain for this type — the blocking fact. */
  missingChainMessage: string;
}

function levelLine(level: ApprovalChainLevel): string {
  const who = approverKindLabel(level.approver_kind);
  return level.role === null ? who : `${who} · ${roleLabel(level.role)}`;
}

function ChainBlock({ chain, levels }: { chain: ApprovalChain; levels: ApprovalChainLevel[] }) {
  return (
    <li className="rounded-md border bg-background p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-medium">{chain.name}</span>
        <Badge variant="neutral">{amountBandLabel(chain.amount_from, chain.amount_to)}</Badge>
      </div>
      {chain.description !== null ? (
        <p className="mt-1 text-xs text-muted-foreground">{chain.description}</p>
      ) : null}
      <ol className="mt-2 space-y-1">
        {levels.map((level) => (
          <li key={level.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span
              className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary/10 text-[0.7rem] font-semibold text-primary"
              aria-hidden
            >
              {level.level}
            </span>
            <span>{levelLine(level)}</span>
            {level.is_optional ? (
              <Badge variant="outline">{t("apply.routing.optional")}</Badge>
            ) : null}
            {level.notify_only ? (
              <Badge variant="outline">{t("apply.routing.notifyOnly")}</Badge>
            ) : null}
          </li>
        ))}
      </ol>
    </li>
  );
}

export function RequestRoutingCard({ routing, missingChainMessage }: RequestRoutingCardProps) {
  if (routing === undefined) return null;

  if (routing.chains.length === 0) {
    return (
      <Notice tone="error">
        <p className="font-medium">{t("apply.routing.none.title")}</p>
        <p className="mt-1">{missingChainMessage}</p>
      </Notice>
    );
  }

  return (
    <div className="rounded-lg border bg-card p-4">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <GitBranch className="h-4 w-4 text-muted-foreground" aria-hidden />
        {t("apply.routing.title")}
      </h3>
      <p className="mt-1 text-xs text-muted-foreground">{t("apply.routing.hint")}</p>
      <ul className="mt-3 space-y-2">
        {routing.chains.map((chain) => (
          <ChainBlock
            key={chain.id}
            chain={chain}
            levels={routing.levels.filter((l) => l.approval_chain_id === chain.id)}
          />
        ))}
      </ul>
    </div>
  );
}
