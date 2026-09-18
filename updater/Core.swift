import Foundation
import CryptoKit
import Darwin

struct UpdateError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
let fm = FileManager.default
let repository = "https://github.com/JangKroed/dico-chat-while"
let releaseAPI = "https://api.github.com/repos/JangKroed/dico-chat-while/releases/latest"
let hostName = "com.dico.updater"
let support = fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/DicoUpdater")
func json(_ url: URL) throws -> [String: Any] {
    guard let value = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any] else { throw UpdateError("JSON 형식이 올바르지 않습니다.") }
    return value
}
func writeJSON(_ value: Any, _ url: URL) throws {
    try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys]).write(to: url, options: .atomic)
}
func versionParts(_ version: String) throws -> [Int] {
    guard version.range(of: #"^\d+\.\d+\.\d+$"#, options: .regularExpression) != nil else { throw UpdateError("버전 형식 오류") }
    let parts = version.split(separator: ".").compactMap { Int($0) }
    guard parts.count == 3 else { throw UpdateError("버전 값 오류") }; return parts
}
func isNewer(_ a: String, _ b: String) throws -> Bool { try versionParts(b).lexicographicallyPrecedes(versionParts(a)) }
func manifest(_ directory: URL) throws -> [String: Any] {
    let m = try json(directory.appendingPathComponent("manifest.json"))
    guard m["name"] as? String == "Dico While · 교대 공지", m["manifest_version"] as? Int == 3,
          let version = m["version"] as? String else { throw UpdateError("DICO 확장 프로그램 폴더가 아닙니다.") }
    _ = try versionParts(version); return m
}
func validateDestination(_ directory: URL) throws {
    guard directory.path == directory.resolvingSymlinksInPath().path else { throw UpdateError("연결된 폴더 대신 실제 설치 폴더를 선택하세요.") }
    var ancestor = directory
    while ancestor.path != "/" {
        if fm.fileExists(atPath: ancestor.appendingPathComponent(".git").path) { throw UpdateError("개발용 Git 폴더는 자동 업데이트할 수 없습니다. 배포 ZIP을 별도 폴더에 설치하세요.") }
        ancestor.deleteLastPathComponent()
    }
    _ = try manifest(directory)
}
func sha256(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }

// Validate central AND local ZIP paths before invoking the OS extractor. Reject
// symlinks, traversal, duplicate paths, encryption and unbounded unpacked data.
func validateZIP(_ data: Data) throws -> Set<String> {
    guard data.count >= 22, data.count <= 16_000_000 else { throw UpdateError("ZIP 크기 오류") }
    let bytes = [UInt8](data)
    func number(_ at: Int, _ count: Int) throws -> Int {
        guard at >= 0, at + count <= bytes.count else { throw UpdateError("손상된 ZIP") }
        return (0..<count).reduce(0) { $0 | (Int(bytes[at + $1]) << ($1 * 8)) }
    }
    var end: Int?
    for i in stride(from: bytes.count - 22, through: max(0, bytes.count - 65557), by: -1) {
        if try number(i, 4) == 0x06054b50, i + 22 + (try number(i + 20, 2)) == bytes.count { end = i; break }
    }
    guard let e = end, try number(e + 4, 2) == 0, try number(e + 6, 2) == 0 else { throw UpdateError("지원하지 않는 ZIP") }
    let count = try number(e + 10, 2), size = try number(e + 12, 4)
    var cursor = try number(e + 16, 4), total = 0
    let directoryEnd = cursor + size
    guard count > 0, count < 300, try number(e + 8, 2) == count, directoryEnd == e else { throw UpdateError("ZIP 목록 오류") }
    var names = Set<String>()
    for _ in 0..<count {
        guard try number(cursor, 4) == 0x02014b50 else { throw UpdateError("ZIP 항목 오류") }
        let flags = try number(cursor + 8, 2), method = try number(cursor + 10, 2)
        let packed = try number(cursor + 20, 4), unpacked = try number(cursor + 24, 4)
        let length = try number(cursor + 28, 2), extra = try number(cursor + 30, 2), comment = try number(cursor + 32, 2)
        let mode = (try number(cursor + 38, 4)) >> 16
        let local = try number(cursor + 42, 4)
        guard flags & 1 == 0, [0,8].contains(method), length > 0, cursor + 46 + length <= directoryEnd,
              let name = String(bytes: bytes[(cursor + 46)..<(cursor + 46 + length)], encoding: .utf8),
              name.range(of: #"^[A-Za-z0-9][A-Za-z0-9_./-]*$"#, options: .regularExpression) != nil,
              !name.split(separator: "/", omittingEmptySubsequences: false).contains(where: { $0 == ".." || $0 == "." || $0.isEmpty }),
              [0,0o100000].contains(mode & 0o170000), names.insert(name).inserted,
              try number(local, 4) == 0x04034b50 else { throw UpdateError("허용되지 않는 ZIP 경로 또는 파일") }
        let localLength = try number(local + 26, 2), localExtra = try number(local + 28, 2)
        guard localLength == length, local + 30 + localLength + localExtra + packed <= (try number(e + 16, 4)),
              Array(bytes[(local + 30)..<(local + 30 + localLength)]) == Array(name.utf8) else { throw UpdateError("ZIP 경로 정보가 일치하지 않습니다.") }
        total += unpacked
        guard total <= 32_000_000 else { throw UpdateError("압축 해제 크기 제한 초과") }
        cursor += 46 + length + extra + comment
    }
    guard cursor == directoryEnd, names.contains("manifest.json"), names.contains("background.js") else { throw UpdateError("설치 파일이 빠져 있습니다.") }
    return names
}
func run(_ executable: String, _ arguments: [String]) throws {
    let task = Process(); task.executableURL = URL(fileURLWithPath: executable); task.arguments = arguments
    task.standardOutput = FileHandle.nullDevice; task.standardError = FileHandle.nullDevice
    try task.run(); task.waitUntilExit()
    if task.terminationStatus != 0 { throw UpdateError("파일 처리에 실패했습니다. 기존 설치는 유지됩니다.") }
}
// RENAME_SWAP atomically exchanges directories on the same filesystem. Even a
// process crash leaves a complete install at the original path (and the old copy
// at staging). Browser settings live outside this directory and are untouched.
func installZIP(_ data: Data, digest: String, version: String, destination: URL) throws -> URL {
    try validateDestination(destination)
    guard digest == "sha256:" + sha256(data) else { throw UpdateError("설치 ZIP 해시가 일치하지 않습니다.") }
    let names = try validateZIP(data)
    let parent = destination.deletingLastPathComponent()
    let stage = parent.appendingPathComponent(".dico-previous-" + UUID().uuidString)
    let archive = parent.appendingPathComponent(".dico-download-" + UUID().uuidString + ".zip")
    try fm.createDirectory(at: stage, withIntermediateDirectories: false)
    var swapped = false
    defer { try? fm.removeItem(at: archive); if !swapped { try? fm.removeItem(at: stage) } }
    try data.write(to: archive)
    try run("/usr/bin/ditto", ["-x", "-k", archive.path, stage.path])
    let files = fm.enumerator(at: stage, includingPropertiesForKeys: [.isSymbolicLinkKey, .isRegularFileKey])!
    var extracted = Set<String>()
    for case let file as URL in files {
        let props = try file.resourceValues(forKeys: [.isSymbolicLinkKey, .isRegularFileKey])
        guard props.isSymbolicLink != true else { throw UpdateError("연결 파일은 설치할 수 없습니다.") }
        if props.isRegularFile == true {
            // Foundation may canonicalize /var to /private/var during enumeration.
            guard let rootIndex = file.pathComponents.lastIndex(of: stage.lastPathComponent) else { throw UpdateError("압축 해제 경로 오류") }
            extracted.insert(file.pathComponents.dropFirst(rootIndex + 1).joined(separator: "/"))
        }
    }
    guard extracted == names, try manifest(stage)["version"] as? String == version else { throw UpdateError("ZIP 내용 또는 버전이 일치하지 않습니다.") }
    let old = try manifest(destination)
    // Never let an automatic file update silently expand required permissions.
    let new = try manifest(stage)
    for key in ["permissions", "host_permissions"] {
        guard Set(new[key] as? [String] ?? []).isSubset(of: Set(old[key] as? [String] ?? [])) else { throw UpdateError("새 필수 권한이 있어 수동 업데이트가 필요합니다.") }
    }
    guard renameatx_np(AT_FDCWD, stage.path, AT_FDCWD, destination.path, UInt32(RENAME_SWAP)) == 0 else { throw UpdateError("폴더를 안전하게 교체하지 못했습니다. 기존 설치는 유지됩니다.") }
    swapped = true
    return stage
}

final class TrustedRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        let allowed = ["api.github.com", "github.com", "release-assets.githubusercontent.com", "objects.githubusercontent.com"]
        completionHandler(request.url?.scheme == "https" && allowed.contains(request.url?.host ?? "") ? request : nil)
    }
}
func fetch(_ url: String) throws -> Data {
    var request = URLRequest(url: URL(string: url)!); request.timeoutInterval = 45
    request.setValue("DicoUpdater/1", forHTTPHeaderField: "User-Agent")
    let config = URLSessionConfiguration.ephemeral; config.timeoutIntervalForResource = 60
    config.httpCookieStorage = nil; config.urlCredentialStorage = nil
    let session = URLSession(configuration: config, delegate: TrustedRedirects(), delegateQueue: nil)
    defer { session.invalidateAndCancel() }
    let semaphore = DispatchSemaphore(value: 0)
    var result: Result<Data, Error> = .failure(UpdateError("다운로드 시간 초과"))
    session.dataTask(with: request) { data, response, error in
        defer { semaphore.signal() }
        if let error = error { result = .failure(error); return }
        guard let response = response as? HTTPURLResponse, response.statusCode == 200, let data = data, data.count <= 16_000_000 else { result = .failure(UpdateError("GitHub 다운로드에 실패했습니다.")); return }
        result = .success(data)
    }.resume()
    // URLSession enforces resource timeout; waiting for the completion avoids
    // returning while the callback still owns the result buffer.
    semaphore.wait(); return try result.get()
}
func performUpdate(destination: URL, current: String) throws -> [String: Any] {
    try validateDestination(destination)
    let installed = try manifest(destination)["version"] as! String
    // Recover a lost native response: disk was updated but the browser wasn't.
    if try isNewer(installed, current) { return ["ok": true, "updated": true, "version": installed] }
    guard let release = try JSONSerialization.jsonObject(with: fetch(releaseAPI)) as? [String: Any],
          release["draft"] as? Bool == false, release["prerelease"] as? Bool == false,
          let tag = release["tag_name"] as? String, tag.hasPrefix("v") else { throw UpdateError("정식 릴리즈 정보가 없습니다.") }
    let version = String(tag.dropFirst())
    guard try isNewer(version, installed) else { return ["ok": true, "updated": false, "version": installed] }
    let name = "dico-while-\(version).zip", url = "\(repository)/releases/download/\(tag)/dico-while-\(version).zip"
    guard let asset = (release["assets"] as? [[String: Any]])?.first(where: { $0["name"] as? String == name && $0["browser_download_url"] as? String == url }),
          let digest = asset["digest"] as? String, digest.range(of: #"^sha256:[0-9a-f]{64}$"#, options: .regularExpression) != nil else { throw UpdateError("검증 가능한 배포 ZIP이 없습니다.") }
    _ = try installZIP(fetch(url), digest: digest, version: version, destination: destination)
    return ["ok": true, "updated": true, "version": version]
}
