import Foundation
@main struct Tests {
 static func main() throws {
  let fixtures=URL(fileURLWithPath:CommandLine.arguments[1])
  let root=fm.temporaryDirectory.appendingPathComponent("dico-test-"+UUID().uuidString)
  try fm.createDirectory(at:root,withIntermediateDirectories:true);defer{try? fm.removeItem(at:root)}
  let target=root.appendingPathComponent("extension");try fm.createDirectory(at:target,withIntermediateDirectories:true)
  try writeJSON(["name":"Dico While · 교대 공지","manifest_version":3,"version":"0.2.41","permissions":["storage"]],target.appendingPathComponent("manifest.json"))
  try Data("old".utf8).write(to:target.appendingPathComponent("background.js"))
  for name in ["traversal","symlink","duplicate","local-mismatch","permission"] {
   let data=try Data(contentsOf:fixtures.appendingPathComponent(name+".zip"))
   do { _=try installZIP(data,digest:"sha256:"+sha256(data),version:"0.2.42",destination:target);fatalError("accepted \(name)") }catch{}
   assert(try! String(contentsOf:target.appendingPathComponent("background.js"),encoding:.utf8)=="old")
  }
  let good=try Data(contentsOf:fixtures.appendingPathComponent("good.zip"))
  do {_=try installZIP(good,digest:"sha256:bad",version:"0.2.42",destination:target);fatalError("bad hash")}catch{}
  let backup=try installZIP(good,digest:"sha256:"+sha256(good),version:"0.2.42",destination:target)
  assert(try! String(contentsOf:target.appendingPathComponent("background.js"),encoding:.utf8)=="new")
  assert(try! String(contentsOf:backup.appendingPathComponent("background.js"),encoding:.utf8)=="old")
  try fm.createDirectory(at:target.appendingPathComponent(".git"),withIntermediateDirectories:true)
  do{try validateDestination(target);fatalError("accepted git")}catch{}
  print("macOS updater: verified swap, backup, hash, unsafe archives, permissions and developer-folder protection")
 }
}
