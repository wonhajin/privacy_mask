import { expect, mock, test } from 'claude-code/testing'

// 테스트 환경은 env·fs를 직접 답하지 않는다 (훅이 없으면 예외). 홈과 설정 파일을 흉내 낸다. file이 없으면 파일 없음
const HOME = '/home/tester'
const FILE = `${HOME}/.claude/privacy-mask.json`
const fakeHome = (on: any, file?: string) => {
  on('env.get', (_$: any, e: any) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('fs.exists', (_$: any, e: any) => ({ value: file !== undefined && e.path === FILE }))
  on('fs.read', (_$: any, e: any) => {
    if (file === undefined || e.path !== FILE) throw new Error('ENOENT')
    return { value: file }
  })
}

// 각 텍스트를 차례로 제출하고, 플러그인을 거쳐 엔진에 닿은 텍스트를 돌려준다
const submitAll = async ($: any, on: any, texts: string[], file?: string) => {
  fakeHome(on, file)
  const seen: string[] = []
  on('prompt.submit', (_$: any, e: any) => {
    seen.push(e.text)
    return { text: e.text }
  })
  for (const text of texts) await $.prompt.submit({ text })
  return seen
}

const ALL = { scope: '전체' }

test('개인정보: 주민번호는 전부, 나머지는 뒷자리만 남긴다', { options: ALL }, async ($, on) => {
  const [seen] = await submitAll($, on, [
    'rrn=900101-1234567 tel=010-1234-5678 mail=hong@test.co.kr card=4111-1111-1111-1111 acct=110-123-456789',
  ])
  expect(seen).toBe(
    'rrn=[주민번호#1] tel=[전화번호#1] 010-••••-5678 mail=[이메일#1] ••••@test.co.kr card=[카드번호#1] ••••-1111 acct=[계좌번호#1] 11•-•••-••••89',
  )
})

test('같은 값은 같은 번호 (구분자 차이 무시), 번호는 프롬프트마다 1부터', async ($, on) => {
  const seen = await submitAll($, on, [
    'a=010-1234-5678 b=010-9999-0000 c=01012345678',
    'd=010-9999-0000',
  ])
  expect(seen).toEqual([
    'a=[전화번호#1] 010-••••-5678 b=[전화번호#2] 010-••••-0000 c=[전화번호#1] 010-••••-5678',
    'd=[전화번호#1] 010-••••-0000',
  ])
})

test('비밀값: 키 이름 key=value · key: "value", username류는 제외', async ($, on) => {
  const [seen] = await submitAll($, on, [
    'db.password=abc123 app.login.adminpw=x1 Db_Username=dbuser orderApiToken: "tok123" payment_client_id=cid username=hong',
  ])
  expect(seen).toBe(
    'db.password=[db.password#1] app.login.adminpw=[app.login.adminpw#1] Db_Username=dbuser orderApiToken: "[orderApiToken#1]" payment_client_id=[payment_client_id#1] username=hong',
  )
})

test('비밀값: 키로 찾은 값은 키 없이 다시 나와도 같은 라벨로 가리고, 짧은 값은 전체 치환하지 않는다', async ($, on) => {
  const [seen] = await submitAll($, on, [
    'API_TOKEN=abc123xyz url=/api/send?t=abc123xyz other_token=abc123xyz flag_pw=Y Y',
  ])
  expect(seen).toBe(
    'API_TOKEN=[API_TOKEN#1] url=/api/send?t=[API_TOKEN#1] other_token=[API_TOKEN#1] flag_pw=[flag_pw#1] Y',
  )
})

test('비밀값: 공백뿐인 값은 가리지 않고, 들여쓰기를 프롬프트 전체에서 치환하지 않는다', async ($, on) => {
  const text = '<entry key="password">\n        <value>pw</value>\n</entry>\n<bean>\n        <prop>x</prop>\n</bean>'
  const [seen] = await submitAll($, on, [text])
  expect(seen).toBe(text)
})

test('비밀값: 전체 치환은 다른 숫자·단어의 일부를 건드리지 않는다', async ($, on) => {
  const [seen] = await submitAll($, on, ['pw=123456 ts=1760123456000 q=123456&x=1'])
  expect(seen).toBe('pw=[pw#1] ts=1760123456000 q=[pw#1]&x=1')
})

test('비밀값: 전체 치환은 이미 넣은 자리표시자·키 이름·태그 이름을 건드리지 않는다', async ($, on) => {
  const [seen] = await submitAll($, on, [
    'password=password <password>x</password> "password": "q" log password',
  ])
  // XML 규칙이 key=value 보다 먼저 돌아 태그 안 값이 #1 이다
  expect(seen).toBe(
    'password=[password#2] <password>[password#1]</password> "password": "[password#3]" log [password#2]',
  )
})

test('비밀값: 전체 치환은 key="…" · name="…" 속성의 키 이름을 건드리지 않는다', async ($, on) => {
  const [seen] = await submitAll($, on, [
    'password=password <entry key="password">\n  <v/>\n</entry> <property name="password" value="password"/>',
  ])
  expect(seen).toBe(
    'password=[password#1] <entry key="password">\n  <v/>\n</entry> <property name="password" value="[password#1]"/>',
  )
})

test('비밀값: XML 설정 3형식', async ($, on) => {
  const [seen] = await submitAll($, on, [
    '<property name="password" value="pw1"/> <entry key="oauth_client_secret">sec</entry> <apiKey>chk</apiKey> <property name="url" value="u"/>',
  ])
  expect(seen).toBe(
    '<property name="password" value="[password#1]"/> <entry key="oauth_client_secret">[oauth_client_secret#1]</entry> <apiKey>[apiKey#1]</apiKey> <property name="url" value="u"/>',
  )
})

test('비밀값: Authorization 헤더 · JDBC 접속 문자열 · Jasypt ENC · JWT', { options: ALL }, async ($, on) => {
  const [seen] = await submitAll($, on, [
    'Authorization: Bearer abcdefghijklmnop.qrs jdbc:oracle:thin:scott/tiger@10.20.30.40:1521:ORCL pw=ENC(xyz123) jwt eyJhbGciOi.eyJzdWIiOi.sig',
  ])
  expect(seen).toBe(
    'Authorization: Bearer [인증토큰#1] jdbc:oracle:thin:scott/[접속비밀번호#1]@[IP#1] 10.•••.•••.40:1521:ORCL pw=[암호문#1] jwt [JWT#1]',
  )
})

test('IP는 첫·끝 옥텟만 남기고 localhost는 그대로', { options: ALL }, async ($, on) => {
  const [seen] = await submitAll($, on, ['from 192.168.0.1 to 127.0.0.1 at 2026-10-08'])
  expect(seen).toBe('from [IP#1] 192.•••.•••.1 to 127.0.0.1 at 2026-10-08')
})

test('MAC은 첫·끝 바이트만 남기고 구분자·대소문자가 달라도 같은 번호', { options: ALL }, async ($, on) => {
  const [seen] = await submitAll($, on, ['eth0 02:1A:2B:3C:4D:5E wlan 02-1a-2b-3c-4d-5e br 02-00-00-00-00-0a'])
  expect(seen).toBe('eth0 [MAC#1] 02:••:••:••:••:5E wlan [MAC#1] 02-••-••-••-••-5e br [MAC#2] 02-••-••-••-••-0a')
})

test('MAC: 키 이름 바로 뒤의 콜론, 끝에 붙은 콜론·하이픈 단어도 가린다', { options: ALL }, async ($, on) => {
  const [seen] = await submitAll($, on, ['mac:02:1a:2b:3c:4d:5e addr 02:1a:2b:3c:4d:5f: up 02:1a:2b:3c:4d:60-based'])
  expect(seen).toBe(
    'mac:[MAC#1] 02:••:••:••:••:5e addr [MAC#2] 02:••:••:••:••:5f: up [MAC#3] 02:••:••:••:••:60-based',
  )
})

test('MAC 아닌 것: 브로드캐스트·0 주소·IPv6·시각·구분자 섞임·숫자만 있는 날짜는 그대로', { options: ALL }, async ($, on) => {
  const text =
    'ff:ff:ff:ff:ff:ff FF-FF-FF-FF-FF-FF 00:00:00:00:00:00 fe80::1 aa:bb:cc:dd:ee:ff:00:11 fe80::aa:bb:cc:dd:ee:ff aa:bb:cc:dd:ee:ff::1 12:34:56 aa:bb-cc:dd:ee:ff 26-10-08-12-34-56'
  const [seen] = await submitAll($, on, [text])
  expect(seen).toBe(text)
})

test('로그의 날짜·시각·epoch ms·일반 숫자·코드는 그대로 둔다', async ($, on) => {
  const text = '2026-10-08 12:34:56.789 ts=1760000000000 seq=12345 ERR000123 ORA-01403 id=1234567812345678'
  const [seen] = await submitAll($, on, [text])
  expect(seen).toBe(text)
})

test('하이픈으로 이어지는 파일명·문서번호는 계좌로 보지 않는다', async ($, on) => {
  const text =
    'fileName: 10000-0001-0002-1-1-2026-report-final.pdf, doc-110-123-456789 acct=110-123-456789.'
  const [seen] = await submitAll($, on, [text])
  expect(seen).toBe(
    'fileName: 10000-0001-0002-1-1-2026-report-final.pdf, doc-110-123-456789 acct=[계좌번호#1] 11•-•••-••••89.',
  )
})

test('Luhn을 통과해도 카드사 대역(BIN)이 아니면 카드로 보지 않는다', async ($, on) => {
  const [seen] = await submitAll($, on, [
    'job-100-001-1:3100000000000003 / elapsed=34ms card=5555555555554444',
  ])
  expect(seen).toBe('job-100-001-1:3100000000000003 / elapsed=34ms card=[카드번호#1] ••••-4444')
})

test('설정: 파일의 rules로 끈 항목은 가리지 않는다', async ($, on) => {
  const [seen] = await submitAll(
    $,
    on,
    ['tel=01012345678 db.password=abc123 card=4111-1111-1111-1111'],
    '{"rules":{"phone":false,"secret_key":false}}',
  )
  expect(seen).toBe('tel=01012345678 db.password=abc123 card=[카드번호#1] ••••-1111')
})

test('설정: 전체 치환 최소 길이를 바꿀 수 있다', { options: { propagate_min: 3 } }, async ($, on) => {
  const [seen] = await submitAll($, on, ['pw=abc url=/x?t=abc'])
  expect(seen).toBe('pw=[pw#1] url=/x?t=[pw#1]')
})

test('일부 노출: 이메일 아이디·계좌는 앞뒤 2자, 같은 IP는 같은 번호', { options: ALL }, async ($, on) => {
  const [seen] = await submitAll($, on, ['gildong.hong@test.co.kr 10.1.2.3 10.1.2.3 10.1.2.4'])
  expect(seen).toBe(
    '[이메일#1] gi•••••.••ng@test.co.kr [IP#1] 10.•••.•••.3 [IP#1] 10.•••.•••.3 [IP#2] 10.•••.•••.4',
  )
})

test('비밀값: 서비스 토큰은 종류별 라벨', async ($, on) => {
  const aws = 'AKIA' + 'A'.repeat(16)
  const gh = 'ghp_' + 'a'.repeat(36)
  const [seen] = await submitAll($, on, [`k1=${aws} k2=${gh} k3=${aws}`])
  expect(seen).toBe('k1=[AWS키#1] k2=[GitHub토큰#1] k3=[AWS키#1]')
})

test('운전면허·사업자번호는 계좌보다 먼저 구분하고, 체크섬이 틀리면 계좌로 본다', async ($, on) => {
  const [seen] = await submitAll($, on, [
    'lic=11-23-456789-01 old=서울 89-123456-78 biz=123-45-67891 bad=123-45-67890 other=99-23-456789-01',
  ])
  expect(seen).toBe(
    'lic=[운전면허#1] old=[운전면허#2] biz=[사업자번호#1] 12•-••-•••91 bad=[계좌번호#1] 12•-••-•••90 other=[계좌번호#2] 99-••-••••••-01',
  )
})

test('설정: 운전면허를 끄면 계좌 규칙이 잡는다', async ($, on) => {
  const [seen] = await submitAll($, on, ['lic=11-23-456789-01'], '{"rules":{"driver_license":false}}')
  expect(seen).toBe('lic=[계좌번호#1] 11-••-••••••-01')
})

test('비밀값: 추가 서비스 토큰', async ($, on) => {
  const t = {
    google: 'AIza' + 'x'.repeat(35),
    ghPat: 'github_pat_' + 'a'.repeat(22),
    gitlab: 'glpat-' + 'b'.repeat(20),
    stripe: 'sk_live_' + 'c'.repeat(24),
    stripeR: 'rk_test_' + 'd'.repeat(24),
    npm: 'npm_' + 'e'.repeat(36),
    awsTmp: 'ASIA' + 'F'.repeat(16),
    openaiProj: 'sk-proj-' + 'g'.repeat(20),
  }
  const [seen] = await submitAll($, on, [Object.values(t).join(' ')])
  expect(seen).toBe(
    '[Google키#1] [GitHub토큰#1] [GitLab토큰#1] [Stripe키#1] [Stripe키#2] [npm토큰#1] [AWS키#1] [OpenAI키#1]',
  )
})

test('비밀값: 하이픈이 이어지는 sk- 단어는 토큰으로 보지 않는다', async ($, on) => {
  const text = 'pip install sk-learn-model-training-pipeline'
  const [seen] = await submitAll($, on, [text])
  expect(seen).toBe(text)
})

test('비밀값: 웹훅 URL · Azure AccountKey', async ($, on) => {
  const [seen] = await submitAll($, on, [
    'slack https://hooks.slack.com/services/T000/B000/XXXX discord https://discord.com/api/webhooks/123/abc-def az AccountName=demo;AccountKey=kkkkkkkkkkkkkkkkkkkk==;EndpointSuffix=core.windows.net',
  ])
  expect(seen).toBe(
    'slack [웹훅URL#1] discord [웹훅URL#2] az AccountName=demo;AccountKey=[접속비밀번호#1];EndpointSuffix=core.windows.net',
  )
})

test('비밀값: Cookie 헤더는 값 전체, CRLF 다음 줄은 그대로', async ($, on) => {
  const [seen] = await submitAll($, on, ['Cookie: SESSION=abc123; theme=dark\r\nHost: x\n"set-cookie": "a=1"'])
  expect(seen).toBe('Cookie: [쿠키#1]\r\nHost: x\n"set-cookie": "[쿠키#2]"')
})

test('개인정보 키: 이름은 다른 곳에 나와도 가리고, 기술 이름·userName은 건드리지 않는다', async ($, on) => {
  const [seen] = await submitAll($, on, [
    'custName=홍길동 주문자 홍길동 결제 cust_nm=김철수 fileName=a.txt tempName=x userName=hong',
  ])
  expect(seen).toBe(
    'custName=[custName#1] 주문자 [custName#1] 결제 cust_nm=[cust_nm#1] fileName=a.txt tempName=x userName=hong',
  )
})

test('개인정보 키: 생년월일·카드 부가정보, 짧은 숫자는 전체 치환하지 않는다', async ($, on) => {
  const [seen] = await submitAll($, on, [
    'birthDate=19900101 dob=1990-01-01 cvc=123 cardExpiry=12/29 rebirth=yes again 19900101 123',
  ])
  expect(seen).toBe(
    'birthDate=[birthDate#1] dob=[dob#1] cvc=[cvc#1] cardExpiry=[cardExpiry#1] rebirth=yes again [birthDate#1] 123',
  )
})

test('사용자 키: 대소문자·_·- 무시, 마지막 . 뒤 이름도 비교', async ($, on) => {
  const [seen] = await submitAll(
    $,
    on,
    ['sign_key=abcdefgh order.orderMemo=부재시연락 note=부재시연락'],
    '{"keys":["signKey","orderMemo"]}',
  )
  expect(seen).toBe('sign_key=[sign_key#1] order.orderMemo=[order.orderMemo#1] note=[order.orderMemo#1]')
})

test('설정: 개인정보 문자 값 최소 길이 · 생년월일 키 끄기', { options: { propagate_min_text: 4 } }, async ($, on) => {
  const [seen] = await submitAll($, on, ['custName=홍길동 주문자 홍길동 birth=19900101'], '{"rules":{"birth_key":false}}')
  expect(seen).toBe('custName=[custName#1] 주문자 홍길동 birth=19900101')
})

test('제외 구간: ###…### 안은 원문, 구분자는 지운다', async ($, on) => {
  const [seen] = await submitAll($, on, ['###password=abc123### tel=010-1234-5678 ###a b### ###c###'])
  expect(seen).toBe('password=abc123 tel=[전화번호#1] 010-••••-5678 a b c')
})

test('제외 구간: 안의 키 값은 수집하지 않는다', async ($, on) => {
  const [seen] = await submitAll($, on, ['###pw=abcdefg### other abcdefg'])
  expect(seen).toBe('pw=abcdefg other abcdefg')
})

test('제외 구간: 제목·장식선·닫히지 않은 ###은 구분자가 아니다', async ($, on) => {
  const text = '### 제목\npw=abcdef\n#### 소제목\n##########\n###열린'
  const [seen] = await submitAll($, on, [text])
  expect(seen).toBe('### 제목\npw=[pw#1]\n#### 소제목\n##########\n###열린')
})

test('제외 구간: 여러 줄', async ($, on) => {
  const [seen] = await submitAll($, on, ['###line1\npw=abcdef###'])
  expect(seen).toBe('line1\npw=abcdef')
})

test('설정 오류: 설정 파일이 깨졌으면 전송을 막는다', async ($, on) => {
  fakeHome(on, '{')
  const result = await $.prompt.submit({ text: 'hello' })
  expect(result.drop).toBe('privacy-mask: 설정 파일이 올바른 JSON이 아닙니다')
})

test('설정 오류여도 전체를 ###로 감싸면 보낸다', async ($, on) => {
  const [seen] = await submitAll($, on, ['###tel=010-1234-5678###'], '{')
  expect(seen).toBe('tel=010-1234-5678')
})

test('설정 파일의 정규식으로 마스킹한다', async ($, on) => {
  const [seen] = await submitAll($, on, ['id EMP123456'], '{"patterns":[{"label":"사번","regex":"EMP\\\\d{6}"}]}')
  expect(seen).toBe('id [사번#1]')
})

test('제외 구간: 값 한가운데의 ###는 구분자가 아니다', async ($, on) => {
  const [seen] = await submitAll($, on, ['db.password=Ab###Cd9xYz###Q1'])
  expect(seen).toBe('db.password=[db.password#1]')
})

test('키 값이 null·true 같은 리터럴이면 가리지 않는다', async ($, on) => {
  const [seen] = await submitAll($, on, ['{"custName": null, "memo": null, "password": true}'])
  expect(seen).toBe('{"custName": null, "memo": null, "password": true}')
})

test('키 값: 값이 비어 줄이 바뀌면 다음 줄을 값으로 보지 않는다 (YAML 중첩)', async ($, on) => {
  const text = 'auth:\n  enabled: true\npassword:\n  # 주석\n  value: x\ntoken =\nnext'
  const [seen] = await submitAll($, on, [text])
  expect(seen).toBe(text)
})

test('주민번호: 구분자 없는 13자리가 1900~1919년생이면 epoch ms로 보고, 2000년대생이면 가린다', async ($, on) => {
  const [seen] = await submitAll($, on, ['ts=1801231567890 rrn=180123-1567890 kid=1801234567890'])
  expect(seen).toBe('ts=1801231567890 rrn=[주민번호#1] kid=[주민번호#2]')
})

test('비밀값 키: pass·token이 다른 단어의 일부면 비밀값 키가 아니다', async ($, on) => {
  const [seen] = await submitAll($, on, [
    'max_tokens: 4096 test_passed: 15 bypassCache=on compass=n tokenizer=bpe token_count=12 bypass_password=pw9x accessToken=t0k',
  ])
  expect(seen).toBe(
    'max_tokens: 4096 test_passed: 15 bypassCache=on compass=n tokenizer=bpe token_count=12 bypass_password=[bypass_password#1] accessToken=[accessToken#1]',
  )
})

test('비밀값: 자기닫힘 태그 <add key="…" value="…"/> 뒤 텍스트는 값이 아니다', async ($, on) => {
  const [seen] = await submitAll($, on, ['<add key="ApiToken" value="abc123"/> some text here<br>'])
  expect(seen).toBe('<add key="ApiToken" value="[ApiToken#1]"/> some text here<br>')
})

test('비밀값: 접속 문자열 비밀번호의 / 도 가리고, 포트 뒤 경로의 @는 비밀번호로 보지 않는다', async ($, on) => {
  const [seen] = await submitAll($, on, ['postgres://user:ab/cd12@host:5432/db http://localhost:3000/users/hong@test.com'])
  expect(seen).toBe('postgres://user:[접속비밀번호#1]@host:5432/db http://localhost:3000/users/hong@test.com')
})

test('비밀값 키: 코드의 타입 표기·함수 호출·::·==는 가리지 않는다', async ($, on) => {
  const text =
    'interface User { password: string; name: string }\nconst token = getToken();\nAuthError::InvalidToken\nif (token == null) return'
  const [seen] = await submitAll($, on, [text])
  expect(seen).toBe(text)
})

test('키 값: 구분자 뒤 NBSP·전각 공백(복사한 문서·전각 입력)도 공백으로 본다', async ($, on) => {
  const [seen] = await submitAll($, on, ['password:\u00a0hunter2xyz custName:\u3000홍길동'])
  expect(seen).toBe('password:\u00a0[password#1] custName:\u3000[custName#1]')
})

test('비밀값 키: 복수형 토큰 키는 비밀값, 토큰 개수 키는 아니다', async ($, on) => {
  const [seen] = await submitAll($, on, ['api_tokens=Zq8vLr2m GITHUB_TOKENS=Hs3xKp4T num_tokens=12 tokens_used=40'])
  expect(seen).toBe('api_tokens=[api_tokens#1] GITHUB_TOKENS=[GITHUB_TOKENS#1] num_tokens=12 tokens_used=40')
})

test('비밀값 키: := 대입(Makefile·Go)은 공백·따옴표와 상관없이 값을 가린다', async ($, on) => {
  const [seen] = await submitAll($, on, ['DB_PASSWORD:=hunter2xyz\nAPI_TOKEN := abc123xyz\npassword:="pw9876543"'])
  expect(seen).toBe('DB_PASSWORD:=[DB_PASSWORD#1]\nAPI_TOKEN := [API_TOKEN#1]\npassword:="[password#1]"')
})

test('비밀값: IPv6 주소 URL의 경로 @는 접속 비밀번호가 아니다', async ($, on) => {
  const text = 'http://[::1]:8080/users/hong@test.com'
  const [seen] = await submitAll($, on, [text])
  expect(seen).toBe(text)
})

test('개인정보 키: 이름이 타입 이름과 같아도 가린다', async ($, on) => {
  const [seen] = await submitAll($, on, ['custName: Long'])
  expect(seen).toBe('custName: [custName#1]')
})

test('비밀값 키: 인자가 있는 함수 호출도 값으로 보지 않는다', async ($, on) => {
  const text = 'const token = getToken(req);\nconst secret = vault.read(path, opts)'
  const [seen] = await submitAll($, on, [text])
  expect(seen).toBe(text)
})

const BAND = {
  plugin: 'privacy-mask',
  component: 'AbovePrompt',
  props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 80 },
} as const

// 엔진 몫(제출 수신·빈 띠·시계)을 먼저 등록한다. 테스트가 $를 부른 뒤에는 훅을 더할 수 없다
const setupBand = async ($: any, on: any, surface: 'terminal' | 'desktop' = 'terminal') => {
  fakeHome(on)
  const clock = mock.clock(on)
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  on('session.start', (_$: any, e: any) => e)
  on('ui.render', (_$: any, e: any) => {
    const { Box } = _$.ui.resolve(e)
    return h(Box, null)
  })
  const band = await $.ui.mount({ ...BAND, surface })
  const submit = (text: string) => $.prompt.submit({ text })
  const shown = async () => (await band.find({ text: '민감정보' }))?.text
  return { clock, submit, shown }
}

test('알림 집계: 전체 치환된 개인정보 값은 개인정보로 센다', async ($, on) => {
  const { submit, shown } = await setupBand($, on)
  await submit('custName=홍길동 then 홍길동 again')
  expect(await shown()).toContain('개인정보 2')
  expect(await shown()).not.toContain('비밀값')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`알림: 입력창 위에 한 줄로 띄웠다가 5초 뒤 지운다 (${surface})`, async ($, on) => {
    const { clock, submit, shown } = await setupBand($, on, surface)
    expect(await shown()).toBeUndefined()

    await submit('tel=010-1234-5678')
    expect(await shown()).toContain('민감정보 1건 마스킹')

    await clock.advance(4999)
    expect(await shown()).toBeDefined()
    await clock.advance(1)
    expect(await shown()).toBeUndefined()
  })
}

test('알림: 연달아 보내면 마지막 전송부터 5초를 센다', async ($, on) => {
  const { clock, submit, shown } = await setupBand($, on)
  await submit('tel=010-1234-5678')
  await clock.advance(3000)
  await submit('tel=010-1234-5678')
  await clock.advance(3000)
  expect(await shown()).toBeDefined()
  await clock.advance(2000)
  expect(await shown()).toBeUndefined()
})

test('알림: 가린 것이 없으면 띄우지 않는다', async ($, on) => {
  const { submit, shown } = await setupBand($, on)
  await submit('그냥 질문입니다')
  expect(await shown()).toBeUndefined()
})

test('알림: 모듈을 다시 불러오면(session.start) 남아 있던 알림을 지운다', async ($, on) => {
  const { submit, shown } = await setupBand($, on)
  await submit('tel=010-1234-5678')
  expect(await shown()).toBeDefined()
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  expect(await shown()).toBeUndefined()
})

test('범위: 기본(표준)은 이메일·IP·MAC을 가리지 않는다', async ($, on) => {
  const [seen] = await submitAll($, on, ['mail=hong@test.co.kr from 192.168.0.1 02:1a:2b:3c:4d:5e tel=010-1234-5678'])
  expect(seen).toBe('mail=hong@test.co.kr from 192.168.0.1 02:1a:2b:3c:4d:5e tel=[전화번호#1] 010-••••-5678')
})

test('범위: 최소는 전화번호를 두고 주민번호는 가린다', { options: { scope: '최소' } }, async ($, on) => {
  const [seen] = await submitAll($, on, ['tel=010-1234-5678 rrn=900101-1234567'])
  expect(seen).toBe('tel=010-1234-5678 rrn=[주민번호#1]')
})

test('범위: 파일의 rules가 범위보다 우선한다', async ($, on) => {
  const [seen] = await submitAll($, on, ['mail=hong@test.co.kr'], '{"rules":{"email":true}}')
  expect(seen).toBe('mail=[이메일#1] ••••@test.co.kr')
})

test('마스킹 사용을 끄면 설정 파일도 읽지 않고 ###까지 그대로 보낸다', { options: { enabled: false } }, async ($, on) => {
  // fakeHome 없이: 플러그인이 env·fs를 부르면 예외로 막혀 아래 기대가 깨진다
  const seen: string[] = []
  on('prompt.submit', (_$: any, e: any) => {
    seen.push(e.text)
    return { text: e.text }
  })
  await $.prompt.submit({ text: 'tel=010-1234-5678 ###a###' })
  expect(seen).toEqual(['tel=010-1234-5678 ###a###'])
})

test('홈 경로를 얻지 못하면 파일 없이 범위만 적용한다', async ($, on) => {
  on('env.get', () => ({ value: undefined }))
  const seen: string[] = []
  on('prompt.submit', (_$: any, e: any) => {
    seen.push(e.text)
    return { text: e.text }
  })
  await $.prompt.submit({ text: 'tel=010-1234-5678' })
  expect(seen).toEqual(['tel=[전화번호#1] 010-••••-5678'])
})

test('Windows: HOME과 USERPROFILE이 다르면 USERPROFILE의 설정 파일을 읽는다', async ($, on) => {
  // 엔진은 테스트를 돌리는 OS 기준으로 경로를 풀어 C:\…는 macOS에서 상대 경로가 된다. 순서만 보므로 POSIX 경로로 쓴다
  const PROFILE = '/profile/tester'
  on('env.get', (_$: any, e: any) => ({ value: e.name === 'USERPROFILE' ? PROFILE : e.name === 'HOME' ? HOME : undefined }))
  on('fs.exists', (_$: any, e: any) => ({ value: e.path === `${PROFILE}/.claude/privacy-mask.json` }))
  on('fs.read', () => ({ value: '{"keys":["orderMemo"]}' }))
  const seen: string[] = []
  on('prompt.submit', (_$: any, e: any) => {
    seen.push(e.text)
    return { text: e.text }
  })
  await $.prompt.submit({ text: 'orderMemo=부재시연락' })
  expect(seen).toEqual(['orderMemo=[orderMemo#1]'])
})
