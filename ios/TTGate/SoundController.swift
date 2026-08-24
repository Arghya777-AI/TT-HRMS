//
//  SoundController.swift
//  TT Gate — the attendance chime, played natively.
//
//  WHY NATIVE AND NOT WEB AUDIO
//  ---------------------------
//  WKWebView inherits Safari's autoplay rule: no sound until the page has been interacted
//  with. A wall-mounted gate is interacted with by nobody — the person who walks up is
//  recognised without touching it — so Web Audio inside the shell would be reliably mute
//  until somebody remembered to tap the screen. Native audio has no such rule.
//
//  It also fixes something the web layer cannot reach at all: the audio session category.
//  With `.playback` the chime is heard even when the iPad has been muted from Control Centre,
//  which on a device left on a wall for a month it eventually will be. A gate that silently
//  stopped confirming arrivals because somebody swiped a mute toggle is a support call nobody
//  would ever diagnose.
//
//  WHY THE TONES ARE SYNTHESISED
//  ----------------------------
//  Same reason as the web version: no asset to ship, to version, or to have go missing. The
//  frequencies and envelopes here MIRROR `src/shared/audio/chime.ts` deliberately — a person
//  who learns what the gate sounds like in Safari must hear the same thing in the app, or the
//  sound stops being information and becomes noise.
//

import AVFoundation

final class SoundController {

    /// One voice: a list of notes, each with a start offset, duration and level.
    private struct Note {
        let freq: Double
        let at: Double
        let dur: Double
        let gain: Double
        /// True for a square wave. See the note on the error voice for why it exists.
        let square: Bool

        init(freq: Double, at: Double, dur: Double, gain: Double, square: Bool = false) {
            self.freq = freq
            self.at = at
            self.dur = dur
            self.gain = gain
            self.square = square
        }
    }

    /// Mirrors `VOICES` in chime.ts, note for note. Keep the two in step — a person who learns
    /// what the gate sounds like in Safari must hear the same thing in the app.
    private static let voices: [String: [Note]] = [
        // Two rising notes. Reads as "done".
        "recorded": [
            Note(freq: 880, at: 0, dur: 0.09, gain: 0.9),
            Note(freq: 1320, at: 0.085, dur: 0.15, gain: 0.9)
        ],
        // One flat note: nothing was written, and it must not sound like a second success.
        "duplicate": [
            Note(freq: 880, at: 0, dur: 0.16, gain: 0.7)
        ],
        // Rising, then a softer third note that says "not finished yet".
        "queued": [
            Note(freq: 780, at: 0, dur: 0.09, gain: 0.85),
            Note(freq: 1170, at: 0.085, dur: 0.1, gain: 0.85),
            Note(freq: 980, at: 0.2, dur: 0.14, gain: 0.6)
        ],
        /*
          A PULSED TWO-TONE ALARM. Mirrors chime.ts, including the reasoning.

          The earlier version fell to 330 Hz on sine waves and was too weak to notice. That was
          never a gain problem: a tablet speaker has essentially no output below ~500 Hz, so the
          falling notes walked the sound out of the band the hardware can reproduce. This stays
          in 700–1000 Hz where a small speaker is most efficient, uses square waves for their
          much greater perceived loudness, and pulses four times — an interrupted sound holds
          attention where a steady one becomes background.
        */
        "error": [
            Note(freq: 990, at: 0, dur: 0.12, gain: 1.0, square: true),
            Note(freq: 740, at: 0.15, dur: 0.12, gain: 1.0, square: true),
            Note(freq: 990, at: 0.3, dur: 0.12, gain: 1.0, square: true),
            Note(freq: 740, at: 0.45, dur: 0.16, gain: 1.0, square: true)
        ]
    ]

    private static let sampleRate = 44100.0

    /// Full scale, matching `VOLUME` in chime.ts.
    ///
    /// Worth stating: this is full scale within the DEVICE's own volume. No app can raise an
    /// iPad's system volume — iOS does not permit it — so a terminal with its hardware volume
    /// down stays quiet, and that is a physical control to set once when mounting it.
    private static let volume: Double = 1.0

    /// Rendered once per voice and kept.
    ///
    /// A gate plays these hundreds of times a day; re-synthesising 16 KB of PCM on every punch
    /// would be pointless work on a scan's critical path.
    private var players: [String: AVAudioPlayer] = [:]
    private var sessionReady = false

    /// One synthesiser, reused.
    ///
    /// `AVSpeechSynthesizer` must outlive the utterance it is speaking — a local one is
    /// deallocated the moment the function returns and the speech is cut off mid-word, which is
    /// the classic way this API appears to "not work".
    private let speaker = AVSpeechSynthesizer()

    // MARK: - Session

    /// Put the app in the playback category so the chime survives a muted device.
    ///
    /// Done lazily, on the first sound, rather than at launch: activating an audio session the
    /// app may never use is the sort of thing that shows up as an unexplained interruption of
    /// whatever else the device was doing.
    private func prepareSession() {
        guard !sessionReady else { return }
        sessionReady = true
        let session = AVAudioSession.sharedInstance()
        do {
            // `.playback` is what ignores the mute switch. `.mixWithOthers` so the gate is not
            // the reason somebody's music stops — it is a 250 ms beep, not a media app.
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try session.setActive(true)
        } catch {
            // A gate that could not configure audio must still record attendance. The screen
            // is the confirmation that matters; this is the courtesy on top of it.
        }
    }

    // MARK: - Playing

    func play(kind: String) {
        prepareSession()
        guard let player = player(for: kind) else { return }
        // Rewind rather than allocate: two people scanning within a second must both be heard.
        player.currentTime = 0
        player.play()
    }

    private func player(for kind: String) -> AVAudioPlayer? {
        if let existing = players[kind] { return existing }
        guard let notes = SoundController.voices[kind],
              let data = SoundController.renderWAV(notes: notes),
              let player = try? AVAudioPlayer(data: data) else {
            return nil
        }
        player.volume = 1.0
        player.prepareToPlay()
        players[kind] = player
        return player
    }

    // MARK: - Speech

    /// Say a line, at full volume, cancelling anything still being said.
    ///
    /// Cancelling matters at a gate: at shift change somebody arrives every two or three
    /// seconds, and queued utterances would fall further behind until the terminal was
    /// announcing arrivals from a minute ago — confidently wrong about who just walked through,
    /// which is worse than saying nothing.
    func speak(text: String) {
        guard !text.isEmpty else { return }
        prepareSession()
        if speaker.isSpeaking {
            speaker.stopSpeaking(at: .immediate)
        }
        let utterance = AVSpeechUtterance(string: text)
        // en-IN when the device has it; AVSpeechSynthesisVoice returns nil rather than throwing
        // if it does not, and a nil voice means "use the system default", which is correct.
        utterance.voice = AVSpeechSynthesisVoice(language: "en-IN")
            ?? AVSpeechSynthesisVoice(language: "en-GB")
            ?? AVSpeechSynthesisVoice(language: "en-US")
        utterance.volume = 1.0
        // Slightly under default. Heard once, in a foyer, by somebody already walking — the
        // difference between "inwards" and "outwards" is the only word that matters.
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 0.95
        speaker.speak(utterance)
    }

    // MARK: - Synthesis

    /// Render the notes to a 16-bit mono WAV in memory.
    ///
    /// `AVAudioPlayer(data:)` needs a container, not raw samples, so the 44-byte RIFF header is
    /// written by hand. That is cheaper than pulling in AVAudioEngine to schedule a buffer, and
    /// it keeps this file dependency-free.
    private static func renderWAV(notes: [Note]) -> Data? {
        guard let last = notes.map({ $0.at + $0.dur }).max() else { return nil }
        let total = last + 0.05
        let frames = Int(total * sampleRate)
        guard frames > 0 else { return nil }

        var samples = [Double](repeating: 0, count: frames)
        for note in notes {
            let start = Int(note.at * sampleRate)
            let length = Int(note.dur * sampleRate)
            guard length > 0 else { continue }
            for i in 0..<length {
                let index = start + i
                guard index < frames else { break }
                let t = Double(i) / sampleRate

                /*
                  An envelope, not a bare on/off. Starting or stopping a non-zero amplitude
                  instantly puts a step in the waveform, and on a small speaker that click is
                  louder than the note itself. 8 ms in, then a smooth decay to silence.
                */
                let attack = 0.008
                let envelope: Double
                if t < attack {
                    envelope = t / attack
                } else {
                    let remaining = (note.dur - t) / max(note.dur - attack, 0.0001)
                    envelope = max(0, remaining)
                }
                /*
                  Square by sign of the sine, for the failure tone only. A naive square is full
                  of aliasing at these frequencies, and for an alarm that is a feature — the
                  extra harmonic content is exactly what makes it carry.
                */
                let phase = sin(2 * Double.pi * note.freq * t)
                let value = note.square ? (phase >= 0 ? 1.0 : -1.0) : phase
                samples[index] += value * envelope * note.gain * volume
            }
        }

        var pcm = Data(capacity: frames * 2)
        for sample in samples {
            // Clamp before converting: overlapping notes can sum past 1.0, and wrapping an
            // Int16 turns that into a loud crack rather than a quiet clip.
            let clamped = max(-1.0, min(1.0, sample))
            var value = Int16(clamped * 32767)
            withUnsafeBytes(of: &value) { pcm.append(contentsOf: $0) }
        }

        return wavContainer(pcm: pcm)
    }

    /// A minimal 44-byte canonical WAV header followed by the samples.
    private static func wavContainer(pcm: Data) -> Data {
        let channels: UInt16 = 1
        let bitsPerSample: UInt16 = 16
        let byteRate = UInt32(sampleRate) * UInt32(channels) * UInt32(bitsPerSample / 8)
        let blockAlign = channels * (bitsPerSample / 8)

        var out = Data()
        func ascii(_ s: String) { out.append(contentsOf: Array(s.utf8)) }
        func u32(_ v: UInt32) { var x = v.littleEndian; withUnsafeBytes(of: &x) { out.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { var x = v.littleEndian; withUnsafeBytes(of: &x) { out.append(contentsOf: $0) } }

        ascii("RIFF")
        u32(UInt32(36 + pcm.count))
        ascii("WAVE")
        ascii("fmt ")
        u32(16)                       // PCM header length
        u16(1)                        // format: PCM
        u16(channels)
        u32(UInt32(sampleRate))
        u32(byteRate)
        u16(blockAlign)
        u16(bitsPerSample)
        ascii("data")
        u32(UInt32(pcm.count))
        out.append(pcm)
        return out
    }
}
