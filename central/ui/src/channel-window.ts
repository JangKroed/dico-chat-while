import type {Channel,Snapshot} from './api'
import {browserOnline} from './onboarding.ts'

const verificationReasons:Record<string,{title:string;action:string}>={
  awaiting_observation:{title:'채널 확인 대기',action:'브라우저와 확장의 실제 계정·채널 확인 응답을 기다리고 있습니다.'},
  connection_lost:{title:'브라우저 연결 끊김',action:'브라우저와 확장을 다시 연결하고 전송 창을 확인해 주세요.'},
  session_changed:{title:'브라우저 세션 변경',action:'확장을 다시 연결하고 채널의 계정·대상을 확인해 주세요.'},
  tab_missing:{title:'전송 탭을 찾을 수 없음',action:'채널 설정에서 해당 계정을 다시 연결해 주세요.'},
  tab_loading:{title:'전송 탭 로딩 중',action:'Discord 탭이 로드된 뒤 확장의 확인 응답을 기다려 주세요.'},
  script_unavailable:{title:'확장 응답 없음',action:'브라우저의 DICO 확장과 Discord 탭을 확인하고 탭을 새로고침해 주세요.'},
  account_mismatch:{title:'로그인 계정 다름',action:'전송 창의 로그인 계정을 확인하고 해당 계정을 다시 등록·연결해 주세요.'},
  target_mismatch:{title:'전송 채널 다름',action:'전송 창의 채널을 확인하고 채널 설정에서 다시 연결해 주세요.'},
  identity_unverified:{title:'계정 확인 실패',action:'Discord를 새로고침한 뒤 계정 메뉴를 닫고 계정을 다시 등록해 주세요.'},
  content_refresh_required:{title:'Discord 탭 새로고침 필요',action:'전송 창을 표시해 Discord 탭을 새로고침하고 확인 응답을 기다려 주세요.'},
  unknown:{title:'연결 상태 확인 필요',action:'브라우저와 확장을 확인하고 채널 설정에서 연결 상태를 확인해 주세요.'}
}

export function channelVerification(channel:Pick<Channel,'verified'|'verificationReason'>|undefined):{title:string;action:string} {
  if(channel?.verified)return {title:'연결 검증됨',action:'실제 로그인 계정과 채널을 확인했습니다.'}
  return verificationReasons[channel?.verificationReason||'unknown']||verificationReasons.unknown
}

export function managedWindowAvailable(s:Snapshot,channel:Channel|undefined):boolean {
  const browser=s.instances.find(instance=>instance.id===channel?.instanceId)
  return Boolean(channel?.id&&Number.isInteger(channel.tabId)&&browserOnline(browser)&&Array.isArray(browser?.capabilities)&&browser.capabilities.includes('managed-window-v1'))
}

// Never guess a target window from a group, account, or channel ID. A record
// can refer to an old or different binding that happens to share those values.
export function exactRecordedBinding(s:Snapshot,record:{bindingId?:string;attemptId?:string}):Channel|undefined {
  const id=record.bindingId||s.attempts.find(attempt=>attempt.id===record.attemptId)?.bindingId
  return id?s.channels.find(channel=>channel.id===id):undefined
}
