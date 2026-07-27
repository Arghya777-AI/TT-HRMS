/**
 * useProfile.ts — TanStack Query hooks for the seven E-07 tabs.
 *
 * Every tab depends on `useMyProfile()`, which is keyed `qk.profile.me()`. That
 * single cache entry is the reason the Basic tab's DOB and the Employment tab's
 * join date can never come from two different reads of the same row — the
 * "dashboard vs modal" defect (DR-29) is structurally impossible here.
 *
 * The dependent queries (policies, company) are `enabled` only once the profile
 * row has resolved, because their parameters ARE columns of that row. Passing a
 * placeholder id would either 404 or, worse, silently read someone else's policy.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { requireEmployeeId, useEmployeeId, useProfileId } from "@/shared/api/employee-scope";
import {
  fetchCompany,
  fetchHobbies,
  fetchMyEmployeeProfile,
  fetchOrgLabels,
  fetchPeople,
  fetchSkills,
  type Company,
  type Hobby,
  type MyEmployeeProfile,
  type OrgLabels,
  type PersonRef,
  type Skill,
} from "../api/profile.api";
import {
  fetchEmploymentPolicies,
  fetchSwipeCards,
  type EmploymentPolicies,
  type SwipeCard,
} from "../api/employment.api";
import {
  fetchBankAccounts,
  fetchStatutoryMasked,
  type BankAccountMasked,
  type StatutoryMasked,
} from "../api/payment.api";
import { fetchPersonalRecords, type PersonalRecords } from "../api/personal.api";
import {
  fetchCustomFields,
  joinCustomFields,
  type CustomFieldRow,
} from "../api/custom-fields.api";
import { fetchProfileDocuments, type ProfileDocument } from "../api/documents.api";
import {
  buildRecordHistory,
  fetchChangeRequests,
  fetchLifecycleEvents,
  fetchMyDataAccess,
  type ChangeRequest,
  type DataAccessEntry,
  type RecordHistoryEntry,
} from "../api/history.api";
import { lifecycleEventLabel } from "../display";

// -----------------------------------------------------------------------------
// 1. THE profile row — every tab's root dependency
// -----------------------------------------------------------------------------

/**
 * The caller's own employee record.
 *
 * `null` data is a real, distinct state from an error: a signed-in user with no
 * employee row (kiosk-only staff, `portal_access_state = 'none'`) must see the
 * no-permission state, which is what the pages branch on.
 */
export function useMyProfile(): UseQueryResult<MyEmployeeProfile | null, Error> {
  return useQuery({
    queryKey: qk.profile.me(),
    queryFn: ({ signal }) => fetchMyEmployeeProfile(signal),
    retry: shouldRetryQuery,
    staleTime: 60_000,
  });
}

/** Resolved department/section/designation/grade/location names. */
export function useOrgLabels(): UseQueryResult<OrgLabels | null, Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.profile.orgLabels(employeeId ?? "none"),
    queryFn: ({ signal }) => fetchOrgLabels(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
    staleTime: 5 * 60_000,
  });
}

/** The legal entity (DR-54: one entity, rendered by its full legal name). */
export function useCompany(companyId: string | null): UseQueryResult<Company | null, Error> {
  return useQuery({
    queryKey: qk.profile.detail(`company:${companyId ?? "none"}`),
    queryFn: ({ signal }) => (companyId === null ? null : fetchCompany(companyId, signal)),
    enabled: companyId !== null,
    retry: shouldRetryQuery,
    staleTime: 30 * 60_000,
  });
}

// -----------------------------------------------------------------------------
// 2. Basic tab
// -----------------------------------------------------------------------------

export function useSkills(): UseQueryResult<Skill[], Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.profile.skills(employeeId ?? "none"),
    queryFn: ({ signal }) => fetchSkills(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

export function useHobbies(): UseQueryResult<Hobby[], Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.profile.hobbies(employeeId ?? "none"),
    queryFn: ({ signal }) => fetchHobbies(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

export interface ReportingLine {
  readonly manager: PersonRef | null;
  readonly dottedLineManager: PersonRef | null;
  /** True when an id is set but the person is not in the directory (exited). */
  readonly managerUnresolved: boolean;
  readonly dottedLineUnresolved: boolean;
}

/**
 * The reporting line, resolved to people.
 *
 * An id that resolves to nothing is reported as `*Unresolved`, not as null: the
 * manager exists on the record but has left the company (the directory view
 * excludes exited rows), and "no longer with the company" is the honest label.
 */
export function useReportingLine(
  managerId: string | null,
  dottedLineManagerId: string | null,
): UseQueryResult<ReportingLine, Error> {
  const employeeId = useEmployeeId();
  const ids = [managerId, dottedLineManagerId].filter((v): v is string => v !== null);
  return useQuery({
    queryKey: qk.profile.reporting(employeeId ?? "none"),
    queryFn: async ({ signal }): Promise<ReportingLine> => {
      if (ids.length === 0) {
        return {
          manager: null,
          dottedLineManager: null,
          managerUnresolved: false,
          dottedLineUnresolved: false,
        };
      }
      const people = await fetchPeople(ids, signal);
      const byId = new Map(people.map((p) => [p.id, p]));
      const manager = managerId === null ? null : byId.get(managerId) ?? null;
      const dotted = dottedLineManagerId === null ? null : byId.get(dottedLineManagerId) ?? null;
      return {
        manager,
        dottedLineManager: dotted,
        managerUnresolved: managerId !== null && manager === null,
        dottedLineUnresolved: dottedLineManagerId !== null && dotted === null,
      };
    },
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
    staleTime: 5 * 60_000,
  });
}

// -----------------------------------------------------------------------------
// 3. Employment tab
// -----------------------------------------------------------------------------

/**
 * Shift + weekly-off rule + attendance policy + pay period + holiday calendar.
 *
 * Keyed on the employee, but the QUERY FUNCTION depends on five ids from the
 * profile row, so the hook takes them as arguments and stays disabled until the
 * profile resolves. `profile` being null (no employee row) leaves it disabled —
 * the tab renders no-permission from `useMyProfile` instead.
 */
export function useEmploymentPolicies(
  profile: MyEmployeeProfile | null | undefined,
): UseQueryResult<EmploymentPolicies, Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.profile.employmentPolicies(employeeId ?? "none"),
    queryFn: ({ signal }) => {
      if (!profile) {
        return Promise.resolve<EmploymentPolicies>({
          shift: null,
          weeklyOff: null,
          attendancePolicy: null,
          payPeriod: null,
          holidayCalendar: null,
        });
      }
      return fetchEmploymentPolicies(
        {
          shiftId: profile.shift_id,
          weeklyOffRuleId: profile.weekly_off_rule_id,
          attendancePolicyId: profile.attendance_policy_id,
          payPeriodId: profile.pay_period_id,
          holidayCalendarId: profile.holiday_calendar_id,
        },
        signal,
      );
    },
    enabled: employeeId !== null && profile != null,
    retry: shouldRetryQuery,
    staleTime: 5 * 60_000,
  });
}

export function useSwipeCards(): UseQueryResult<SwipeCard[], Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.profile.swipeCards(employeeId ?? "none"),
    queryFn: ({ signal }) => fetchSwipeCards(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 4. Payment tab
// -----------------------------------------------------------------------------

export function useStatutory(): UseQueryResult<StatutoryMasked | null, Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.profile.statutory(employeeId ?? "none"),
    queryFn: ({ signal }) => fetchStatutoryMasked(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

export function useBankAccounts(): UseQueryResult<BankAccountMasked[], Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.profile.bankAccounts(employeeId ?? "none"),
    queryFn: ({ signal }) => fetchBankAccounts(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 5. Personal tab
// -----------------------------------------------------------------------------

/**
 * All five personal satellites in one query.
 *
 * Deliberately ONE cache entry: the emergency-contact card and the addresses
 * card are two views of the same fetch, so they cannot show different vintages
 * of the record, and one retry fixes the whole tab.
 */
export function usePersonalRecords(): UseQueryResult<PersonalRecords, Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.profile.contacts(employeeId ?? "none"),
    queryFn: ({ signal }) => fetchPersonalRecords(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 6. Custom tab
// -----------------------------------------------------------------------------

/**
 * Custom fields already joined to their values and filtered to the defs that
 * apply to this employee's employment type and department.
 */
export function useCustomFields(
  profile: MyEmployeeProfile | null | undefined,
): UseQueryResult<CustomFieldRow[], Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.profile.customFields(employeeId ?? "none"),
    queryFn: async ({ signal }): Promise<CustomFieldRow[]> => {
      const id = requireEmployeeId(employeeId);
      const bundle = await fetchCustomFields(id, signal);
      if (!profile) return [];
      return joinCustomFields(
        bundle.defs,
        bundle.values,
        profile.employment_type,
        profile.department_id,
      );
    },
    enabled: employeeId !== null && profile != null,
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 7. Documents tab
// -----------------------------------------------------------------------------

export function useProfileDocuments(): UseQueryResult<ProfileDocument[], Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.profile.documents(employeeId ?? "none"),
    queryFn: ({ signal }) => fetchProfileDocuments(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

// -----------------------------------------------------------------------------
// 8. History tab
// -----------------------------------------------------------------------------

export function useChangeRequests(): UseQueryResult<ChangeRequest[], Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.profile.changeRequests(employeeId ?? "none"),
    queryFn: ({ signal }) => fetchChangeRequests(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/**
 * The merged own-record history: applied change requests + lifecycle events,
 * newest first, each with a real From → To pair and an attribution.
 *
 * `useProfileId()` supplies the signed-in user's `profiles.id`, which is what
 * distinguishes "you changed this" from "HR changed this on your behalf" — the
 * assisted-mode case the reference product rendered identically to a self-edit.
 */
export function useRecordHistory(): UseQueryResult<RecordHistoryEntry[], Error> {
  const employeeId = useEmployeeId();
  const myProfileId = useProfileId();
  return useQuery({
    queryKey: qk.profile.recordHistory(employeeId ?? "none"),
    queryFn: async ({ signal }): Promise<RecordHistoryEntry[]> => {
      const id = requireEmployeeId(employeeId);
      const [changeRequests, lifecycleEvents] = await Promise.all([
        fetchChangeRequests(id, signal),
        fetchLifecycleEvents(id, signal),
      ]);
      return buildRecordHistory(
        changeRequests,
        lifecycleEvents,
        myProfileId,
        lifecycleEventLabel,
      );
    },
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/** Who revealed or exported the caller's sensitive fields, and the stated why. */
export function useMyDataAccess(): UseQueryResult<DataAccessEntry[], Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.profile.dataAccess(employeeId ?? "none"),
    queryFn: ({ signal }) => fetchMyDataAccess(signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}
