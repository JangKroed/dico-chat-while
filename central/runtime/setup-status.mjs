import {readFile,access} from 'node:fs/promises';
import {join,win32} from 'node:path';
import {homedir} from 'node:os';
import {execFile} from 'node:child_process';
import {dataDirectory} from '../host/paths.mjs';

const host='com.dico.manager',extension='chrome-extension://ibkkihhaihlpjcahglnoiphcddcjipgh/';
const exists=async path=>{try{await access(path);return true;}catch{return false;}};
function registry(key) {
  return new Promise((accept,reject)=>execFile('reg.exe',['query',key,'/ve'],{timeout:2500,windowsHide:true,maxBuffer:32768},(error,stdout)=>error?reject(error):accept(stdout)));
}
export async function inspectInstallation({platform=process.platform,home=homedir(),env=process.env,directory=dataDirectory(platform,home,env),uiDirectory,snapshot={}}={}) {
  const path=platform==='win32'?win32:{join},checks=[];
  const add=(id,label,status,detail,nextStep)=>checks.push({id,label,status,detail,...(nextStep?{nextStep}:{})});
  const packageInfo=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  add('app-version','관리 프로그램 버전','ok',`DICO ${packageInfo.version}`);
  add('runtime','관리 프로그램 런타임',/^24\.(?:1[3-9]|[2-9]\d)\.\d+$/.test(process.versions.node)?'ok':'error',`실행 중인 Node ${process.versions.node} · ${process.arch}`,'오류가 있으면 지원되는 Node 24.13 이상 24.x로 다시 패키징하세요.');
  const uiReady=Boolean(uiDirectory)&&await exists(path.join(uiDirectory,'index.html'));
  add('ui','중앙 화면 빌드',uiReady?'ok':'error',uiReady?'화면 빌드 파일이 있습니다.':'화면 빌드 파일이 없습니다.','클론 폴더에서 자동 설정을 다시 실행하세요.');
  const app=path.join(directory,'app'),launcher=path.join(app,platform==='win32'?'launcher.exe':'launcher');
  const expectedManifest=path.join(app,`${host}.json`);
  for(const [id,label,browser] of [['chrome','Chrome','Google/Chrome'],['brave','Brave','BraveSoftware/Brave-Browser']]) {
    let file;
    try {
      if(platform==='darwin')file=join(home,'Library/Application Support',browser,'NativeMessagingHosts',`${host}.json`);
      else if(platform==='win32') {
        const key=`HKCU\\Software\\${browser.replaceAll('/','\\')}\\NativeMessagingHosts\\${host}`;
        const output=await registry(key);
        const value=output.match(/REG_SZ\s+([^\r\n]+)/)?.[1]?.trim();
        if(!value||value.toLowerCase()!==expectedManifest.toLowerCase())throw Error('등록 경로 불일치');
        file=expectedManifest;
      } else {add(`host-${id}`,`${label} 연결 등록`,'warning','지원 OS가 아닙니다.');continue;}
      if(!await exists(file)){add(`host-${id}`,`${label} 연결 등록`,'warning','이 OS 사용자의 네이티브 호스트 등록이 없습니다.','이 브라우저를 사용한다면 자동 설정의 설치 단계를 실행하세요.');continue;}
      const manifest=JSON.parse(await readFile(file,'utf8'));
      const correct=manifest.name===host&&manifest.type==='stdio'&&manifest.path===launcher&&Array.isArray(manifest.allowed_origins)&&manifest.allowed_origins.length===1&&manifest.allowed_origins[0]===extension&&await exists(launcher);
      add(`host-${id}`,`${label} 연결 등록`,correct?'ok':'error',correct?'전용 확장 ID와 설치 런처 등록을 확인했습니다. 실제 연결 여부는 아래에서 별도로 확인합니다.':'등록 내용 또는 런처 파일이 올바르지 않습니다.','관리 프로그램을 정상 종료한 뒤 자동 설정으로 다시 설치하세요.');
    }catch{add(`host-${id}`,`${label} 연결 등록`,'warning','등록을 확인하지 못했습니다. 브라우저 설치 여부를 의미하지는 않습니다.','이 브라우저를 사용한다면 설치 등록과 Windows 사용자 권한을 확인하세요.');}
  }
  const connected=(snapshot.instances||[]).filter(x=>x.connected).length;
  add('browser-link','실제 확장 연결',connected?'ok':'warning',`${connected}개 실행기가 현재 연결되어 있습니다. 다른 프로필의 설치 여부는 알 수 없습니다.`,'새 확장을 등록하고 관리 프로그램 다시 연결을 누르세요.');
  const channels=snapshot.channels||[],applied=channels.filter(x=>x.verified&&x.playlist?.length>0&&x.configVersion===x.appliedVersion).length;
  add('channel-apply','계정·채널 설정 적용',channels.length&&applied===channels.length?'ok':'warning',`${channels.length}개 채널 중 ${applied}개가 검증 및 적용 완료 상태입니다.`,'계정·채널을 연결하고 사용할 문구를 적용하세요.');
  add('legacy-stop','기존 실행기 중지 확인','warning','다른 확장과 다른 PC의 발송 중지는 자동 검증할 수 없습니다.','기존 자동 적용과 발송을 중지하고 모든 프로필에서 기존 확장을 비활성화하세요.');
  return{checkedAt:Date.now(),checks,ready:!checks.some(c=>c.status==='error')&&checks.some(c=>c.id.startsWith('host-')&&c.status==='ok')&&connected>0&&channels.length>0&&applied===channels.length};
}
