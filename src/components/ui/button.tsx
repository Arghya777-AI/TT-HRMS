import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * A BUTTON MAY WRAP ON A PHONE, AND MUST NOT PUSH THE PAGE SIDEWAYS.
 *
 * `whitespace-nowrap` alone was the single most common cause of horizontal page overflow in
 * this app. Not every label is a verb: several are whole sentences — "Take the remaining 1
 * day(s) as loss of pay", "Need a full re-derivation? Use the Recompute Console", "Show my
 * attendance trend over the last three months" — and unbreakable text 400px wide inside a
 * 320px viewport makes the WHOLE document scroll, which drags the fixed bottom nav out of
 * alignment with the content behind it.
 *
 * So: wrapping below `sm`, `nowrap` from `sm` up. Desktop layouts are untouched — they were
 * designed and checked at that width — and phones get text that reflows instead of a page that
 * drifts. `max-w-full` stops a button exceeding its container even when a single word cannot
 * break.
 *
 * The sizes below are `min-h-*` rather than `h-*` for the same reason: a wrapped label needs
 * two lines of room, and a fixed height would clip it. For single-line content — every button
 * on a desktop, and most on a phone — `min-h-10 h-auto` computes to exactly the 40px that
 * `h-10` gave, so nothing moves.
 */
const buttonVariants = cva(
  "inline-flex h-auto max-w-full items-center justify-center gap-2 whitespace-normal rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 sm:whitespace-nowrap [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        gold: "bg-brand-gold text-brand-navy hover:bg-brand-gold/90",
      },
      size: {
        default: "min-h-10 px-4 py-2",
        sm: "min-h-9 rounded-md px-3 py-1.5",
        lg: "min-h-11 rounded-md px-8 text-base",
        xl: "min-h-14 rounded-lg px-10 text-lg",
        // An icon button holds one glyph and must stay square — no wrapping to allow for.
        icon: "size-10 shrink-0 whitespace-nowrap",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
