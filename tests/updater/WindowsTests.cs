using System;
using System.IO;
using System.Text;
public static class UpdaterTests {
 static void Check(bool ok,string reason){if(!ok)throw new Exception(reason);}
 static void Reject(Action action,string reason){try{action();}catch{return;}throw new Exception("accepted "+reason);}
 public static void Main(string[] args){
  string root=Path.Combine(Path.GetTempPath(),"dico-test-"+Guid.NewGuid()),target=Path.Combine(root,"extension"),journal=Path.Combine(root,"transaction.json");Directory.CreateDirectory(target);
  try{
   File.WriteAllText(Path.Combine(target,"manifest.json"),"{\"name\":\"Dico While · 교대 공지\",\"manifest_version\":3,\"version\":\"0.2.41\",\"permissions\":[\"storage\"]}",new UTF8Encoding(false));File.WriteAllText(Path.Combine(target,"background.js"),"old");
   foreach(string name in new[]{"traversal","symlink","duplicate","local-mismatch","permission"}){
    byte[] data=File.ReadAllBytes(Path.Combine(args[0],name+".zip"));Reject(()=>DicoUpdater.Install(data,DicoUpdater.Hash(data),"0.2.42",target,journal),name);Check(File.ReadAllText(Path.Combine(target,"background.js"))=="old",name+" changed install");
   }
   byte[] good=File.ReadAllBytes(Path.Combine(args[0],"good.zip"));Reject(()=>DicoUpdater.Install(good,"bad","0.2.42",target,journal),"hash");
   Reject(()=>DicoUpdater.Install(good,DicoUpdater.Hash(good),"0.2.42",target,journal,p=>{throw new IOException("simulated locked file");}),"rollback");Check(File.ReadAllText(Path.Combine(target,"background.js"))=="old","rollback failed");
   string backup=DicoUpdater.Install(good,DicoUpdater.Hash(good),"0.2.42",target,journal);Check(File.ReadAllText(Path.Combine(target,"background.js"))=="new","install failed");Check(File.ReadAllText(Path.Combine(backup,"background.js"))=="old","backup missing");
   Directory.Move(target,target+"-interrupted");File.WriteAllText(journal,"{\"destination\":\""+target.Replace("\\","\\\\")+"\",\"backup\":\""+(target+"-interrupted").Replace("\\","\\\\")+"\",\"stage\":\"unused\"}");DicoUpdater.Recover(journal);Check(Directory.Exists(target),"crash recovery failed");
   Directory.CreateDirectory(Path.Combine(target,".git"));Reject(()=>DicoUpdater.ValidateDestination(target),"git");
   Console.WriteLine("Windows updater: verified replacement, rollback, interrupted recovery, hash, unsafe ZIPs and developer folder protection");
  }finally{Directory.Delete(root,true);}
 }
}
