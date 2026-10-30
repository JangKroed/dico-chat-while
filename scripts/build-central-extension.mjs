import {copyFile,mkdir} from 'node:fs/promises';
await mkdir(new URL('../central/extension/',import.meta.url),{recursive:true});
for(const file of ['content.js','emoji-data.js'])await copyFile(new URL('../'+file,import.meta.url),new URL('../central/extension/'+file,import.meta.url));
console.log('DICO 중앙 실행기용 content/emoji 파일 준비 완료');
