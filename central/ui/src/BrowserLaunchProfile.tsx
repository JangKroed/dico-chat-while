import { useEffect, useState } from 'react'
import { getBrowserPreparation, type Instance } from './api'

const states: Record<string, string> = {
  opening: '브라우저 여는 중',
  waiting_connection: '확장 연결과 로그인 확인 중',
  waiting_account: '로그인 계정 확인 대기',
  profile_missing: 'DICO가 설치된 프로필을 찾는 중',
  launch_failed: '브라우저 열기를 자동으로 다시 시도합니다',
}

export function BrowserLaunchProfile({instance}: {instance: Instance}) {
  const [progress, setProgress] = useState('')
  useEffect(() => {
    let current = true
    const refresh = () => void getBrowserPreparation().then(data => {
      if(current) setProgress(data.preparation.find(item => item.instanceId === instance.id)?.state || '')
    }).catch(() => {})
    refresh()
    const timer = setInterval(refresh, 5000)
    return () => {current = false; clearInterval(timer)}
  }, [instance.id])
  return progress ? <small role="status">{states[progress] || '연결 준비 중'}</small> : null
}
