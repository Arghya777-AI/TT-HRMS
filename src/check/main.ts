/**
 * main.ts — the face-engine half of the gate self-test.
 *
 * The environment probes in `check/index.html` are ES5 and inline, so they report even on a
 * browser that cannot parse a bundle. This module is the part that can only be answered by
 * running the real thing, and it imports THE REAL THING: `loadFaceModels` and `readFrame`
 * from `facePipeline.ts`, the same functions the gate calls. A reimplementation here would
 * prove nothing about whether the gate works.
 *
 * WHAT IT ACTUALLY SETTLES
 * -----------------------
 * Whether TensorFlow.js runs under this browser's JavaScript engine, which is the one
 * question about Safari 12.1 that no compatibility table answers. Everything else can pass
 * and this can still fail — and if it does, no native shell helps, because WKWebView uses the
 * same engine. That makes this the test that decides whether the hardware is usable at all.
 *
 * A PHOTO IS OFFERED, NOT JUST THE CAMERA
 * ---------------------------------------
 * On iOS 12 a Home Screen web app has no `getUserMedia`, so on the very device this page
 * matters most the camera may be unavailable — and then a camera-only test reports nothing
 * about recognition. `<input type="file" accept="image/*">` has worked since iOS 6 and reaches
 * the photo library, so the pipeline can be exercised regardless. The descriptor path is
 * identical either way; only the source of the pixels differs.
 */
import { fmtDate, nowInstantIso, nowIstClock } from "@/lib/datetime";
import {
  DESCRIPTOR_INPUT_SIZE,
  faceBackend,
  loadFaceModels,
  readFrame,
} from "@/features/kiosk/lib/facePipeline";

type State = "pass" | "fail" | "warn";

/** The reporting surface the inline script set up. */
interface CheckApi {
  add: (table: string, label: string, state: State, value: string, note?: string) => void;
  rows: { label: string; state: State; value: string }[];
  hasGUM: boolean;
  nativeShell: boolean;
  gl: boolean;
  iosMajor: number;
}

const api = (window as unknown as { TTCheck: CheckApi }).TTCheck;

const el = (id: string) => document.getElementById(id);

function log(line: string): void {
  const box = el("face-log") as HTMLPreElement | null;
  if (box === null) return;
  box.hidden = false;
  box.textContent = `${box.textContent ?? ""}${line}\n`;
}

function summarise(): void {
  const box = el("summary");
  if (box === null) return;
  const lines = api.rows.map((r) => {
    const mark = r.state === "pass" ? "OK  " : r.state === "warn" ? "note" : "FAIL";
    return `${mark}  ${r.label}: ${r.value}`;
  });
  // `nowInstantIso()` rather than the Date constructor, which this repo's lint rule bans so
  // that every clock in the product reads IST. A self-test stamped in the tablet's own zone
  // would be one more thing to reconcile when comparing it against a punch record.
  const now = nowInstantIso();
  box.textContent = [
    "TT Gate self-test",
    `${fmtDate(now)} ${nowIstClock(now)} IST`,
    navigator.userAgent,
    "",
    ...lines,
  ].join("\n");
}

function verdict(html: string): void {
  const box = el("verdict");
  if (box !== null) box.innerHTML = html;
}

/**
 * Load the recognition models and report how long it took.
 *
 * The duration is worth printing rather than just pass/fail: 6.4 MB over a slow connection is
 * a minute of a blank-looking gate, and an installer who knows that is expected will not
 * conclude the terminal is broken and power-cycle it halfway through.
 */
async function testModels(): Promise<boolean> {
  const started = performance.now();
  try {
    await loadFaceModels();
    const ms = Math.round(performance.now() - started);
    api.add("t-face", "Recognition models", "pass", `loaded in ${(ms / 1000).toFixed(1)}s`);
    const backend = faceBackend();
    api.add(
      "t-face",
      "Compute backend",
      backend === "webgl" ? "pass" : "warn",
      backend ?? "unknown",
      backend === "webgl"
        ? "Graphics-accelerated, which is what makes a scan quick."
        : "Running on the processor. Recognition will work but each scan takes seconds.",
    );
    return true;
  } catch (error) {
    api.add(
      "t-face",
      "Recognition models",
      "fail",
      "did not load",
      "This is the one that decides whether this device can be used at all.",
    );
    log(`model load failed: ${String(error)}`);
    return false;
  }
}

/**
 * Run the pipeline over one image and report whether a descriptor came out.
 *
 * The check on the descriptor is not decoration. A pipeline can return a "reading" with a
 * malformed vector — a wrong dimension, or NaNs from a backend that half-works — and that
 * would match nobody while looking like success. 128 finite numbers is the contract every
 * enrolled template was built to.
 */
async function testDescriptor(source: HTMLCanvasElement): Promise<void> {
  const started = performance.now();
  try {
    const verdictResult = await readFrame(source, {
      inputSize: DESCRIPTOR_INPUT_SIZE,
      singlePass: true,
    });
    const ms = Math.round(performance.now() - started);

    if (verdictResult.kind !== "ok") {
      api.add(
        "t-face",
        "Face found in the image",
        "warn",
        verdictResult.kind.replace(/_/g, " "),
        "The engine ran, which is the important part. Try a clearer, closer, better-lit face.",
      );
      log(`readFrame verdict: ${JSON.stringify(verdictResult)}`);
      summarise();
      return;
    }

    const descriptor = verdictResult.reading.descriptor;
    const finite = descriptor.every((n) => Number.isFinite(n));
    const wellFormed = descriptor.length === 128 && finite;

    api.add("t-face", "Face found in the image", "pass", `yes, in ${ms} ms`);
    api.add(
      "t-face",
      "Face signature",
      wellFormed ? "pass" : "fail",
      wellFormed ? "128 numbers, valid" : `${descriptor.length} values, ${finite ? "valid" : "contains errors"}`,
      wellFormed
        ? "This device produces the same kind of signature employees were enrolled with."
        : "The signature is malformed — it would match nobody. Send this result to IT.",
    );

    if (wellFormed) {
      verdict(
        "<strong class='pass'>This device can run the gate.</strong> Recognition works and " +
          "produces a valid signature. Check the camera section above as well.",
      );
    }
    summarise();
  } catch (error) {
    api.add(
      "t-face",
      "Recognition run",
      "fail",
      "crashed",
      "The engine loaded but could not process an image on this browser.",
    );
    log(`readFrame threw: ${String(error)}`);
    summarise();
  }
}

/** Draw any image-ish source onto a canvas the pipeline can read. */
function toCanvas(image: HTMLImageElement | HTMLVideoElement, width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")?.drawImage(image, 0, 0, width, height);
  return canvas;
}

function offerPhoto(): void {
  const actions = el("face-actions");
  if (actions === null) return;

  const label = document.createElement("label");
  label.className = "filebtn";
  label.textContent = "Test with a photo of a face";
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/*";
  label.appendChild(input);
  actions.appendChild(label);

  input.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file === undefined) return;
    label.textContent = "Working…";
    const reader = new FileReader();
    reader.onload = () => {
      const image = new Image();
      image.onload = () => {
        // Cap the long edge: a 12-megapixel photo would spend seconds being decoded on this
        // hardware for no gain — the detector works from a much smaller frame.
        const scale = Math.min(1, 1280 / Math.max(image.width, image.height));
        const canvas = toCanvas(
          image,
          Math.round(image.width * scale),
          Math.round(image.height * scale),
        );
        label.textContent = "Test another photo";
        void testDescriptor(canvas);
      };
      image.onerror = () => {
        label.textContent = "That image could not be read";
      };
      image.src = String(reader.result);
    };
    reader.readAsDataURL(file);
  });
}

function offerCamera(): void {
  const actions = el("face-actions");
  if (actions === null || !api.hasGUM) return;

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Test with the camera";
  actions.appendChild(button);

  button.addEventListener("click", () => {
    button.disabled = true;
    button.textContent = "Opening camera…";
    void navigator.mediaDevices
      .getUserMedia({ video: { facingMode: "user", width: 1280, height: 720 } })
      .then(async (stream) => {
        api.add("t-camera", "Camera opened", "pass", "yes");
        const video = document.createElement("video");
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        video.srcObject = stream;
        (el("face-actions") as HTMLElement).appendChild(video);
        await video.play().catch(() => undefined);

        // Give the stream a moment to deliver real frames; the first are often black.
        await new Promise((resolve) => window.setTimeout(resolve, 1200));
        button.textContent = "Test again";
        button.disabled = false;

        const canvas = toCanvas(video, video.videoWidth || 1280, video.videoHeight || 720);
        await testDescriptor(canvas);
        for (const track of stream.getTracks()) track.stop();
      })
      .catch((error: unknown) => {
        api.add(
          "t-camera",
          "Camera opened",
          "fail",
          "refused",
          "Permission denied, or no camera available to this browser.",
        );
        log(`getUserMedia failed: ${String(error)}`);
        button.textContent = "Camera unavailable";
        summarise();
      });
  });
}

async function run(): Promise<void> {
  summarise();

  if (!api.hasGUM && !api.nativeShell) {
    api.add(
      "t-camera",
      "Camera opened",
      "warn",
      "cannot try",
      api.iosMajor > 0 && api.iosMajor < 13
        ? "Open this in a Safari TAB rather than from the Home Screen, or install the TT Gate app."
        : "This browser exposes no camera API.",
    );
  }

  verdict("Loading the recognition models — about 6 MB. This can take a minute.");
  const ok = await testModels();
  summarise();

  if (!ok) {
    verdict(
      "<strong class='fail'>This device cannot run the gate.</strong> The recognition engine " +
        "would not load, and a native app would not help — it uses the same engine. This " +
        "hardware needs replacing.",
    );
    return;
  }

  verdict(
    "Engine loaded. Now run one of the tests below — that is what confirms recognition " +
      "actually works on this device.",
  );
  offerCamera();
  offerPhoto();
}

void run();
