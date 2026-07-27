/**
 * useDocs.ts — TanStack Query hooks for E-09. Keys from `qk.docs.*` only.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { shouldRetryQuery } from "@/shared/api/query";
import { requireEmployeeId, useEmployeeId } from "@/shared/api/employee-scope";
import {
  fetchMyDocuments,
  fetchMySignedAcknowledgements,
  type DocumentAck,
  type DocumentRow,
} from "../api/docs.api";

const NO_EMPLOYEE = "no-employee";

/** Every document on my record — tabs 1 and 2 are two filters over this one read. */
export function useMyDocuments(): UseQueryResult<DocumentRow[], Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.docs.list({ employeeId: employeeId ?? NO_EMPLOYEE }),
    queryFn: ({ signal }) => fetchMyDocuments(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}

/** Tab 3 — policies acknowledged and documents signed. */
export function useMySignedDocuments(): UseQueryResult<DocumentAck[], Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: qk.docs.list({ employeeId: employeeId ?? NO_EMPLOYEE, signed: true }),
    queryFn: ({ signal }) => fetchMySignedAcknowledgements(requireEmployeeId(employeeId), signal),
    enabled: employeeId !== null,
    retry: shouldRetryQuery,
  });
}
