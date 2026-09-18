using System;
using System.IO;
using System.IO.Compression;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;

public static class DicoUpdater {
 public const string Host="com.dico.updater", Repo="https://github.com/JangKroed/dico-chat-while";
 public static string Support=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"DicoUpdater");
 static JavaScriptSerializer JSON=new JavaScriptSerializer{MaxJsonLength=16000000};
 static Dictionary<string,object> Parse(string value){return JSON.Deserialize<Dictionary<string,object>>(value);}
 static Dictionary<string,object> Read(string path){return Parse(File.ReadAllText(path));}
 static string Get(Dictionary<string,object> d,string key){return d.ContainsKey(key)?Convert.ToString(d[key]):"";}
 static void Write(string path,object value){
  string temp=path+".tmp-"+Guid.NewGuid();File.WriteAllText(temp,JSON.Serialize(value),new UTF8Encoding(false));
  if(File.Exists(path))File.Replace(temp,path,null);else File.Move(temp,path);
 }
 static Exception Error(string text){return new InvalidOperationException(text);}
 public static Version Ver(string text){if(!Regex.IsMatch(text,@"^\d+\.\d+\.\d+$"))throw Error("버전 형식 오류");return new Version(text);}
 public static Dictionary<string,object> Manifest(string dir){
  var m=Read(Path.Combine(dir,"manifest.json"));
  if(Get(m,"name")!="Dico While · 교대 공지"||Get(m,"manifest_version")!="3")throw Error("DICO 설치 폴더가 아닙니다.");Ver(Get(m,"version"));return m;
 }
 public static void ValidateDestination(string dir){
  for(var p=new DirectoryInfo(dir);p!=null;p=p.Parent){
   if((p.Attributes&FileAttributes.ReparsePoint)!=0)throw Error("연결 폴더는 사용할 수 없습니다.");
   if(Directory.Exists(Path.Combine(p.FullName,".git"))||File.Exists(Path.Combine(p.FullName,".git")))throw Error("개발용 Git 폴더는 자동 업데이트하지 않습니다.");
  }
  Manifest(dir);
 }
 public static string Hash(byte[] data){using(var sha=SHA256.Create())return "sha256:"+BitConverter.ToString(sha.ComputeHash(data)).Replace("-","").ToLowerInvariant();}
 static int Num(byte[] b,int p,int n){if(p<0||p>b.Length-n)throw Error("손상된 ZIP");long v=0;for(int i=0;i<n;i++)v|=(long)b[p+i]<<(8*i);if(v>Int32.MaxValue)throw Error("ZIP 값 범위 초과");return (int)v;}
 public static HashSet<string> ValidateZip(byte[] data){
  if(data.Length<22||data.Length>16000000)throw Error("ZIP 크기 오류");
  int end=-1;for(int i=data.Length-22;i>=Math.Max(0,data.Length-65557);i--){if(Num(data,i,4)==0x06054b50&&i+22+Num(data,i+20,2)==data.Length){end=i;break;}}
  if(end<0||Num(data,end+4,2)!=0||Num(data,end+6,2)!=0)throw Error("ZIP 형식 오류");
  int count=Num(data,end+10,2),cursor=Num(data,end+16,4),start=cursor,total=0;
  if(count<1||count>=300||count!=Num(data,end+8,2)||cursor+Num(data,end+12,4)!=end)throw Error("ZIP 목록 오류");
  var names=new HashSet<string>(StringComparer.OrdinalIgnoreCase);
  for(int i=0;i<count;i++){
   if(Num(data,cursor,4)!=0x02014b50)throw Error("ZIP 항목 오류");
   int method=Num(data,cursor+10,2),len=Num(data,cursor+28,2),local=Num(data,cursor+42,4);
   // External attrs may set the high bit; read only the UNIX mode half.
   int mode=Num(data,cursor+40,2)&0xf000;
   if((Num(data,cursor+8,2)&1)!=0||(method!=0&&method!=8)||len<1||cursor+46+len>end||(mode!=0&&mode!=0x8000))throw Error("지원하지 않는 ZIP 항목");
   string name=Encoding.UTF8.GetString(data,cursor+46,len);
   if(!Regex.IsMatch(name,@"^[A-Za-z0-9][A-Za-z0-9_./-]*$")||name.Split('/').Any(p=>p==".."||p=="."||p==""||p.EndsWith(".")||Regex.IsMatch(p,@"^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)",RegexOptions.IgnoreCase))||!names.Add(name))throw Error("허용되지 않는 ZIP 경로");
   if(Num(data,local,4)!=0x04034b50||Num(data,local+26,2)!=len||local+30+len+Num(data,local+28,2)+Num(data,cursor+20,4)>start||Encoding.UTF8.GetString(data,local+30,len)!=name)throw Error("ZIP 경로 정보 불일치");
   total+=Num(data,cursor+24,4);if(total>32000000)throw Error("압축 해제 크기 초과");
   cursor+=46+len+Num(data,cursor+30,2)+Num(data,cursor+32,2);
  }
  if(cursor!=end||!names.Contains("manifest.json")||!names.Contains("background.js"))throw Error("설치 파일 누락");return names;
 }
 static IEnumerable<string> Strings(Dictionary<string,object> d,string key){return d.ContainsKey(key)?((System.Collections.IEnumerable)d[key]).Cast<object>().Select(Convert.ToString):new string[0];}
 // Windows cannot atomically swap two non-empty directories. Persist the intent
 // before moving anything; on a failed move restore the backup. An interrupted
 // process can be recovered by launching this installer again.
 public static void Recover(string journal){
  if(!File.Exists(journal))return;var j=Read(journal);string dest=Get(j,"destination"),backup=Get(j,"backup"),stage=Get(j,"stage");
  if(!Directory.Exists(dest)&&Directory.Exists(backup))Directory.Move(backup,dest);
  if(!Directory.Exists(dest))throw Error("복구할 설치 폴더가 없습니다. 이전 백업을 확인하세요.");
  Manifest(dest);File.Delete(journal);
 }
 public static string Install(byte[] data,string digest,string version,string dest,string journal,Action<string> afterMove=null){
  Recover(journal);ValidateDestination(dest);if(Hash(data)!=digest)throw Error("ZIP 해시 불일치");var names=ValidateZip(data);
  string parent=Path.GetDirectoryName(dest),stage=Path.Combine(parent,".dico-stage-"+Guid.NewGuid()),backup=Path.Combine(parent,".dico-previous-"+Guid.NewGuid());Directory.CreateDirectory(stage);
  bool moved=false;
  try{
   using(var zip=new ZipArchive(new MemoryStream(data),ZipArchiveMode.Read)){
    long total=0;foreach(var entry in zip.Entries){
     string path=Path.Combine(stage,entry.FullName.Replace('/',Path.DirectorySeparatorChar));Directory.CreateDirectory(Path.GetDirectoryName(path));
     using(var input=entry.Open())using(var output=new FileStream(path,FileMode.CreateNew)){
      byte[] buffer=new byte[8192];int n;while((n=input.Read(buffer,0,buffer.Length))>0){total+=n;if(total>32000000)throw Error("압축 해제 크기 초과");output.Write(buffer,0,n);}
     }
    }
   }
   var fresh=Manifest(stage);if(Get(fresh,"version")!=version)throw Error("ZIP 버전 불일치");var old=Manifest(dest);
   foreach(string key in new[]{"permissions","host_permissions"})if(Strings(fresh,key).Except(Strings(old,key)).Any())throw Error("새 필수 권한이 있어 수동 업데이트가 필요합니다.");
   Write(journal,new{destination=dest,backup=backup,stage=stage});
   Directory.Move(dest,backup);moved=true;if(afterMove!=null)afterMove(backup);
   Directory.Move(stage,dest);File.Delete(journal);return backup;
  }catch{
   if(moved&&!Directory.Exists(dest)&&Directory.Exists(backup)){try{Directory.Move(backup,dest);File.Delete(journal);}catch{throw Error("복구가 대기 중입니다. DICO 보조 설치 프로그램을 다시 실행해 주세요.");}}
   else if(!moved&&File.Exists(journal))File.Delete(journal);
   throw;
  }finally{if(Directory.Exists(stage)&&!File.Exists(journal))Directory.Delete(stage,true);}
 }
 static byte[] Fetch(string url){
  ServicePointManager.SecurityProtocol=SecurityProtocolType.Tls12;
  for(int i=0;i<6;i++){
   var uri=new Uri(url);if(uri.Scheme!="https"||!new[]{"github.com","api.github.com","release-assets.githubusercontent.com","objects.githubusercontent.com"}.Contains(uri.Host))throw Error("허용되지 않는 다운로드 주소");
   var req=(HttpWebRequest)WebRequest.Create(uri);req.UserAgent="DicoUpdater/1";req.AllowAutoRedirect=false;req.Timeout=45000;req.ReadWriteTimeout=45000;
   using(var response=(HttpWebResponse)req.GetResponse()){
    if((int)response.StatusCode>=300&&(int)response.StatusCode<400){url=new Uri(uri,response.Headers["Location"]).AbsoluteUri;continue;}
    if(response.StatusCode!=HttpStatusCode.OK)throw Error("GitHub 다운로드 실패");
    using(var input=response.GetResponseStream())using(var output=new MemoryStream()){
     byte[] buffer=new byte[8192];int n;while((n=input.Read(buffer,0,buffer.Length))>0){if(output.Length+n>16000000)throw Error("다운로드 크기 초과");output.Write(buffer,0,n);}return output.ToArray();
    }
   }
  }throw Error("다운로드 이동 횟수 초과");
 }
 static object Update(string dest,string current){
  string installed=Get(Manifest(dest),"version");if(Ver(installed)>Ver(current))return new{ok=true,updated=true,version=installed};
  var release=Parse(Encoding.UTF8.GetString(Fetch("https://api.github.com/repos/JangKroed/dico-chat-while/releases/latest")));
  string tag=Get(release,"tag_name");if(Get(release,"draft")!="False"||Get(release,"prerelease")!="False"||!tag.StartsWith("v"))throw Error("정식 릴리즈 정보 오류");
  string version=tag.Substring(1);if(Ver(version)<=Ver(installed))return new{ok=true,updated=false,version=installed};
  string name="dico-while-"+version+".zip",url=Repo+"/releases/download/"+tag+"/"+name;
  var assets=((System.Collections.IEnumerable)release["assets"]).Cast<Dictionary<string,object>>();
  var asset=assets.FirstOrDefault(a=>Get(a,"name")==name&&Get(a,"browser_download_url")==url);
  if(asset==null||!Regex.IsMatch(Get(asset,"digest"),@"^sha256:[0-9a-f]{64}$"))throw Error("검증 가능한 ZIP이 없습니다.");
  Install(Fetch(url),Get(asset,"digest"),version,dest,Path.Combine(Support,"transaction.json"));return new{ok=true,updated=true,version=version};
 }
 static void Setup(){
  Directory.CreateDirectory(Support);
  using(var updateLock=new FileStream(Path.Combine(Support,"update.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None)){
   Recover(Path.Combine(Support,"transaction.json"));
   var form=new Form{Text="DICO 자동 업데이트 연결",Width=530,Height=230,StartPosition=FormStartPosition.CenterScreen};
   var label=new Label{Left=15,Top=15,Width=490,Height=80,Text="0.2.41 이상 확장을 먼저 설치하고 모두 중지하세요.\n확장 관리 화면의 DICO ID(32자리)를 입력하세요.\n브라우저·프로필별 별도 설치 폴더를 사용하세요."};
   var idInput=new TextBox{Left=15,Top=100,Width=480};var button=new Button{Left=15,Top=140,Width=230,Text="기존 설치 폴더 선택 및 연결"};form.Controls.AddRange(new Control[]{label,idInput,button});
   button.Click+=(s,e)=>{try{
    string id=idInput.Text.Trim();if(!Regex.IsMatch(id,@"^[a-p]{32}$"))throw Error("확장 ID를 확인하세요.");
    using(var dialog=new FolderBrowserDialog{Description="현재 확장에 등록된 manifest.json이 있는 폴더"}){
     if(dialog.ShowDialog()!=DialogResult.OK)return;string dir=Path.GetFullPath(dialog.SelectedPath);ValidateDestination(dir);if(Ver(Get(Manifest(dir),"version"))<Ver("0.2.41"))throw Error("먼저 0.2.41 이상으로 한 번 업데이트하세요.");
     string configPath=Path.Combine(Support,"config.json");var config=File.Exists(configPath)?Read(configPath):new Dictionary<string,object>();
     if(config.Any(pair=>pair.Key!=id&&String.Equals(Convert.ToString(pair.Value),dir,StringComparison.OrdinalIgnoreCase)))throw Error("다른 확장에 연결된 폴더입니다.");config[id]=dir;
     // Versioned helper executables avoid overwriting a running Windows process.
     string binary=Path.Combine(Support,"dico-updater-1.exe"),source=System.Reflection.Assembly.GetExecutingAssembly().Location;
     if(!String.Equals(source,binary,StringComparison.OrdinalIgnoreCase))File.Copy(source,binary,true);Write(configPath,config);
     string hostPath=Path.Combine(Support,Host+".json");Write(hostPath,new{name=Host,description="DICO verified release updater",path=binary,type="stdio",allowed_origins=config.Keys.Select(k=>"chrome-extension://"+k+"/").ToArray()});
     foreach(string browser in new[]{@"Software\Google\Chrome",@"Software\BraveSoftware\Brave-Browser"})using(var key=Registry.CurrentUser.CreateSubKey(browser+@"\NativeMessagingHosts\"+Host))key.SetValue("",hostPath);
     MessageBox.Show("설치 완료. DICO 패널에서 ‘보조 프로그램 연결 / 자동 적용 켜기’를 누르세요.");form.Close();
    }
   }catch(Exception ex){MessageBox.Show(ex.Message,"설치 안내");}};Application.Run(form);
  }
 }
 static object Native(string origin){
  if(!Regex.IsMatch(origin,@"^chrome-extension://[a-p]{32}/$"))throw Error("허용되지 않은 호출");
  string id=origin.Substring(19,32);var config=Read(Path.Combine(Support,"config.json"));if(!config.ContainsKey(id))throw Error("연결되지 않은 확장 ID입니다.");
  using(var reader=new BinaryReader(Console.OpenStandardInput(),Encoding.UTF8)){
   int size=reader.ReadInt32();if(size<1||size>4096)throw Error("메시지 크기 오류");byte[] bytes=reader.ReadBytes(size);if(bytes.Length!=size)throw Error("메시지 연결 종료");var request=Parse(Encoding.UTF8.GetString(bytes));
   using(var updateLock=new FileStream(Path.Combine(Support,"update.lock"),FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None)){
    Recover(Path.Combine(Support,"transaction.json"));string dir=Convert.ToString(config[id]);ValidateDestination(dir);
    if(Get(request,"operation")=="probe")return new{ok=true,helperVersion=1,installedVersion=Get(Manifest(dir),"version")};
    if(Get(request,"operation")!="update")throw Error("지원하지 않는 요청");return Update(dir,Get(request,"currentVersion"));
   }
  }
 }
 [STAThread] public static void Main(string[] args){
  if(args.Length>0&&args[0].StartsWith("chrome-extension://")){
   object result;try{result=Native(args[0]);}catch(Exception ex){result=new{ok=false,error=ex is WebException?"GitHub 다운로드에 실패했습니다. 다음에 다시 시도하세요.":ex.Message};}
   byte[] data=Encoding.UTF8.GetBytes(JSON.Serialize(result));using(var writer=new BinaryWriter(Console.OpenStandardOutput())){writer.Write(data.Length);writer.Write(data);}
  }else{Application.EnableVisualStyles();try{Setup();}catch(Exception ex){MessageBox.Show(ex.Message,"DICO 설치 안내");}}
 }
}
