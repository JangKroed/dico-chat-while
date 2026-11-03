import type {Channel,Snapshot} from './api'
// 채널 초안은 사용자가 고른 메시지 ID·순서·주기만 소유합니다. 서버가 최신
// 문구를 반영하며 바꾸는 revision/config 번호는 편집 충돌이나 dirty가 아닙니다.
export function channelMessagesChanged(draft:string[],c:Channel){return JSON.stringify(draft)!==JSON.stringify(c.playlist.map(p=>p.messageId))}
export function messageSyncLabel(c:Channel,s:Pick<Snapshot,'messages'>){
 if(c.playlist.some(p=>s.messages.find(m=>m.id===p.messageId)?.revisionId!==p.revisionId))return '다음 발송에 자동 반영 대기'
 return c.configVersion===c.appliedVersion?'자동 반영 완료':'브라우저 동기화 대기'
}
