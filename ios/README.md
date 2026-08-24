# TT Gate — iOS shell

A native wrapper around the gate terminal at `https://tt-hrms.vercel.app/kiosk`.

## Why it exists

One reason. **iOS 12 has no `getUserMedia` outside Safari** — not in `WKWebView` (which
gained it in 14.3), and not in a Home Screen web app. On the iPad Air 1 and mini 2/3, whose
final OS is 12.5.7, there is no browser API that reaches a camera. So the camera lives in
native code and the web layer asks it for frames.

**On iOS 13.4 or newer this app is unnecessary.** Add the web terminal to the Home Screen
instead: same screen, nothing to install, updates itself. Build this only for the old iPad.

## What it deliberately does not do

It does not recognise faces, and it must never start.

The enrolled templates in `secure.face_templates` are **128-D ResNet-34 descriptors** produced
by face-api.js from a landmark-aligned crop. Apple's Vision framework — or any
reimplementation, or even the same model fed a differently-aligned crop — produces a vector in
a different space and would match **nobody**. This repo already records that changing the
detector input size alone silently breaks matching; a model port is that hazard several times
over, and it fails by quietly degrading rather than by erroring.

So the shell contributes exactly two things a browser on iOS 12 cannot: a camera, and a window
with no URL bar. The descriptor keeps being computed by the same code that enrolled everyone.

## How the pieces fit

```
┌─────────────────────────────┐
│  WKWebView   (transparent)  │  the whole gate UI, loaded from the website
├─────────────────────────────┤
│  AVCaptureVideoPreviewLayer │  the live camera, composited by the GPU
└─────────────────────────────┘
```

The preview sits **behind** the web view, and `Viewfinder.tsx` renders `bg-transparent` with
no `<video>` when it detects the shell. So the pixels a person *looks at* never enter
JavaScript — only the frames *recognition* needs cross the bridge, one at a time, on request.

| Direction | Mechanism |
|---|---|
| Shell announces itself | `WKUserScript` at document start sets `window.TTGateNative` |
| Page → shell | `window.webkit.messageHandlers.ttGate.postMessage({op})` — `startCamera`, `stopCamera`, `grabFrame`, `cameraPermission` |
| Shell → page | `window.__ttGateFrame(dataUrl, w, h)` and `window.__ttGateControl({type, value})` |

The web half is [`src/features/kiosk/lib/nativeBridge.ts`](../src/features/kiosk/lib/nativeBridge.ts)
and [`useNativeCamera.ts`](../src/features/kiosk/hooks/useNativeCamera.ts). Both are inert in a
normal browser, so the web path cannot be broken by them.

`bridgeVersion` in `GateViewController.swift` and `MIN_SHELL_VERSION` in `nativeBridge.ts` move
together. Bump both when the message vocabulary changes.

## Building

Requires **Xcode** (this repo's checkout has only Command Line Tools) and an **Apple Developer
account** for anything that leaves your own desk.

```sh
brew install xcodegen
cd ios && xcodegen generate && open TTGate.xcodeproj
```

Prefer not to install XcodeGen? Create the project by hand — it takes two minutes. The four
settings that matter:

- **iOS Deployment Target `12.0`** — the whole point; anything higher misses the target hardware
- Add the four files in `TTGate/` to the target
- `INFOPLIST_FILE` → `TTGate/Info.plist`
- Bundle identifier `com.tamarindtree.ttgate` — must match `public/app/manifest.plist`

Then set your team under Signing & Capabilities.

> Newer Xcode releases have been raising their minimum deployment target. If yours refuses
> iOS 12, you need an older Xcode — verify this before promising a date.

## Shipping it to the iPad

TestFlight **cannot** be used: the TestFlight app itself needs iOS 14+, so it can never reach a
12.5.7 device. Ad-hoc over-the-air distribution is the route, and the web side is already built.

1. **Register the iPad.** Connect it to a Mac, open Finder, select the iPad, click under its
   name until the UDID appears, copy it, and add it to Devices in the Apple Developer portal.
   Ad-hoc is device-list based — an unregistered iPad refuses with only *"Unable to Install"*.
2. **Archive** in Xcode → Distribute App → **Ad Hoc** → Export.
3. Put the exported `.ipa` at **`public/app/TTGate.ipa`**.
4. Commit and push. Vercel serves it; `https://tt-hrms.vercel.app/app` installs it.

`public/app/manifest.plist` needs no edit if you kept the filename and bundle id. The install
page detects the iOS version and tells the installer whether they need the app at all.

## Testing order

1. **A modern iPhone or iPad first.** The shell path runs there too, and everything except the
   iOS 12 specifics is easier to debug with a working Safari Web Inspector attached.
2. **Then the 12.5.7 iPad.** Watch for: the preview visible through the viewfinder (if it is
   black, a `WKWebView` background is still opaque), a face being detected at all (if not,
   check the frame's rotation), and matches actually landing.

**Unverified, and it needs the device:** whether TensorFlow.js runs at all under Safari 12.1.
It is written defensively — `OffscreenCanvas` and `createImageBitmap` are feature-detected, one
path excludes Safari by name, and the pipeline requests `webgl` and falls back — so WebGL1
should serve. *Should* is not *tested*. If it turns out not to run, this shell does not help:
`WKWebView` uses the same JavaScriptCore as Safari, and the answer would be newer hardware.

## The one detail most likely to break matching silently

Mirroring. The web viewfinder mirrors the front camera in CSS so people see themselves the
right way round — but CSS mirroring is a paint effect, and face-api reads the *unmirrored*
element. Every enrolled descriptor therefore came from unmirrored pixels.

So the preview layer may be mirrored for the human, and `grabFrame` must return the frame
**unmirrored**. Getting it backwards does not throw. It halves recognition and looks like bad
lighting.
