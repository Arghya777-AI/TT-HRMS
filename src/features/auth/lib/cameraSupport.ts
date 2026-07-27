/**
 * cameraSupport.ts — is a camera reachable from this browser at all?
 *
 * Face sign-in is only offered when it is. `getUserMedia` is undefined outside a
 * secure context, so an http:// preview or an old in-app webview must not get a
 * button that can only fail. Whether the employee has an ENROLLED face is a
 * different question and not answerable here: `auth-identify` deliberately
 * returns only five facts and a face template is not one of them, so the server
 * answers that with a typed refusal on the attempt.
 */
export function browserCanUseCamera(): boolean {
  if (typeof navigator === "undefined" || typeof window === "undefined") return false;
  if (!window.isSecureContext) return false;
  const media: MediaDevices | undefined = navigator.mediaDevices;
  return media !== undefined && typeof media.getUserMedia === "function";
}
