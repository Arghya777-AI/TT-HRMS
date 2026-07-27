/**
 * setting-value.ts — reading and validating a `public.settings` jsonb value by
 * its own `value_kind`.
 *
 * Kept out of `SettingRow.tsx` so the row stays a pure component (and so the
 * Branding screen can render a swatch from the same display function the row
 * uses — two different formatters for one colour is how a preview starts lying).
 *
 * NOTHING here coerces across kinds. A `time` setting round-trips as the string
 * "05:00" and a `number` as 5; silently turning "5" into 5 is how a five-minute
 * grace period becomes five hours.
 */
import { fmtCivilDate, fmtCivilTime } from "@/lib/datetime";
import { dash } from "@/lib/format";
import { t } from "@/shared/i18n/en";
import type { Setting } from "./api/system.api";

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export { HEX_RE };

/** Human-readable form of a jsonb setting value, by the row's own `value_kind`. */
export function settingDisplay(setting: Setting): string {
  const v = setting.value;
  if (v === null || v === undefined) return dash(null);
  switch (setting.value_kind) {
    case "boolean":
      return v === true ? t("admin.settings.row.on") : t("admin.settings.row.off");
    case "time":
      return typeof v === "string" ? fmtCivilTime(v) : String(v);
    case "date":
      return typeof v === "string" ? fmtCivilDate(v) : String(v);
    case "string":
      return typeof v === "string" ? v : JSON.stringify(v);
    case "number":
    case "money":
    case "duration_minutes":
      return String(v);
    default:
      return JSON.stringify(v);
  }
}

/** The editable text form — what goes into the input when editing starts. */
export function settingToDraft(setting: Setting): string {
  const v = setting.value;
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v, null, 2);
}

/** A hex-colour row is any branding key whose name ends in `_hex`. */
export function isHexSetting(setting: Setting): boolean {
  return setting.key.endsWith("_hex");
}

export type ParseResult = { ok: true; value: unknown } | { ok: false; message: string };

/** Validate + convert a draft into the jsonb value the row's kind calls for. */
export function parseSettingDraft(setting: Setting, draft: string): ParseResult {
  const trimmed = draft.trim();
  if (trimmed === "") return { ok: false, message: t("admin.settings.row.invalid.empty") };
  switch (setting.value_kind) {
    case "number":
    case "money":
    case "duration_minutes": {
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return { ok: false, message: t("admin.settings.row.invalid.number") };
      return { ok: true, value: n };
    }
    case "time":
      if (!TIME_RE.test(trimmed)) return { ok: false, message: t("admin.settings.row.invalid.time") };
      return { ok: true, value: trimmed };
    case "date":
      if (!DATE_RE.test(trimmed)) return { ok: false, message: t("admin.settings.row.invalid.empty") };
      return { ok: true, value: trimmed };
    case "json":
      try {
        return { ok: true, value: JSON.parse(trimmed) as unknown };
      } catch {
        return { ok: false, message: t("admin.settings.row.invalid.json") };
      }
    case "boolean":
      return { ok: true, value: trimmed === "true" };
    default:
      if (isHexSetting(setting) && !HEX_RE.test(trimmed)) {
        return { ok: false, message: t("admin.settings.row.invalid.hex") };
      }
      return { ok: true, value: trimmed };
  }
}
