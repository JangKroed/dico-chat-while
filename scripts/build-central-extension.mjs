import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {fingerprintExtension} from '../central/host/extension-update.mjs';
const directory=new URL('../central/extension/',import.meta.url);
await mkdir(directory,{recursive:true});
// 관리 프로그램 버전을 단일 원본으로 사용한다. 확장 manifest의 버전이 오래되어도
// 코드만 새로 빌드하고 구버전 번호를 계속 배포하던 문제를 빌드 단계에서 차단한다.
// key, icons, permissions 등 확장의 정체성과 설정은 원본 그대로 보존한다.
const version=JSON.parse(await readFile(new URL('../central/package.json',import.meta.url),'utf8')).version;
if(typeof version!=='string'||!/^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*)){2,3}$/.test(version)||version.split('.').some(part=>Number(part)>65535)||version.split('.').every(part=>Number(part)===0))throw Error('관리 프로그램 버전이 Chrome 확장 버전 형식과 맞지 않습니다.');
const manifest=JSON.parse(await readFile(new URL('manifest.json',directory),'utf8'));
await writeFile(new URL('manifest.json',directory),JSON.stringify({...manifest,version},null,2)+'\n');
const source=(await readFile(new URL('../content.js',import.meta.url),'utf8')).replace(/const CONTENT_VERSION = '[^']+';/,`const CONTENT_VERSION = '${version}';`);
// The content build marker is excluded from the digest to avoid a circular hash.
await writeFile(new URL('content.js',directory),source);
await writeFile(new URL('emoji-data.js',directory),await readFile(new URL('../emoji-data.js',import.meta.url)));
const buildId=await fingerprintExtension(fileURLToPath(directory));
await writeFile(new URL('build-info.js',directory),`export const BUILD_ID = '${buildId}';\n`);
await writeFile(new URL('content.js',directory),source.replace("const CONTENT_BUILD_ID = 'unmanaged';",`const CONTENT_BUILD_ID = '${buildId}';`));
console.log('DICO 중앙 실행기 content/emoji 및 빌드 식별자 준비 완료');
