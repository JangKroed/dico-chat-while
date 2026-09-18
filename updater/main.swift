import Foundation
import AppKit
import Darwin

func installHelper() throws {
    let app = NSApplication.shared; app.setActivationPolicy(.regular); app.activate(ignoringOtherApps: true)
    let intro = NSAlert(); intro.messageText = "DICO 자동 업데이트 연결"
    intro.informativeText = "먼저 0.2.41 이상 확장을 설치하고 모든 채널을 중지하세요. 이후 새 릴리즈의 파일 교체와 확장 새로고침을 자동 처리합니다. 설정은 유지됩니다.\n\n확장 관리 화면에 표시되는 DICO의 32자리 ID를 입력하세요. 같은 설치 폴더를 여러 브라우저/프로필에서 함께 사용하지 마세요."
    let input = NSTextField(frame: NSRect(x: 0,y: 0,width: 360,height: 24)); intro.accessoryView = input
    intro.addButton(withTitle: "설치 폴더 선택"); intro.addButton(withTitle: "취소")
    guard intro.runModal() == .alertFirstButtonReturn else { return }
    let id = input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
    guard id.range(of: #"^[a-p]{32}$"#, options: .regularExpression) != nil else { throw UpdateError("확장 ID는 a~p로 이루어진 32자리입니다.") }
    let picker = NSOpenPanel(); picker.canChooseDirectories = true; picker.canChooseFiles = false; picker.allowsMultipleSelection = false
    picker.message = "현재 Chrome/Brave에 등록한 DICO 설치 폴더를 선택하세요. manifest.json이 있는 폴더입니다."
    guard picker.runModal() == .OK, let directory = picker.url else { return }
    try validateDestination(directory)
    guard let v = try manifest(directory)["version"] as? String, !(try isNewer("0.2.41", v)) else { throw UpdateError("먼저 확장을 0.2.41 이상으로 한 번 업데이트하세요.") }
    try fm.createDirectory(at: support, withIntermediateDirectories: true)
    let binary = support.appendingPathComponent("dico-updater")
    let source = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
    if source.path != binary.path {
        let temp = support.appendingPathComponent("installer-" + UUID().uuidString)
        try fm.copyItem(at: source, to: temp)
        if rename(temp.path, binary.path) != 0 { try? fm.removeItem(at: temp); throw UpdateError("보조 프로그램을 설치하지 못했습니다.") }
        try fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: binary.path)
    }
    var config = (try? json(support.appendingPathComponent("config.json"))) as? [String:String] ?? [:]
    if config.contains(where: { $0.key != id && $0.value == directory.path }) { throw UpdateError("이 폴더는 다른 확장 ID에 연결되어 있습니다. 브라우저별 별도 폴더를 사용하세요.") }
    config[id] = directory.path
    try writeJSON(config, support.appendingPathComponent("config.json"))
    let host: [String:Any] = ["name":hostName,"description":"DICO verified release updater","path":binary.path,"type":"stdio","allowed_origins":config.keys.sorted().map { "chrome-extension://\($0)/" }]
    for browser in ["Google/Chrome", "BraveSoftware/Brave-Browser"] {
        let path = fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/\(browser)/NativeMessagingHosts")
        try fm.createDirectory(at: path, withIntermediateDirectories: true)
        try writeJSON(host, path.appendingPathComponent(hostName + ".json"))
    }
    let alert = NSAlert(); alert.messageText = "설치 완료"
    alert.informativeText = "DICO 사이드패널에서 ‘보조 프로그램 연결 / 자동 적용 켜기’를 누르세요. 다음 업데이트부터 수동 압축 해제와 덮어쓰기가 필요 없습니다.\n\n이 설치 앱은 닫아도 됩니다."
    alert.runModal()
}
func readExactly(_ length: Int) throws -> Data {
    var data = Data()
    while data.count < length {
        let part = FileHandle.standardInput.readData(ofLength: length - data.count)
        if part.isEmpty { throw UpdateError("메시지 연결 종료") }; data.append(part)
    }
    return data
}
func nativeRequest(_ origin: String) throws -> [String:Any] {
    guard origin.range(of: #"^chrome-extension://[a-p]{32}/$"#, options: .regularExpression) != nil else { throw UpdateError("허용되지 않은 호출") }
    let id = String(origin.dropFirst("chrome-extension://".count).dropLast())
    guard let directory = try json(support.appendingPathComponent("config.json"))[id] as? String else { throw UpdateError("연결되지 않은 확장 ID입니다. 설치 앱을 다시 실행하세요.") }
    let header = [UInt8](try readExactly(4))
    let length = (0..<4).reduce(0) { $0 | Int(header[$1]) << (8 * $1) }
    guard length > 0, length <= 4096, let request = try JSONSerialization.jsonObject(with: readExactly(length)) as? [String:Any] else { throw UpdateError("잘못된 요청") }
    let destination = URL(fileURLWithPath: directory)
    try validateDestination(destination)
    if request["operation"] as? String == "probe" { return ["ok":true,"helperVersion":1,"installedVersion":try manifest(destination)["version"] as! String] }
    guard request["operation"] as? String == "update", let current = request["currentVersion"] as? String else { throw UpdateError("지원하지 않는 요청") }
    _ = try versionParts(current)
    let lock = open(support.appendingPathComponent("update.lock").path, O_CREAT | O_RDWR, 0o600)
    guard lock >= 0 else { throw UpdateError("업데이트 잠금 실패") }; defer { close(lock) }
    guard flock(lock, LOCK_EX | LOCK_NB) == 0 else { throw UpdateError("다른 업데이트가 진행 중입니다.") }
    defer { flock(lock, LOCK_UN) }
    return try performUpdate(destination: destination, current: current)
}
if let origin = CommandLine.arguments.dropFirst().first, origin.hasPrefix("chrome-extension://") {
    let result: [String:Any]
    do { result = try nativeRequest(origin) } catch { result = ["ok":false,"error":error.localizedDescription] }
    let data = try! JSONSerialization.data(withJSONObject: result)
    var size = UInt32(data.count).littleEndian
    FileHandle.standardOutput.write(Data(bytes: &size,count: 4)); FileHandle.standardOutput.write(data)
} else {
    do { try installHelper() } catch {
        let alert = NSAlert(); alert.messageText = "DICO 설치 안내"; alert.informativeText = error.localizedDescription; alert.runModal()
    }
}
