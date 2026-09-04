/**
 * Whether the off-hours punch queue shows its contents.
 *
 * Its own module rather than an export from the component: sharing a plain function out of a
 * file that also exports a component breaks Fast Refresh, and this rule is worth testing
 * directly — it has three inputs and two of them are negatives.
 */

/**
 * Whether the queue shows its contents.
 *
 * Pulled out as a function because the rule has three inputs and one of them is a negative:
 * an EMPTY queue is the shut case, and a FAILED one must never look empty. Inline in the
 * component that reads as one expression nobody can test.
 *
 * @param override  a manual click, or null when nobody has clicked since the count moved
 * @param pending   how many punches are waiting
 * @param failed    whether the query errored
 */
export function shouldExpandQueue(
  override: boolean | null,
  pending: number,
  failed: boolean,
): boolean {
  if (override !== null) return override;
  return pending > 0 || failed;
}
