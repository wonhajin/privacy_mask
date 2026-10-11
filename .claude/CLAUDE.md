# CLAUDE.md

Claude Code mod(함수 훅 플러그인). 진입점은 `hooks/register.ts`의 `register`, 마스킹 로직은 같은 파일의 `maskText`.

## 함정

- **공개 레포다.** 실제 환경에서 가져온 키 이름·로그·설정 조각·시스템명을 코드·테스트·커밋 메시지에 넣지 않는다. 테스트 데이터는 범용 이름(`db.password`, `orderApiToken` 등)과 직접 만든 값으로 쓴다.
- **규칙 순서가 결과를 바꾼다.** 비밀값 → 키로 찾은 값 전체 치환 → 개인정보 → IP 순이며, 앞 단계가 넣은 `[..#n]` 자리표시자를 뒤 규칙이 건드리지 않는 것을 전제로 한다. 규칙을 추가할 때 위치를 먼저 정한다.
- 모듈은 Node가 아닌 별도 런타임에서 돈다. 파일·프로세스 접근은 `$.fs`·`$.process`로만 한다.

## 명령

- `claude plugin validate .claude-plugin/plugin.json` — 매니페스트·훅·`$.state` 계약 검사. `validate .`는 marketplace.json만 보고 통과하므로 이걸로는 플러그인이 검사되지 않는다
- `claude plugin validate .` — 마켓플레이스 매니페스트 검사
- `claude plugin test .` — 테스트
