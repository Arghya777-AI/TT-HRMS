/**
 * PairingScreen — step 0, once per device. THE CODE IS THE ONLY THING THAT MATCHES.
 *
 * WHY THIS CHANGED, IN THE CLIENT'S WORDS
 * --------------------------------------
 * "The device name shouldn't matter; they can put anything for the device name.
 *  Only the pairing code should match, then it should be automatically registered…
 *  If admin generates one particular code, if the code is given, whatever the device
 *  name they can put, and then if they register, then it will be registered."
 *
 * It used to demand a DEVICE CODE that had to match a row an admin had created
 * (`TT-GATE-01`) plus the 6-digit activation code. That meant the guard had to be
 * told two things, one of which they had no way to know or check, and a typo in it
 * produced the same refusal as a wrong code. Worse, there was no admin UI to create
 * a device at all, so the only pairable code was one seeded by a migration.
 *
 * Now: the admin taps "Add a gate device", reads out six digits, and the person at
 * the door types those six digits plus whatever they want to call the phone. The
 * name goes to `kiosk_devices.label` (via `proposed_name`) and the internal
 * `device_code` is generated server-side and never shown to anybody.
 *
 * IS ONE SHORT CODE ENOUGH? Yes, and it is worth being precise rather than
 * reassuring. The code is Argon2id-hashed at rest, single-use, revoked when a new
 * one is issued, expires 15 minutes after issue, and `RATE_LIMITS.kioskPair` allows
 * ten attempts per hour per IP. That is roughly three guesses against 900,000
 * possibilities inside a code's lifetime. The device secret it buys is what actually
 * authorises punches, and that never travels through a human.
 *
 * The device secret is still what stops an arbitrary browser from posting punches,
 * so opening the link on a new phone means pairing it — there is no way to skip this
 * and no way to inherit another device's credential.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { t } from "@/shared/i18n/en";
import { pairDevice, type KioskDeviceState } from "../lib/deviceAuth";
import { GateFrame } from "../components/GateChrome";

export function PairingScreen({ onPaired }: { onPaired: (state: KioskDeviceState) => void }) {
  const [deviceName, setDeviceName] = useState("");
  const [activationCode, setActivationCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    const result = await pairDevice(activationCode, deviceName);
    setBusy(false);
    if (result.ok) onPaired(result.data);
    else setError(result.error.detail);
  };

  return (
    <GateFrame
      title={t("kiosk.pair.title")}
      subtitle={t("kiosk.pair.hint")}
      footer={t("kiosk.pair.footer")}
    >
      <div className="space-y-4">
        {/* THE CODE FIRST, because it is the only field that has to be right. The
            old layout led with a device code the guard could not know, which made
            the screen feel like a login they were going to fail. */}
        <label className="block space-y-1.5">
          <span className="text-sm text-neutral-300">{t("kiosk.pair.activationCode")}</span>
          <input
            value={activationCode}
            inputMode="numeric"
            autoComplete="one-time-code"
            onChange={(e) => setActivationCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="••••••"
            className="num min-h-14 w-full rounded-xl border border-neutral-700 bg-neutral-900 px-4 text-center font-display text-2xl tracking-[0.4em] text-neutral-50 placeholder:text-neutral-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm text-neutral-300">{t("kiosk.pair.deviceName")}</span>
          {/* Free text, and NOT uppercased — it is a name a person chose, not a
              code. Optional: leaving it blank keeps whatever the admin typed. */}
          <input
            value={deviceName}
            autoCorrect="off"
            spellCheck={false}
            maxLength={120}
            onChange={(e) => setDeviceName(e.target.value)}
            placeholder={t("kiosk.pair.deviceNamePlaceholder")}
            className="min-h-14 w-full rounded-xl border border-neutral-700 bg-neutral-900 px-4 text-lg text-neutral-50 placeholder:text-neutral-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          />
          <span className="block text-xs text-neutral-500">{t("kiosk.pair.deviceNameHint")}</span>
        </label>
        {error !== null ? (
          <p className="rounded-lg border border-red-500/60 bg-red-950/60 px-3 py-2 text-base text-red-100" aria-live="polite">
            {error}
          </p>
        ) : null}
        <Button
          size="lg"
          className="min-h-14 w-full text-base"
          // ONLY the code gates the button. The name is optional by design.
          disabled={busy || activationCode.length < 4}
          onClick={() => void submit()}
        >
          {busy ? t("kiosk.pair.pairing") : t("kiosk.pair.submit")}
        </Button>
      </div>
    </GateFrame>
  );
}
