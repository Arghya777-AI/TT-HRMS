/**
 * CameraChoice — the Front / Back switch the client asked for, sized for a thumb.
 *
 * Rules it follows, all of them learned from the way this goes wrong on real
 * phones:
 *   * ONE camera → no toggle. A dead switch is worse than no switch, so the row
 *     says "this device has one camera" instead.
 *   * The chosen side is a radio group, not two buttons: a guard glancing down
 *     must be able to see which side is live without reading.
 *   * A refused switch shows the notice from `useCamera` in place, not a toast
 *     that has already vanished by the time they look up.
 */
import { SwitchCamera, User, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { t } from "@/shared/i18n/en";
import type { Facing } from "../lib/camera";
import type { CameraNotice } from "../hooks/useCamera";

export function CameraChoice({
  facing,
  canSwitch,
  switching,
  notice,
  onChoose,
}: {
  facing: Facing;
  canSwitch: boolean;
  switching: boolean;
  notice: CameraNotice | null;
  onChoose: (facing: Facing) => void;
}) {
  if (!canSwitch) {
    return (
      <p className="flex items-center gap-2 px-1 text-sm text-neutral-400">
        <SwitchCamera className="size-4 shrink-0" aria-hidden />
        {t("kiosk.gate.camera.single")}
      </p>
    );
  }

  const options: { value: Facing; label: string; hint: string; Icon: typeof User }[] = [
    {
      value: "user",
      label: t("kiosk.gate.camera.front"),
      hint: t("kiosk.gate.camera.frontHint"),
      Icon: User,
    },
    {
      value: "environment",
      label: t("kiosk.gate.camera.back"),
      hint: t("kiosk.gate.camera.backHint"),
      Icon: Users,
    },
  ];

  return (
    <div className="space-y-2">
      <div
        role="radiogroup"
        aria-label={t("kiosk.gate.camera.legend")}
        className="grid grid-cols-2 gap-2"
      >
        {options.map(({ value, label, hint, Icon }) => {
          const active = facing === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChoose(value)}
              className={cn(
                "flex min-h-16 flex-col items-center justify-center gap-0.5 rounded-xl border-2 px-3 py-2 text-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400",
                active
                  ? "border-emerald-400 bg-emerald-500/20 text-white"
                  : "border-neutral-700 bg-neutral-900 text-neutral-300",
              )}
            >
              <span className="flex items-center gap-2 font-display text-lg font-semibold">
                <Icon className="size-5" aria-hidden />
                {label}
              </span>
              <span className="text-xs leading-tight text-neutral-400">{hint}</span>
            </button>
          );
        })}
      </div>
      {switching ? (
        <p className="px-1 text-sm text-neutral-300" aria-live="polite">
          {t("kiosk.gate.camera.switching")}
        </p>
      ) : null}
      {notice !== null ? (
        <p className="px-1 text-sm text-amber-300" aria-live="polite">
          {notice === "no_back" ? t("kiosk.gate.camera.noBack") : t("kiosk.gate.camera.noFront")}
        </p>
      ) : null}
    </div>
  );
}
