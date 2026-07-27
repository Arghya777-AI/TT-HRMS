/**
 * Coerce a value to an array before iterating it.
 *
 * `x ?? []` only guards null and undefined. It does NOT guard "the value arrived
 * as something else", and calling `.map` on a non-array throws a TypeError that
 * takes the whole screen to an error boundary — which is exactly what happened on
 * `/admin/attendance/punches`:
 *
 *     (devices.data ?? []).map is not a function
 *
 * Every static path said that value was an array, and the live query returns one,
 * so the likeliest cause was a stale module under a running dev server. That is
 * precisely the case worth surviving: a list that momentarily is not a list should
 * render empty, not destroy the page around it.
 *
 * Deliberately NOT a validation function — it does not check element types. It is
 * the last line of defence for an iteration; the zod schemas at the query layer
 * remain the real contract.
 *
 * Returns the SAME array when given one (no copy), so it is safe in a `useMemo`
 * dependency chain, and a single frozen empty array otherwise so the fallback has a
 * stable identity too.
 */
const EMPTY: readonly never[] = Object.freeze([]);

export function asArray<T>(value: readonly T[] | T[] | null | undefined): T[] {
  return Array.isArray(value) ? (value as T[]) : (EMPTY as unknown as T[]);
}
