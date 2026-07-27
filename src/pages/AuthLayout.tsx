/**
 * AuthLayout — shared chrome for the four unauthenticated screens. Brand-led,
 * single column, no app shell (spec-employee E-01).
 */
import type { ReactNode } from "react";
import { ModeToggle } from "@/components/theme/mode-toggle";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { BRAND } from "@/config/brand";

export function AuthLayout({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="grid min-h-dvh place-items-center bg-gradient-to-b from-brand-cream to-background px-4 py-10 dark:from-brand-navy dark:to-background">
      <div className="w-full max-w-md">
        <div className="mb-6 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span
              className="grid h-10 w-10 place-items-center rounded-md bg-brand-terracotta font-display text-base font-bold text-white"
              aria-hidden
            >
              TT
            </span>
            <div>
              <p className="font-display text-base font-semibold leading-none">{BRAND.tradingName}</p>
              <p className="text-xs text-muted-foreground">{BRAND.legalName}</p>
            </div>
          </div>
          <ModeToggle />
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="font-display text-xl">{title}</CardTitle>
            {description ? <CardDescription>{description}</CardDescription> : null}
          </CardHeader>
          <CardContent>{children}</CardContent>
        </Card>

        {footer ? <div className="mt-4 text-center text-sm text-muted-foreground">{footer}</div> : null}
      </div>
    </div>
  );
}
