import type { ComponentType } from "react";
import { CircleDashed, Wrench } from "lucide-react";
import { PageHeader } from "@/shared/ui/PageHeader";
import { EmptyState } from "@/shared/ui/EmptyState";
import { t } from "@/shared/i18n/en";

export interface PageStubProps {
  icon: ComponentType<{ className?: string }>;
  /** Real screen name from the spec route table. */
  title: string;
  subtitle?: string;
  /** One-line purpose from the spec — shown while the screen is being wired. */
  hint: string;
  /** P2 / feature-flagged routes render the "not switched on" state instead. */
  phase?: "P1" | "P1.5" | "P2";
}

/**
 * Placeholder page body used by every route stub. Feature agents REPLACE the
 * page file that renders this — they never edit PageStub itself.
 */
export default function PageStub({ icon, title, subtitle, hint, phase = "P1" }: PageStubProps) {
  const switchedOff = phase === "P2";
  return (
    <div className="container py-6">
      <PageHeader icon={icon} title={title} subtitle={subtitle} />
      {switchedOff ? (
        <EmptyState icon={CircleDashed} title={t("stub.off.title")} hint={t("stub.off.hint")} />
      ) : (
        <EmptyState icon={Wrench} title={t("stub.wiring.title")} hint={hint} />
      )}
    </div>
  );
}
