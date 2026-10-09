import AppKit
import Foundation

struct TargetIdentity {
    let pid: pid_t
    let executable: String
    let startSeconds: Int
}

func resolvedPath(_ url: URL) -> String? {
    url.standardizedFileURL.resolvingSymlinksInPath().path
}

func validatedApplication(_ target: TargetIdentity) -> NSRunningApplication? {
    guard target.pid > 0, target.pid != getpid(), let app = NSRunningApplication(processIdentifier: target.pid),
          !app.isTerminated, let executableURL = app.executableURL,
          resolvedPath(executableURL) == resolvedPath(URL(fileURLWithPath: target.executable)),
          let launched = app.launchDate,
          Int(floor(launched.timeIntervalSince1970)) == target.startSeconds else { return nil }
    return app
}

func safeAbsolutePath(_ value: String) -> Bool {
    value.hasPrefix("/") && !value.contains("\0") && !value.contains("\n") && !value.contains("\r")
}

func parseTarget(_ args: [String], mode: String) -> TargetIdentity? {
    guard args.count == 6, args[0] == mode, let pid = Int32(args[1]), pid > 0,
          args[2] == "--target-executable", args[4] == "--target-start-seconds",
          let start = Int(args[5]), start >= 0, args[3].hasPrefix("/"), !args[3].contains("\0") else { return nil }
    return TargetIdentity(pid: pid, executable: args[3], startSeconds: start)
}

func oneShot(_ args: [String]) -> Never {
    guard let mode = args.first, mode == "--focus-pid" || mode == "--quit-pid",
          let target = parseTarget(args, mode: mode), validatedApplication(target) != nil else {
        exit(EXIT_FAILURE)
    }
    guard let app = validatedApplication(target) else { exit(EXIT_FAILURE) }
    let ok = mode == "--focus-pid" ? app.activate(options: [.activateAllWindows]) : app.terminate()
    exit(ok ? EXIT_SUCCESS : EXIT_FAILURE)
}

func openApplicationOneShot(_ args: [String]) -> Never {
    guard args.count == 12, args[0] == "--open-app",
          args[2] == "--home", args[4] == "--desktop-data", args[6] == "--user-home",
          args[8] == "--temporary", args[10] == "--target-executable",
          safeAbsolutePath(args[1]), safeAbsolutePath(args[3]), safeAbsolutePath(args[5]),
          safeAbsolutePath(args[7]), safeAbsolutePath(args[9]), safeAbsolutePath(args[11]) else {
        fputs("Invalid profile launch request.\n", stderr)
        exit(EXIT_FAILURE)
    }

    let appURL = URL(fileURLWithPath: args[1]).standardizedFileURL
    let expectedExecutable = resolvedPath(URL(fileURLWithPath: args[11]))
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.createsNewApplicationInstance = true
    configuration.arguments = ["--user-data-dir=\(args[5])"]
    configuration.environment = [
        "CODEX_HOME": args[3],
        "CODEX_ELECTRON_USER_DATA_PATH": args[5],
        "CODEX_SQLITE_HOME": args[3],
        "HOME": args[7],
        "TMPDIR": args[9]
    ]

    var completed = false
    var launched: NSRunningApplication?
    var failed = false
    NSWorkspace.shared.openApplication(at: appURL, configuration: configuration) { application, error in
        DispatchQueue.main.async {
            launched = application
            failed = error != nil
            completed = true
        }
    }

    let deadline = Date(timeIntervalSinceNow: 15)
    while !completed && Date() < deadline {
        _ = RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
    }
    guard completed, !failed, let application = launched,
          application.processIdentifier > 0, application.processIdentifier != getpid(),
          !application.isTerminated, let executableURL = application.executableURL,
          let actualExecutable = resolvedPath(executableURL),
          let expectedExecutable, actualExecutable == expectedExecutable,
          let launchDate = application.launchDate else {
        fputs("Unable to launch the requested profile instance.\n", stderr)
        exit(EXIT_FAILURE)
    }

    let startSeconds = Int(floor(launchDate.timeIntervalSince1970))
    let target = TargetIdentity(pid: application.processIdentifier, executable: actualExecutable, startSeconds: startSeconds)
    guard let observed = validatedApplication(target), observed.processIdentifier == application.processIdentifier else {
        fputs("Unable to verify the requested profile instance.\n", stderr)
        exit(EXIT_FAILURE)
    }
    let result: [String: Any] = ["pid": target.pid, "executable": target.executable, "startSeconds": target.startSeconds]
    guard let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]),
          let json = String(data: data, encoding: .utf8) else {
        fputs("Unable to report the profile instance identity.\n", stderr)
        exit(EXIT_FAILURE)
    }
    print(json)
    exit(EXIT_SUCCESS)
}

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments.first == "--open-app" { openApplicationOneShot(arguments) }
if arguments.first == "--focus-pid" || arguments.first == "--quit-pid" { oneShot(arguments) }

struct LauncherMetadata {
    let store: String
    let profileID: String
    let node: String
    let entry: String
}

func ownExecutable() -> String {
    URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL.resolvingSymlinksInPath().path
}

func metadataFromBundle() -> LauncherMetadata? {
    guard let info = Bundle.main.infoDictionary,
          let store = info["XfxStore"] as? String,
          let profile = info["XfxProfileId"] as? String,
          let node = info["XfxNode"] as? String,
          let entry = info["XfxEntryPoint"] as? String,
          [store, node, entry].allSatisfy({ $0.hasPrefix("/") }) else { return nil }
    return LauncherMetadata(store: store, profileID: profile, node: node, entry: entry)
}

final class LauncherDelegate: NSObject, NSApplicationDelegate {
    private var target: TargetIdentity?
    private var timer: Timer?
    private var resolving = false
    private var showingError = false
    private var app: NSApplication { NSApplication.shared }

    func applicationDidFinishLaunching(_ notification: Notification) {
        app.setActivationPolicy(.regular)
        buildMenu()
        if let target = parseTarget(arguments, mode: "--target-pid"), validatedApplication(target) != nil {
            self.target = target
            timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.pollTarget() }
            forwardFocus()
        } else if arguments.isEmpty {
            resolveTargetFromController()
        } else {
            showError("The requested Codex process could not be verified.")
        }
    }

    func applicationDidBecomeActive(_ notification: Notification) { forwardFocus() }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows: Bool) -> Bool {
        forwardFocus()
        return true
    }

    private func buildMenu() {
        let main = NSMenu()
        let root = NSMenuItem()
        main.addItem(root)
        let menu = NSMenu()
        let focus = NSMenuItem(title: "Focus Codex", action: #selector(focusTarget), keyEquivalent: "")
        focus.target = self
        menu.addItem(focus)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit Codex", action: #selector(quitTarget), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        root.submenu = menu
        app.mainMenu = main
    }

    @objc private func focusTarget() { forwardFocus() }
    @objc private func quitTarget() {
        guard let target, validatedApplication(target) != nil else { app.terminate(nil); return }
        if validatedApplication(target)?.terminate() == true {
            // Keep this small launcher alive until the original app is actually gone.
            pollTarget()
        } else {
            showError("Codex did not accept the quit request. Dismiss its quit confirmation and try again.")
        }
    }

    private func pollTarget() {
        guard let target else { return }
        guard validatedApplication(target) != nil else { timer?.invalidate(); timer = nil; app.terminate(nil); return }
    }

    private func forwardFocus() {
        guard let target, let running = validatedApplication(target) else { return }
        _ = running.activate(options: [.activateAllWindows])
    }

    private func resolveTargetFromController() {
        guard !resolving, let metadata = metadataFromBundle() else {
            showError("This profile launcher is missing its controller settings.")
            return
        }
        resolving = true
        let process = Process()
        process.executableURL = URL(fileURLWithPath: metadata.node)
        process.arguments = [metadata.entry, "--store", metadata.store, "--json", "desktop", "open", metadata.profileID]
        var environment = ProcessInfo.processInfo.environment
        environment["XFX_DESKTOP_LAUNCHER_PID"] = String(getpid())
        environment["XFX_DESKTOP_LAUNCHER_EXECUTABLE"] = ownExecutable()
        process.environment = environment
        let output = Pipe()
        process.standardOutput = output
        process.standardError = FileHandle.nullDevice
        process.terminationHandler = { [weak self] child in
            let data = output.fileHandleForReading.readDataToEndOfFile()
            DispatchQueue.main.async {
                guard let self else { return }
                self.resolving = false
                guard child.terminationStatus == 0,
                      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let main = object["main"] as? [String: Any],
                      let pid = main["pid"] as? Int, let executable = main["executable"] as? String,
                      let start = Self.startSeconds(object["mainStartSeconds"]) else {
                    self.showError("Could not open this profile's Codex instance.")
                    return
                }
                let target = TargetIdentity(pid: pid_t(pid), executable: executable, startSeconds: start)
                guard validatedApplication(target) != nil else {
                    self.showError("The profile's Codex instance could not be verified.")
                    return
                }
                self.target = target
                self.timer?.invalidate()
                self.timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.pollTarget() }
                self.forwardFocus()
            }
        }
        do { try process.run() }
        catch { resolving = false; showError("Could not open this profile's Codex instance.") }
    }

    private func showError(_ message: String) {
        guard !showingError else { return }
        showingError = true
        let alert = NSAlert()
        alert.messageText = "Profile launcher"
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.addButton(withTitle: "OK")
        alert.runModal()
        showingError = false
    }

    private static func startSeconds(_ value: Any?) -> Int? {
        if let number = value as? NSNumber { return number.intValue }
        if let string = value as? String { return Int(string) }
        return nil
    }
}

let application = NSApplication.shared
let delegate = LauncherDelegate()
application.delegate = delegate
application.run()
