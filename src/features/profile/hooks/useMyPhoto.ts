/**
 * useMyPhoto — the signed-in person's avatar URL, cached under its own expiry.
 *
 * THE CACHE WINDOW IS THE WHOLE DESIGN. The link `document-access` mints for a
 * photograph lives ten minutes; this caches it for eight and refetches at eight. Cache
 * it for longer than the link lives and the avatar silently 403s halfway through the
 * morning; cache it for less and every navigation mints a new one and writes access-log
 * rows nobody wants to read.
 *
 * `refetchOnWindowFocus` is OFF, deliberately, against the repo's usual habit: a person
 * tabbing back and forth does not need their own face re-fetched, and each fetch is two
 * network calls plus a log row.
 *
 * IT NEVER SURFACES AN ERROR. `fetchMyPhotoUrl` resolves `null` for every failure —
 * no photo, bytes missing, refusal — because an avatar that cannot load must fall back
 * to initials, not put a red message in the topbar of every page.
 */
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useEmployeeId } from "@/shared/api/employee-scope";
import { fetchMyPhotoUrl, type PhotoUrl } from "../api/photo.api";

/** Eight minutes, against the ten-minute link. See the header. */
const PHOTO_STALE_MS = 8 * 60_000;

export function useMyPhoto(): UseQueryResult<PhotoUrl | null, Error> {
  const employeeId = useEmployeeId();
  return useQuery({
    queryKey: ["profile", "my-photo", employeeId ?? "none"],
    queryFn: ({ signal }) =>
      employeeId === null ? Promise.resolve(null) : fetchMyPhotoUrl(employeeId, signal),
    enabled: employeeId !== null,
    staleTime: PHOTO_STALE_MS,
    refetchInterval: PHOTO_STALE_MS,
    refetchOnWindowFocus: false,
    // One attempt. A retry storm over decoration is not worth a single extra request.
    retry: false,
  });
}
