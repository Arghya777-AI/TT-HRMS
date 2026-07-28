/**
 * SettingRow — one `public.settings` row, rendered by its own `value_kind` and
 * editable only through the reason prompt.
 *
 * Three rules the row enforces so no screen has to remember them:
 *
 *  1. `value` is jsonb and this component does NOT coerce. A `time` setting is
 *     saved as the string "05:00", a `number` as 5 — silently turning "5" into 5
 *     is how a five-minute grace period becomes five hours.
 *  2. `is_editable_by_admin = false` disables the control and SAYS why, instead
 *     of letting the admin type a value and meet a 42501 from
 *     `settings__admin_write`.
 *  3. The reason dialog's description carries the old value and the new one —
 *     the diff preview §3.5 asks for on a sensitive touch.
 */
import { useState } from "react";
import { Lock } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { fmtDateTime } from "@/lib/datetime";
import { t } from "@/shared/i18n/en";
import { cn } from "@/lib/utils";
import { ReasonActionButton } from "./ReasonActionButton";
import type { Setting } from "../api/system.api";
import {
  HEX_RE,
  isHexSetting,
  parseSettingDraft,
  settingDisplay,
  settingToDraft,
} from "../setting-value";

export interface SettingRowProps {
  setting: Setting;
  /** False → the row is read-only and says so (super-admin-only rows). */
  canEdit: boolean;
  /** Performs the audited write; rejects on failure so the dialog stays open. */
  onSave: (value: unknown, reason: string) => Promise<unknown>;
}

export function SettingRow({ setting, canEdit, onSave }: SettingRowProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => settingToDraft(setting));
  const [fieldError, setFieldError] = useState<string | null>(null);

  const current = settingDisplay(setting);
  const isBoolean = setting.value_kind === "boolean";
  const isJson = setting.value_kind === "json";
  const parsed = parseSettingDraft(setting, draft);
  const nextDisplay = parsed.ok
    ? settingDisplay({ ...setting, value: parsed.value })
    : draft.trim();

  function startEditing(): void {
    setDraft(settingToDraft(setting));
    setFieldError(null);
    setEditing(true);
  }

  async function save(reason: string): Promise<void> {
    const result = parseSettingDraft(setting, draft);
    if (!result.ok) {
      setFieldError(result.message);
      throw new Error(result.message);
    }
    await onSave(result.value, reason);
    setEditing(false);
  }

  return (
    <div className="flex flex-col gap-3 border-b px-4 py-3 last:border-b-0 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{setting.label}</p>
        {setting.description !== null ? (
          <p className="mt-0.5 text-xs text-muted-foreground">{setting.description}</p>
        ) : null}
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span className="font-mono">{setting.key}</span>
          <span>{t("admin.settings.row.updated", { when: fmtDateTime(setting.updated_at) })}</span>
          {!canEdit ? (
            <Badge variant="neutral">
              <Lock className="mr-1 h-3 w-3" aria-hidden />
              {t("admin.settings.row.superOnly")}
            </Badge>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 flex-col items-stretch gap-2 sm:items-end">
        {isBoolean ? (
          <div className="flex items-center gap-2">
            <Badge variant={setting.value === true ? "success" : "neutral"}>{current}</Badge>
            <ReasonActionButton
              label={
                setting.value === true ? t("admin.settings.row.turnOff") : t("admin.settings.row.turnOn")
              }
              title={t("admin.settings.row.reason.title", { label: setting.label })}
              description={t("admin.settings.row.reason.description", {
                from: current,
                to: setting.value === true ? t("admin.settings.row.off") : t("admin.settings.row.on"),
              })}
              disabled={!canEdit}
              disabledHint={t("admin.settings.row.superOnlyHint")}
              onConfirm={(reason) => onSave(setting.value !== true, reason)}
            />
          </div>
        ) : editing ? (
          <div className="flex w-full flex-col gap-2 sm:w-72">
            {isJson ? (
              <textarea
                value={draft}
                rows={4}
                aria-label={setting.label}
                aria-invalid={fieldError !== null || !parsed.ok}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setFieldError(null);
                }}
                className={cn(
                  "w-full resize-y rounded-md border border-input bg-background px-3 py-2 font-mono text-xs",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  (fieldError !== null || !parsed.ok) && "border-destructive",
                )}
              />
            ) : (
              <div className="flex items-center gap-2">
                {isHexSetting(setting) ? (
                  <span
                    className="h-8 w-8 shrink-0 rounded border"
                    style={HEX_RE.test(draft.trim()) ? { backgroundColor: draft.trim() } : undefined}
                    aria-hidden
                  />
                ) : null}
                <Input
                  value={draft}
                  aria-label={setting.label}
                  aria-invalid={fieldError !== null || !parsed.ok}
                  inputMode={
                    setting.value_kind === "number" ||
                    setting.value_kind === "money" ||
                    setting.value_kind === "duration_minutes"
                      ? "decimal"
                      : "text"
                  }
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setFieldError(null);
                  }}
                  className={cn((fieldError !== null || !parsed.ok) && "border-destructive")}
                />
              </div>
            )}
            {!parsed.ok || fieldError !== null ? (
              <p className="text-xs font-medium text-destructive" role="alert">
                {fieldError ?? (parsed.ok ? "" : parsed.message)}
              </p>
            ) : null}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
                {t("admin.settings.row.cancel")}
              </Button>
              <ReasonActionButton
                label={t("admin.settings.row.save")}
                variant="default"
                title={t("admin.settings.row.reason.title", { label: setting.label })}
                description={t("admin.settings.row.reason.description", {
                  from: current,
                  to: nextDisplay,
                })}
                disabled={!parsed.ok}
                disabledHint={parsed.ok ? undefined : parsed.message}
                onConfirm={save}
              />
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <span className={cn("num text-sm", isHexSetting(setting) && "font-mono")}>{current}</span>
            {isHexSetting(setting) && HEX_RE.test(current) ? (
              <span
                className="h-6 w-6 shrink-0 rounded border"
                style={{ backgroundColor: current }}
                aria-hidden
              />
            ) : null}
            <Button
              variant="outline"
              size="sm"
              disabled={!canEdit}
              title={canEdit ? undefined : t("admin.settings.row.superOnlyHint")}
              onClick={startEditing}
            >
              {t("admin.settings.row.edit")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
