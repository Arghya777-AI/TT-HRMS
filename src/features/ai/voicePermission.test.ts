/**
 * voicePermission.test.ts — the microphone button must ASK the browser.
 *
 * WHAT WENT WRONG. Pressing Dictate produced "Microphone access was blocked. Allow it in
 * your browser settings, then try again." having never shown a permission dialog — and
 * there was nothing to change in settings, because no decision had ever been recorded.
 *
 * The cause is a genuine trap in the Web Speech API: `SpeechRecognition.start()` does NOT
 * reliably raise the permission prompt in Chrome. On a page whose microphone permission is
 * undecided it can go straight to `onerror` with `not-allowed`. The call that actually
 * prompts is `navigator.mediaDevices.getUserMedia`, which this hook had never made — the
 * face-punch flow makes it for the camera, so the pattern was already in the codebase.
 *
 * WHY A SOURCE TEST. The behaviour cannot be exercised in this harness: automated Chrome
 * rejects `getUserMedia({audio: true})` with NotAllowedError under every flag combination
 * (`--use-fake-device-for-media-stream`, `--use-fake-ui-for-media-stream`), because there
 * is no audio input for it to grant. So the browser check can prove the call is MADE — and
 * it does — but never that a grant leads to listening. This pins the ordering that makes
 * the prompt appear, which is the part that regressed and the part a refactor would undo.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(join(process.cwd(), "src/features/ai/hooks/useVoice.ts"), "utf8");

describe("dictation asks the browser for the microphone", () => {
  it("calls getUserMedia for audio", () => {
    expect(SRC).toMatch(/getUserMedia\(\{\s*audio:\s*true\s*\}\)/);
  });

  it("asks BEFORE it starts recognition", () => {
    const askAt = SRC.indexOf("requestMicrophone()");
    const startAt = SRC.indexOf("rec.start()");
    expect(askAt).toBeGreaterThan(-1);
    expect(startAt).toBeGreaterThan(-1);
    // Ordering is the whole fix: prompting after start() prompts nothing.
    expect(askAt).toBeLessThan(startAt);
  });

  it("releases the stream at once rather than holding the microphone", () => {
    // Recognition opens its own; holding this one lights a second recording indicator.
    expect(SRC).toMatch(/getTracks\(\)\)\s*track\.stop\(\)/);
  });

  it("does not claim a permission problem it has not established", () => {
    // `blocked` copy only after getUserMedia actually refused, never on a bare start().
    expect(SRC).toContain('code === "not-allowed" && !micGranted.current');
  });

  it("reports an unavailable speech service as unavailable, not as a permission", () => {
    expect(SRC).toContain("ai.voice.err.service");
    expect(SRC).toContain('"service-not-allowed"');
  });
});
