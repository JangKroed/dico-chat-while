import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {runUpdateWorker} from '../central/runtime/updater.mjs';

// The authenticated manager creates this private job; this is not a repository updater.
export async function updateCentral(args=process.argv.slice(2)) {
  if(args.length!==2||args[0]!=='--job')throw Error('중앙 관리 화면의 설정 → 업데이트에서 실행하세요.');
  await runUpdateWorker(resolve(args[1]));
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)updateCentral().catch(()=>{console.error('업데이트 작업을 실행하지 못했습니다. 중앙 관리 화면에서 상태를 확인하세요.');process.exitCode=1;});
