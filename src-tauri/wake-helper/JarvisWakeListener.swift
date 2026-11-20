import AppKit
import AVFoundation
import Foundation
import Speech

final class WakeListener {
    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let audioEngine = AVAudioEngine()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var hasWoken = false
    private let audioLock = NSLock()
    private var firstAudioBufferReceived = false
    private var audioSignalReported = false
    private var lastAudioBufferAt = Date()
    private let eventFile: URL?
    private let hostApp: URL?
    private let assistantName: String
    private var acronymWords: [String]? {
        guard assistantName.count <= 5, assistantName == assistantName.uppercased() else { return nil }
        let sounds: [Character: String] = [
            "A": "ay", "B": "bee", "C": "see", "D": "dee", "E": "ee", "F": "eff",
            "G": "gee", "H": "aitch", "I": "eye", "J": "jay", "K": "kay", "L": "ell",
            "M": "em", "N": "en", "O": "oh", "P": "pee", "Q": "cue", "R": "ar",
            "S": "ess", "T": "tee", "U": "you", "V": "vee", "W": "double you",
            "X": "ex", "Y": "why", "Z": "zee",
        ]
        return assistantName.map { sounds[$0] ?? String($0) }
    }
    private var phrases: [String] {
        var names = [normalize(assistantName)]
        if let acronymWords {
            var variants = [""]
            for (letter, sound) in zip(assistantName, acronymWords) {
                let forms = [String(letter).lowercased(), normalize(sound)]
                variants = variants.flatMap { prefix in forms.map { prefix + $0 } }
            }
            names = Array(Set(names + variants))
        }
        return names.flatMap { ["hi\($0)", "hey\($0)"] }
    }
    private var contextualPhrases: [String] {
        var names = [assistantName]
        if let acronymWords {
            names.append(assistantName.map(String.init).joined(separator: " "))
            names.append(acronymWords.joined(separator: " "))
        }
        return names.flatMap { ["Hey \($0)", "Hi \($0)"] }
    }

    init() {
        if
            let index = CommandLine.arguments.firstIndex(of: "--assistant-name"),
            CommandLine.arguments.indices.contains(index + 1)
        {
            assistantName = CommandLine.arguments[index + 1]
        } else {
            assistantName = "Mark"
        }
        if
            let index = CommandLine.arguments.firstIndex(of: "--event-file"),
            CommandLine.arguments.indices.contains(index + 1)
        {
            eventFile = URL(fileURLWithPath: CommandLine.arguments[index + 1])
        } else {
            eventFile = nil
        }
        if
            let index = CommandLine.arguments.firstIndex(of: "--host-app"),
            CommandLine.arguments.indices.contains(index + 1)
        {
            hostApp = URL(fileURLWithPath: CommandLine.arguments[index + 1])
        } else {
            hostApp = nil
        }
    }

    func run() {
        emit(["type": "boot"])
        if
            let index = CommandLine.arguments.firstIndex(of: "--test-phrase"),
            CommandLine.arguments.indices.contains(index + 1)
        {
            emit([
                "type": "phrase-test",
                "matched": matchesWakePhrase(CommandLine.arguments[index + 1]) ? "true" : "false",
            ])
            return
        }
        if CommandLine.arguments.contains("--test-wake") {
            emit(["type": "wake", "phrase": "automated cold-launch test"])
            openHostApp()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.75) {
                exit(0)
            }
            RunLoop.main.run()
            return
        }

        guard let recognizer, recognizer.isAvailable else {
            emit(["type": "error", "message": "speech recognizer unavailable"])
            exit(2)
        }

        let currentAuthorization = SFSpeechRecognizer.authorizationStatus()
        emit([
            "type": "authorization",
            "status": authorizationName(currentAuthorization),
        ])
        if currentAuthorization == .authorized {
            ensureMicrophoneAuthorization()
            RunLoop.main.run()
            return
        }

        SFSpeechRecognizer.requestAuthorization { [weak self] status in
            DispatchQueue.main.async {
                guard let self else { return }
                guard status == .authorized else {
                    self.emit([
                        "type": "authorization",
                        "status": self.authorizationName(status),
                    ])
                    exit(3)
                }
                self.emit(["type": "authorization", "status": "authorized"])
                self.ensureMicrophoneAuthorization()
            }
        }

        RunLoop.main.run()
    }

    private func ensureMicrophoneAuthorization() {
        let status = AVCaptureDevice.authorizationStatus(for: .audio)
        emit(["type": "microphone-authorization", "status": microphoneAuthorizationName(status)])
        switch status {
        case .authorized:
            startRecognition()
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .audio) { [weak self] granted in
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.emit(["type": "microphone-authorization", "status": granted ? "authorized" : "denied"])
                    if granted { self.startRecognition() }
                    else { exit(8) }
                }
            }
        case .denied, .restricted:
            exit(8)
        @unknown default:
            exit(8)
        }
    }

    private func startRecognition() {
        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            emit(["type": "error", "message": "microphone input unavailable"])
            exit(4)
        }

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.contextualStrings = contextualPhrases
        guard recognizer?.supportsOnDeviceRecognition == true else {
            emit(["type": "error", "message": "on-device speech recognition unavailable"])
            exit(7)
        }
        request.requiresOnDeviceRecognition = true
        if #available(macOS 13.0, *) {
            request.addsPunctuation = false
        }
        self.request = request
        audioLock.lock()
        lastAudioBufferAt = Date()
        audioLock.unlock()

        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
            request.append(buffer)
            guard let self else { return }
            let signal = buffer.floatChannelData.map { samples in
                (0..<Int(min(buffer.frameLength, 256))).contains { abs(samples[0][$0]) > 0.001 }
            } ?? false
            self.audioLock.lock()
            let first = !self.firstAudioBufferReceived
            self.firstAudioBufferReceived = true
            self.lastAudioBufferAt = Date()
            let firstSignal = signal && !self.audioSignalReported
            if firstSignal { self.audioSignalReported = true }
            self.audioLock.unlock()
            if first {
                DispatchQueue.main.async { [weak self] in self?.emit(["type": "ready"]) }
            }
            if firstSignal {
                DispatchQueue.main.async { [weak self] in self?.emit(["type": "audio-signal"]) }
            }
        }

        do {
            audioEngine.prepare()
            try audioEngine.start()
        } catch {
            emit(["type": "error", "message": "microphone start failed"])
            exit(5)
        }

        task = recognizer?.recognitionTask(with: request) { [weak self] result, error in
            guard let self, !self.hasWoken else { return }
            if let result {
                if self.matchesWakePhrase(result.bestTranscription.formattedString) {
                    self.hasWoken = true
                    self.emit([
                        "type": "wake",
                        "phrase": result.bestTranscription.formattedString,
                    ])
                    self.stop()
                    self.openHostApp()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.75) {
                        exit(0)
                    }
                    return
                }
                if result.isFinal {
                    self.emit(["type": "error", "message": "speech recognition ended; restarting"])
                    self.stop()
                    exit(6)
                }
            }
            if error != nil {
                self.emit(["type": "error", "message": "speech recognition interrupted"])
                self.stop()
                exit(6)
            }
        }
        checkRecognitionTask()
    }

    private func checkRecognitionTask() {
        guard !hasWoken else { return }
        audioLock.lock()
        let stalled = Date().timeIntervalSince(lastAudioBufferAt) > 5
        audioLock.unlock()
        if !audioEngine.isRunning || stalled {
            emit(["type": "error", "message": "microphone input stopped; restarting"])
            stop()
            exit(5)
        }
        if let task, task.state == .completed || task.state == .finishing || task.state == .canceling {
            emit(["type": "error", "message": "speech recognition stopped; restarting"])
            stop()
            exit(6)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [weak self] in
            self?.checkRecognitionTask()
        }
    }

    private func stop() {
        if audioEngine.isRunning {
            audioEngine.stop()
        }
        audioEngine.inputNode.removeTap(onBus: 0)
        request?.endAudio()
        task?.cancel()
    }

    private func openHostApp() {
        guard let hostApp else { return }
        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        configuration.arguments = ["--jarvis-wake"]
        NSWorkspace.shared.openApplication(
            at: hostApp,
            configuration: configuration
        ) { [weak self] _, error in
            if let error {
                self?.emit([
                    "type": "error",
                    "message": "could not open Mark Codex: \(error.localizedDescription)",
                ])
            }
        }
    }

    private func normalize(_ value: String) -> String {
        value
            .lowercased()
            .replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: ",", with: "")
            .replacingOccurrences(of: ".", with: "")
            .replacingOccurrences(of: "!", with: "")
    }

    private func matchesWakePhrase(_ transcription: String) -> Bool {
        let spoken = normalize(transcription)
        return phrases.contains(where: spoken.contains)
    }

    private func authorizationName(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "unknown"
        }
    }

    private func microphoneAuthorizationName(_ status: AVAuthorizationStatus) -> String {
        switch status {
        case .authorized: return "authorized"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "unknown"
        }
    }

    private func emit(_ value: [String: String]) {
        guard
            let data = try? JSONSerialization.data(withJSONObject: value),
            let line = String(data: data, encoding: .utf8)
        else { return }
        if let eventFile {
            let data = Data((line + "\n").utf8)
            if let handle = try? FileHandle(forWritingTo: eventFile) {
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: data)
                try? handle.close()
            } else {
                try? data.write(to: eventFile, options: .atomic)
            }
        } else {
            print(line)
            fflush(stdout)
        }
    }
}

let listener = WakeListener()
listener.run()
