//
//  CameraController.swift
//  TT Gate — the camera the web layer cannot open for itself.
//
//  WHY THIS FILE IS THE REASON THE APP EXISTS
//  ------------------------------------------
//  iOS 12 has no `getUserMedia` anywhere except Safari proper. Not in WKWebView (which
//  gained it in 14.3), not in a home-screen web app. On the iPad Air 1 and mini 2/3 — the
//  generation whose final OS is 12.5.7 — there is no browser API that reaches a camera. So
//  the camera lives here, in native code, and the web layer asks for frames.
//
//  WHAT THIS FILE DOES NOT DO
//  --------------------------
//  It does not detect or recognise faces, and it must never start. The enrolled templates
//  are 128-D ResNet-34 descriptors produced by face-api.js from a landmark-aligned crop.
//  Vision's face features live in a different vector space entirely and would match nobody.
//  This class hands over PIXELS; the descriptor is computed by the same JavaScript that
//  enrolled every employee.
//
//  MIRRORING: THE ONE DETAIL THAT WOULD SILENTLY BREAK MATCHING
//  -----------------------------------------------------------
//  The web viewfinder mirrors the front camera in CSS so people see themselves the right way
//  round. CSS mirroring is a PAINT effect — face-api reads the unmirrored element, so every
//  enrolled descriptor came from unmirrored pixels. Therefore the preview layer here may be
//  mirrored for the human, but `grabFrame` must return the frame UNMIRRORED. Getting this
//  backwards does not throw; it quietly halves recognition and looks like bad lighting.
//

import AVFoundation
import UIKit

final class CameraController: NSObject {

    enum Facing: String {
        case front
        case back

        var position: AVCaptureDevice.Position {
            return self == .front ? .front : .back
        }
    }

    /// Longest edge of a delivered frame, in pixels.
    ///
    /// The browser path runs on a 1280×720 stream and the descriptor's quality depends on how
    /// many pixels the FACE occupies, so this is not a place to economise for bridge traffic.
    /// 720 keeps parity with the web pipeline; the JPEG below is what keeps the payload sane.
    private static let maxEdge: CGFloat = 720

    /// JPEG quality for a delivered frame.
    ///
    /// 0.85, not 0.6. The descriptor is computed from these pixels, and compression artefacts
    /// around the eyes and mouth move the vector. Bandwidth here is a local function call, not
    /// a network — there is nothing to buy by degrading the input to recognition.
    private static let jpegQuality: CGFloat = 0.85

    private let session = AVCaptureSession()
    private let output = AVCaptureVideoDataOutput()
    private let sampleQueue = DispatchQueue(label: "tt.gate.camera.samples")

    /// The most recent frame, and nothing older.
    ///
    /// A queue would let the web layer receive a face that has already walked away. One slot,
    /// overwritten, means a grab always answers with what the camera can see now.
    private var latest: CVPixelBuffer?
    private let latestLock = NSLock()

    private(set) var facing: Facing = .back
    private lazy var ciContext = CIContext(options: [.useSoftwareRenderer: false])

    /// The interface orientation, pushed in from the main thread by the view controller.
    ///
    /// Cached rather than read on demand because the only place it is needed — `grabFrame` —
    /// runs off the main thread, where UIKit may not be touched at all.
    private var interfaceOrientation: UIInterfaceOrientation = .portrait
    private let orientationLock = NSLock()

    /// Call from the main thread whenever the layout changes.
    func setInterfaceOrientation(_ orientation: UIInterfaceOrientation) {
        orientationLock.lock()
        interfaceOrientation = orientation
        orientationLock.unlock()
    }

    // MARK: - Preview

    /// The layer that shows the camera to the person at the gate.
    ///
    /// Added BEHIND the web view by `GateViewController`, which is why the web page's
    /// viewfinder must be transparent rather than merely empty.
    let previewLayer: AVCaptureVideoPreviewLayer

    override init() {
        previewLayer = AVCaptureVideoPreviewLayer(session: session)
        previewLayer.videoGravity = .resizeAspectFill
        super.init()
        output.setSampleBufferDelegate(self, queue: sampleQueue)
        // Dropping is correct: this class only ever needs the newest frame, and holding
        // buffers to avoid a drop is how a capture session runs the device out of memory.
        output.alwaysDiscardsLateVideoFrames = true
        output.videoSettings = [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
        ]
    }

    // MARK: - Permission

    static func authorisation() -> AVAuthorizationStatus {
        return AVCaptureDevice.authorizationStatus(for: .video)
    }

    /// Ask once, and report what the person chose.
    ///
    /// `.notDetermined` is the only state that prompts. Anything else is already decided and
    /// re-asking would do nothing, so the answer is returned immediately.
    static func requestAccess(_ completion: @escaping (Bool) -> Void) {
        switch authorisation() {
        case .authorized:
            completion(true)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async { completion(granted) }
            }
        case .denied, .restricted:
            completion(false)
        @unknown default:
            completion(false)
        }
    }

    // MARK: - Session

    func start(facing: Facing, completion: @escaping (Bool) -> Void) {
        CameraController.requestAccess { [weak self] granted in
            guard let self = self, granted else {
                completion(false)
                return
            }
            self.facing = facing
            // Off the main thread: configuring and starting a session blocks, and doing it on
            // the main thread stalls the web view mid-load on this hardware.
            DispatchQueue.global(qos: .userInitiated).async {
                let ok = self.configure(facing: facing)
                if ok, !self.session.isRunning { self.session.startRunning() }
                DispatchQueue.main.async { completion(ok) }
            }
        }
    }

    func stop() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self, self.session.isRunning else { return }
            self.session.stopRunning()
            self.latestLock.lock()
            self.latest = nil
            self.latestLock.unlock()
        }
    }

    private func configure(facing: Facing) -> Bool {
        session.beginConfiguration()
        defer { session.commitConfiguration() }

        // 1280×720 to match the browser pipeline's stream. `.high` would vary by device and
        // change the face's pixel size from one iPad to the next.
        session.sessionPreset = .hd1280x720

        for input in session.inputs { session.removeInput(input) }

        guard let device = AVCaptureDevice.default(
            .builtInWideAngleCamera, for: .video, position: facing.position
        ) ?? AVCaptureDevice.default(for: .video) else {
            return false
        }

        guard let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input) else {
            return false
        }
        session.addInput(input)

        if !session.outputs.contains(output), session.canAddOutput(output) {
            session.addOutput(output)
        }

        // The HUMAN sees a mirror on the front camera, matching what the web viewfinder does
        // in CSS. The FRAME handed to JavaScript is never mirrored — see the file header.
        if let connection = previewLayer.connection, connection.isVideoMirroringSupported {
            connection.automaticallyAdjustsVideoMirroring = false
            connection.isVideoMirrored = (facing == .front)
        }
        return true
    }

    // MARK: - Frames

    /// The newest frame as a JPEG data URL, or nil if there is not one yet.
    ///
    /// Synchronous and cheap enough to call from the message handler: one lock, one CIImage,
    /// one JPEG. Runs off the main thread by virtue of where it is called.
    func grabFrame() -> (dataURL: String, width: Int, height: Int)? {
        latestLock.lock()
        let buffer = latest
        latestLock.unlock()
        guard let pixelBuffer = buffer else { return nil }

        var image = CIImage(cvPixelBuffer: pixelBuffer)

        // Orient the pixels the way the person is actually standing. A frame delivered
        // sideways is a face the detector will not find at all.
        let rotation = orientationTransform()
        if rotation != .identity { image = image.transformed(by: rotation) }

        let extent = image.extent
        guard extent.width > 0, extent.height > 0 else { return nil }

        let longest = max(extent.width, extent.height)
        let scale = longest > CameraController.maxEdge ? CameraController.maxEdge / longest : 1
        if scale != 1 {
            image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        }

        let target = image.extent
        guard let cgImage = ciContext.createCGImage(image, from: target) else { return nil }
        let uiImage = UIImage(cgImage: cgImage)
        guard let jpeg = uiImage.jpegData(compressionQuality: CameraController.jpegQuality) else {
            return nil
        }
        return (
            "data:image/jpeg;base64," + jpeg.base64EncodedString(),
            Int(target.width),
            Int(target.height)
        )
    }

    /// Rotate the buffer to upright for the device's current orientation.
    ///
    /// The gate is wall-mounted and will not rotate in service, but it is held in a hand
    /// during installation and testing — and a tester seeing "no face" because the frame is
    /// on its side would reasonably conclude the recognition is broken.
    ///
    /// Reads the CACHED orientation, never `UIApplication.shared`. `grabFrame` runs on a
    /// background queue so the JPEG encode does not stutter the preview, and touching UIKit
    /// from off the main thread is undefined behaviour — it warns under the main-thread
    /// checker and can deadlock. The view controller pushes the value in instead.
    private func orientationTransform() -> CGAffineTransform {
        orientationLock.lock()
        let current = interfaceOrientation
        orientationLock.unlock()

        switch current {
        case .landscapeLeft:
            return CGAffineTransform(rotationAngle: .pi / 2)
        case .landscapeRight:
            return CGAffineTransform(rotationAngle: -.pi / 2)
        case .portraitUpsideDown:
            return CGAffineTransform(rotationAngle: .pi)
        default:
            return .identity
        }
    }
}

extension CameraController: AVCaptureVideoDataOutputSampleBufferDelegate {
    func captureOutput(
        _ output: AVCaptureOutput,
        didOutput sampleBuffer: CMSampleBuffer,
        from connection: AVCaptureConnection
    ) {
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        latestLock.lock()
        latest = pixelBuffer
        latestLock.unlock()
    }
}
