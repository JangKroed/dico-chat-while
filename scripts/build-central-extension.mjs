import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {fingerprintExtension} from '../central/host/extension-update.mjs';
const directory=new URL('../central/extension/',import.meta.url);
await mkdir(directory,{recursive:true});
const source=await readFile(new URL('../content.js',import.meta.url),'utf8');
// The content build marker is excluded from the digest to avoid a circular hash.
await writeFile(new URL('content.js',directory),source);
await writeFile(new URL('emoji-data.js',directory),await readFile(new URL('../emoji-data.js',import.meta.url)));
const buildId=await fingerprintExtension(fileURLToPath(directory));
await writeFile(new URL('build-info.js',directory),`export const BUILD_ID = '${buildId}';\n`);
await writeFile(new URL('content.js',directory),source.replace("const CONTENT_BUILD_ID = 'unmanaged';",`const CONTENT_BUILD_ID = '${buildId}';`));
console.log('DICO 중앙 실행기 content/emoji 및 빌드 식별자 준비 완료');
