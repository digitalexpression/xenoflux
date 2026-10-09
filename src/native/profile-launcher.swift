import AppKit
import Foundation
import Darwin

struct TargetIdentity {
    let pid: pid_t
    let executable: String
    let startSeconds: Int
}

func resolvedPath(_ url: URL) -> String {
    // Foundation can prefer /var over its /private/var filesystem target.
    // Match the controller's POSIX realpath identity, including in temp stores.
    guard let path = url.path.withCString({ realpath($0, nil) }) else { return url.path }
    defer { free(path) }
    return String(cString: path)
}

func executablePath(_ pid: pid_t) -> String? {
    // PROC_PIDPATHINFO_MAXSIZE is the C expression 4 * MAXPATHLEN;
    // Swift does not import that macro expression from proc_info.h.
    var buffer = [CChar](repeating: 0, count: 4 * Int(MAXPATHLEN))
    guard proc_pidpath(pid, &buffer, UInt32(buffer.count)) > 0 else { return nil }
    return resolvedPath(URL(fileURLWithPath: String(cString: buffer)))
}

func validatedApplication(_ target: TargetIdentity) -> NSRunningApplication? {
    guard target.pid > 0, target.pid != getpid(), let app = NSRunningApplication(processIdentifier: target.pid),
          !app.isTerminated, executablePath(target.pid) == resolvedPath(URL(fileURLWithPath: target.executable)),
          let launched = app.launchDate,
          Int(floor(launched.timeIntervalSince1970)) == target.startSeconds else { return nil }
    return app
}

func safeAbsolutePath(_ value: String) -> Bool {
    value.hasPrefix("/") && !value.unicodeScalars.contains { $0.value < 32 || $0.value == 127 }
}

func parseTarget(_ args: [String], mode: String) -> TargetIdentity? {
    guard args.count == 6, args[0] == mode, let pid = Int32(args[1]), pid > 0,
          args[2] == "--target-executable", args[4] == "--target-start-seconds",
          let start = Int(args[5]), start >= 0, safeAbsolutePath(args[3]) else { return nil }
    return TargetIdentity(pid: pid, executable: args[3], startSeconds: start)
}

func oneShot(_ args: [String]) -> Never {
    guard let mode = args.first, mode == "--focus-pid" || mode == "--quit-pid",
          let target = parseTarget(args, mode: mode), let app = validatedApplication(target) else { exit(EXIT_FAILURE) }
    let ok = mode == "--focus-pid" ? app.activate(options: [.activateAllWindows]) : app.terminate()
    exit(ok ? EXIT_SUCCESS : EXIT_FAILURE)
}

func openApplicationOneShot(_ args: [String]) -> Never {
    guard args.count == 12, args[0] == "--open-app",
          args[2] == "--home", args[4] == "--desktop-data", args[6] == "--user-home",
          args[8] == "--temporary", args[10] == "--target-executable",
          [args[1], args[3], args[5], args[7], args[9], args[11]].allSatisfy(safeAbsolutePath) else {
        fputs("Invalid profile launch request.\n", stderr); exit(EXIT_FAILURE)
    }
    let appURL = URL(fileURLWithPath: args[1]).standardizedFileURL
    let expectedExecutable = resolvedPath(URL(fileURLWithPath: args[11]))
    let configuration = NSWorkspace.OpenConfiguration()
    configuration.createsNewApplicationInstance = true
    configuration.arguments = ["--profile-run"]
    configuration.environment = ["CODEX_HOME": args[3], "CODEX_SQLITE_HOME": args[3],
        "CODEX_ELECTRON_USER_DATA_PATH": args[5], "HOME": args[7], "TMPDIR": args[9]]
    var completed = false
    var launched: NSRunningApplication?
    var launchError: NSError?
    NSWorkspace.shared.openApplication(at: appURL, configuration: configuration) { application, error in
        DispatchQueue.main.async { launched = application; launchError = error as NSError?; completed = true }
    }
    let deadline = Date(timeIntervalSinceNow: 15)
    while !completed && Date() < deadline {
        _ = RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
    }
    guard completed, launchError == nil, let application = launched,
          application.processIdentifier > 0, application.processIdentifier != getpid(),
          let launchDate = application.launchDate else {
        if let error = launchError {
            fputs("Unable to launch the requested profile instance: \(error.domain) (\(error.code)): \(error.localizedDescription)\n", stderr)
        } else {
            fputs("Unable to launch the requested profile instance: macOS returned no live application before the launch deadline.\n", stderr)
        }
        exit(EXIT_FAILURE)
    }
    // LaunchServices starts the bootstrap. exec replaces it in the same PID,
    // so inspect the kernel path rather than cached CFBundleExecutable metadata.
    let target = TargetIdentity(pid: application.processIdentifier, executable: expectedExecutable,
        startSeconds: Int(floor(launchDate.timeIntervalSince1970)))
    while validatedApplication(target) == nil && Date() < deadline && !application.isTerminated {
        _ = RunLoop.current.run(mode: .default, before: Date(timeIntervalSinceNow: 0.05))
    }
    guard validatedApplication(target) != nil else {
        fputs("Unable to verify the requested profile instance: PID \(target.pid), expected executable \(target.executable), observed \(executablePath(target.pid) ?? "stopped").\n", stderr); exit(EXIT_FAILURE)
    }
    let result: [String: Any] = ["pid": target.pid, "executable": target.executable, "startSeconds": target.startSeconds]
    guard let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]),
          let json = String(data: data, encoding: .utf8) else { exit(EXIT_FAILURE) }
    print(json)
    exit(EXIT_SUCCESS)
}

struct ProfileMetadata {
    let store: String
    let profileID: String
    let node: String
    let entry: String
    let nativeRoot: String
    let vendorExecutable: String
}

func metadataFromBundle() -> ProfileMetadata? {
    guard let info = Bundle.main.infoDictionary,
          let store = info["XfxStore"] as? String,
          let profile = info["XfxProfileId"] as? String, UUID(uuidString: profile) != nil,
          let node = info["XfxNode"] as? String,
          let entry = info["XfxEntryPoint"] as? String,
          let root = info["XfxNativeRoot"] as? String,
          let vendor = info["XfxVendorExecutable"] as? String,
          [store, node, entry, root].allSatisfy(safeAbsolutePath),
          !vendor.isEmpty, vendor != ".", vendor != "..", !vendor.contains("/"),
          !vendor.unicodeScalars.contains(where: { $0.value < 32 || $0.value == 127 }) else { return nil }
    let executable = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/\(vendor)")
    return ProfileMetadata(store: store, profileID: profile, node: node, entry: entry,
        nativeRoot: root, vendorExecutable: resolvedPath(executable))
}

func executeProfile(_ metadata: ProfileMetadata) -> Never {
    let home = metadata.nativeRoot + "/codex-home"
    let desktopData = metadata.nativeRoot + "/desktop-data"
    setenv("CODEX_HOME", home, 1)
    setenv("CODEX_SQLITE_HOME", home, 1)
    setenv("CODEX_ELECTRON_USER_DATA_PATH", desktopData, 1)
    setenv("HOME", metadata.nativeRoot + "/user-home", 1)
    setenv("TMPDIR", metadata.nativeRoot + "/tmp", 1)
    unsetenv("XFX_DESKTOP_LAUNCHER_PID")
    unsetenv("XFX_DESKTOP_LAUNCHER_EXECUTABLE")
    let args = [metadata.vendorExecutable, "--user-data-dir=\(desktopData)"]
    let pointers = args.map { strdup($0) } + [nil]
    pointers.withUnsafeBufferPointer { _ = execv(metadata.vendorExecutable, $0.baseAddress!) }
    fputs("Unable to execute this profile's Codex app.\n", stderr)
    exit(EXIT_FAILURE)
}

func openFromFinder(_ metadata: ProfileMetadata) -> Never {
    // Reserve this profile before replacing ourselves. The controller waits
    // for this exact PID to become the vendor app, then records ownership.
    let process = Process()
    process.executableURL = URL(fileURLWithPath: metadata.node)
    process.arguments = [metadata.entry, "--store", metadata.store, "--json", "desktop", "open", metadata.profileID]
    var environment = ProcessInfo.processInfo.environment
    environment["XFX_DESKTOP_LAUNCHER_PID"] = String(getpid())
    environment["XFX_DESKTOP_LAUNCHER_EXECUTABLE"] = executablePath(getpid())
    process.environment = environment
    let output = Pipe()
    process.standardOutput = output
    process.standardError = FileHandle.standardError
    do { try process.run() } catch {
        fputs("Unable to start the profile controller.\n", stderr); exit(EXIT_FAILURE)
    }
    var data = Data()
    while data.count < 4096 {
        let byte = output.fileHandleForReading.readData(ofLength: 1)
        guard !byte.isEmpty else { break }
        if byte[0] == 10 { break }
        data.append(byte)
    }
    guard let reply = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          reply["kind"] as? String == "xfx-profile-bootstrap", reply["profileId"] as? String == metadata.profileID,
          reply["pid"] as? Int == Int(getpid()), let status = reply["status"] as? String else {
        fputs("The controller did not authorize this profile launch.\n", stderr); exit(EXIT_FAILURE)
    }
    output.fileHandleForReading.closeFile()
    if status == "already-running" { exit(EXIT_SUCCESS) }
    guard status == "launch" else { exit(EXIT_FAILURE) }
    executeProfile(metadata)
}

let arguments = Array(CommandLine.arguments.dropFirst())
if arguments.first == "--open-app" { openApplicationOneShot(arguments) }
if arguments.first == "--focus-pid" || arguments.first == "--quit-pid" { oneShot(arguments) }
guard let metadata = metadataFromBundle() else {
    fputs("This profile app is missing its controller settings.\n", stderr); exit(EXIT_FAILURE)
}
if arguments == ["--profile-run"] { executeProfile(metadata) }
guard arguments.isEmpty else { exit(EXIT_FAILURE) }
openFromFinder(metadata)
