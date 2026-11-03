# 0.4.28 사전 빌드 업데이트

수신자 macOS의 여섯 업데이트에서 esbuild 0.25.12 다운로드는 HTTP 200으로 성공했지만 postinstall의 esbuild --version이 SIGKILL로 종료됐다. macOS 검증 불가 팝업도 확인됐다. 구체적인 OS 종료 정책은 확정되지 않았다.

사용자 기기에서 빌드 도구를 설치하고 실행하던 의존성을 제거했다. 기존 updater의 npm --prefix central/ui ci → npm run central:build → npm run central:check 명령을 그대로 지원한다. central/ui 패키지는 의존성과 설치 훅이 없고 build는 저장소에 포함된 ui/dist를 검사한다. 기존 사용자에게 재설치나 보안 설정 변경을 요구하지 않는다.

업데이트의 실행 중지 확인, 기존 파일 보존, 승인 검증, 교체 및 실패 시 복원은 기존 updater가 그대로 수행한다. Git과 기존 번들 Node/npm은 계속 필요하다. 사용자 설정·기록 데이터는 변경하지 않는다.

## 개발 및 배포
개발 도구는 central/package.json 및 central/package-lock.json에만 둔다.

```sh
npm --prefix central ci
npm run central:compile
npm run central:build
npm run central:check
npm test
```

UI를 수정하면 central:compile로 다시 생성하고 central/ui/dist 및 central/ui/prebuilt.json을 소스와 함께 커밋한다. central:build는 더 이상 TypeScript를 컴파일하지 않는다. 개발 서버는 기존 npm --prefix central/ui run dev로 실행한다.

SHA256 목록은 소스와 빌드 파일의 누락·변경·오래된 조합을 감지한다. 서명된 배포물의 진위 검증을 대신하지 않으며 기존 HTTPS GitHub 저장소 신뢰 경계를 유지한다. LF 체크아웃 속성으로 Windows에서도 같은 파일 바이트를 검사한다.

CI는 개발 의존성 설치 전 구버전 호환 경로를 검증하고 개발용 빌드 후 커밋된 산출물과 일치하는지 검사하며 전체 테스트를 수행한다. 초기 설치 도구는 사용자 기기에 개발용 테스트 의존성을 요구하지 않도록 개발 테스트 단계를 제외하되 파일 검사와 안전 사전 검사를 유지한다.

수신자 실제 Mac에서 업데이트 버튼으로 0.4.28 표시까지 확인하는 것은 별도 현장 검증이다.
