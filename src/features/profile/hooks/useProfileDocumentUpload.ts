/**
 * useProfileDocumentUpload.ts — the write side of E-07.6 (/me/profile/documents).
 *
 * Separate from `useProfile.ts` for the same reason `useCustomFieldEdit.ts` is:
 * that module is the seven tabs' shared read surface and all seven import it.
 *
 * The type list is a long-lived reference read (`document_types` changes when an
 * admin edits the master, which is rarely), so it caches for five minutes like
 * the other reference reads in this feature. The upload itself invalidates
 * `qk.profile.all` — the new row belongs in the documents list AND
 * `employees.profile_completeness_pct` is a server column whose weighting counts
 * PAN, Aadhaar and a qualification, so the header bar can genuinely move.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { qk } from "@/shared/api/keys";
import { QueryError, shouldRetryQuery } from "@/shared/api/query";
import { requireEmployeeId, useEmployeeId, useProfileId } from "@/shared/api/employee-scope";
import {
  fetchUploadableDocumentTypes,
  uploadProfileDocument,
  type InsertedDocument,
  type UploadableDocumentType,
} from "../api/documents.api";

/** Document types an employee is allowed to file against. */
export function useUploadableDocumentTypes(): UseQueryResult<UploadableDocumentType[], Error> {
  return useQuery({
    queryKey: qk.profile.list({ what: "uploadable-document-types" }),
    queryFn: ({ signal }) => fetchUploadableDocumentTypes(signal),
    retry: shouldRetryQuery,
    staleTime: 5 * 60_000,
  });
}

export interface UploadDocumentInput {
  readonly type: UploadableDocumentType;
  readonly title: string;
  readonly file: File;
  readonly issueDate: string | null;
  readonly expiryDate: string | null;
  readonly note: string;
}

/**
 * `companyId` is a parameter rather than something this hook reads: it is a
 * column of THE profile row (`qk.profile.me()`), and re-reading it here would
 * create a second source for one fact — the defect class this feature's cache
 * layout exists to prevent. The caller passes what the header already rendered.
 */
export function useUploadProfileDocument(
  companyId: string | null | undefined,
): UseMutationResult<InsertedDocument, Error, UploadDocumentInput> {
  const client = useQueryClient();
  const employeeId = useEmployeeId();
  const profileId = useProfileId();
  return useMutation({
    mutationFn: (input: UploadDocumentInput) => {
      if (companyId === null || companyId === undefined || companyId === "") {
        // documents.company_id is NOT NULL and documents__self__insert pins it to
        // app.current_employee_company_id(); without it there is nothing to send.
        throw new QueryError(
          "documents",
          "no_permission",
          "Your employee record has not resolved a company, so a document cannot be filed against it.",
        );
      }
      if (profileId === null || profileId === "") {
        throw new QueryError(
          "documents",
          "no_permission",
          "This account has no signed-in profile, so an upload cannot be attributed.",
        );
      }
      return uploadProfileDocument({
        employeeId: requireEmployeeId(employeeId),
        companyId,
        profileId,
        type: input.type,
        title: input.title,
        file: input.file,
        issueDate: input.issueDate,
        expiryDate: input.expiryDate,
        note: input.note,
      });
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: qk.profile.all });
    },
  });
}
