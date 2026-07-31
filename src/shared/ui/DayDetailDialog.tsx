/**
 * DayDetailDialog — a calendar day's detail, in a modal over the grid.
 *
 * WHY A MODAL AND NOT A PANEL UNDERNEATH. Both calendars opened the tapped day in a block
 * BELOW the grid. Three things were wrong with that and all of them are worse the smaller
 * the screen: the answer appeared off-screen on a phone so a tap looked like it did
 * nothing; opening a day pushed everything after the calendar down, so the page moved
 * under the reader; and nothing tied the detail to the cell it came from except proximity.
 * A modal appears where the eye already is, dismisses on Escape or a click outside, and
 * returns focus to the cell.
 *
 * ONE DIALOG FOR EVERY CALENDAR. The admin leave calendar and the employee attendance
 * calendar show completely different content, so this owns the shell — the overlay, the
 * sizing, the escape handling, the close button, the scroll behaviour of a long day — and
 * takes the content as children. Two shells would drift, and the second one is always the
 * one without the focus handling.
 *
 * BUILT ON @radix-ui/react-dialog rather than the alert-dialog `ReasonDialog` uses. That
 * distinction is deliberate: an alertdialog refuses casual dismissal because losing a
 * typed reason is destructive. Reading a day is not, so Escape and a backdrop click must
 * simply close it.
 */
import type { ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";

export interface DayDetailDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** The date, already formatted for a human. Becomes the accessible name. */
  readonly title: string;
  /** One line under the title — a count, a status, a shift name. */
  readonly subtitle?: string | null;
  readonly children: ReactNode;
  /** Actions pinned to the bottom, e.g. "Open the full day". */
  readonly footer?: ReactNode;
  readonly className?: string;
}

export function DayDetailDialog({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  className,
}: DayDetailDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-black/50 backdrop-blur-sm",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0",
          )}
        />
        <Dialog.Content
          className={cn(
            // Centred, and capped so a day with thirty people scrolls INSIDE the modal
            // rather than growing it past the viewport.
            "fixed left-1/2 top-1/2 z-50 flex max-h-[min(85vh,42rem)] w-[calc(100vw-2rem)] max-w-md",
            "-translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border",
            "bg-background shadow-2xl",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
            "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
            className,
          )}
        >
          {/* The header does not scroll: the date must stay visible while a long list moves. */}
          <div className="flex items-start justify-between gap-3 border-b bg-gradient-to-br from-primary/10 to-transparent px-4 py-3">
            <div className="min-w-0">
              <Dialog.Title className="font-display text-base font-semibold">{title}</Dialog.Title>
              {subtitle != null && subtitle !== "" ? (
                <Dialog.Description className="mt-0.5 text-xs text-muted-foreground">
                  {subtitle}
                </Dialog.Description>
              ) : null}
            </div>
            <Dialog.Close
              className="rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={t("common.close")}
            >
              <X className="size-4" aria-hidden />
            </Dialog.Close>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>

          {footer != null ? (
            <div className="border-t bg-muted/30 px-4 py-2.5">{footer}</div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
