/**
 * useScheduledReports.ts — the recurring-report register.
 *
 * Keys sit under `qk.admin.orgList("scheduledReports", …)`, so the analytics
 * screens and this one invalidate together.
 *
 * Every mutation here writes CONFIGURATION, not a dispatch. Nothing in this file
 * sends anything, because nothing in the product does yet — see the api module's
 * header. The screen reads `last_dispatched_at` to say so rather than letting an
 * enabled schedule imply delivery.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import {
  addRecipient,
  createScheduledReport,
  fetchRecipients,
  fetchScheduledReports,
  fetchScheduledReportsDue,
  setScheduleEnabled,
  type AddRecipientInput,
  type CreateScheduledReportInput,
  type ScheduledReport,
  type ScheduledReportDue,
  type ScheduledReportRecipient,
} from "../api/scheduled-reports.api";

export function useScheduledReports(): UseQueryResult<ScheduledReport[], Error> {
  return useQuery({
    queryKey: qk.admin.orgList("scheduledReports", { part: "list" }),
    queryFn: ({ signal }) => fetchScheduledReports(signal),
    retry: shouldRetryQuery,
  });
}

/** Enabled schedules, with recipient counts and whether anything has ever sent one. */
export function useScheduledReportsDue(): UseQueryResult<ScheduledReportDue[], Error> {
  return useQuery({
    queryKey: qk.admin.orgList("scheduledReports", { part: "due" }),
    queryFn: ({ signal }) => fetchScheduledReportsDue(signal),
    retry: shouldRetryQuery,
  });
}

export function useReportRecipients(
  reportId: string | null,
): UseQueryResult<ScheduledReportRecipient[], Error> {
  const id = reportId ?? "";
  return useQuery({
    queryKey: qk.admin.orgList("scheduledReports", { part: "recipients", id }),
    queryFn: ({ signal }) => fetchRecipients(id, signal),
    enabled: id !== "",
    retry: shouldRetryQuery,
  });
}

export function useCreateScheduledReport(): UseMutationResult<
  ScheduledReport,
  Error,
  CreateScheduledReportInput
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateScheduledReportInput) => createScheduledReport(input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.admin.orgAll() });
    },
    retry: false,
  });
}

export function useSetScheduleEnabled(): UseMutationResult<
  ScheduledReport,
  Error,
  { readonly reportId: string; readonly enabled: boolean }
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (v: { reportId: string; enabled: boolean }) =>
      setScheduleEnabled(v.reportId, v.enabled),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.admin.orgAll() });
    },
    retry: false,
  });
}

export function useAddRecipient(): UseMutationResult<
  ScheduledReportRecipient,
  Error,
  AddRecipientInput
> {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: AddRecipientInput) => addRecipient(input),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.admin.orgAll() });
    },
    retry: false,
  });
}
