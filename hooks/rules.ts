import type { KeyKind } from './keys.ts'

// 규칙 id. 범위별 묶음은 SCOPE_RULES, 개별 켜고 끄기는 사용자 설정 파일의 rules. 규칙을 추가하면 SCOPE_RULES에도 넣는다
export const RULE_IDS = [
  'rrn',
  'phone',
  'driver_license',
  'email',
  'card',
  'biz_no',
  'account',
  'ip',
  'mac',
  'name_key',
  'birth_key',
  'card_extra_key',
  'private_key',
  'jwt',
  'service_token',
  'jasypt',
  'auth_header',
  'connection_string',
  'cookie',
  'secret_key',
] as const

export type RuleId = (typeof RULE_IDS)[number]

export const SCOPES = ['최소', '표준', '전체'] as const
export type Scope = (typeof SCOPES)[number]

// 최소: 유출 즉시 피해가 나는 비밀값·결제·신원
const MINIMAL: readonly RuleId[] = [
  'private_key',
  'jwt',
  'service_token',
  'jasypt',
  'auth_header',
  'connection_string',
  'cookie',
  'secret_key',
  'rrn',
  'card',
  'card_extra_key',
]
// 표준: + 개인을 특정하는 정보
const STANDARD: readonly RuleId[] = [...MINIMAL, 'phone', 'driver_license', 'biz_no', 'account', 'name_key', 'birth_key']

// 전체: + 개발 중 오탐이 잦은 것 (커밋 작성자 이메일, 로그의 IP·MAC)
export const SCOPE_RULES: Record<Scope, readonly RuleId[]> = {
  최소: MINIMAL,
  표준: STANDARD,
  전체: [...STANDARD, 'email', 'ip', 'mac'],
}

export type Ctx = {
  // 같은 프롬프트 안에서 같은 norm → 같은 번호. norm은 호출부가 정한다 (전화는 숫자만, 이메일은 소문자 등)
  tag: (label: string, norm: string) => string
  // 일부 노출 "앞뒤 N자"의 N
  keep: number
  // 키로 찾은 값: 키 이름을 라벨로 쓰고, 같은 값은 프롬프트 전체에서 가린다
  keyed: (key: string, value: string, kind: KeyKind) => string
  // 가릴 키인가, 어떤 종류인가 (켜진 키 규칙 기준). null이면 가리지 않는다
  keyKind: (key: string) => KeyKind | null
  count: (label: string) => void
}

export type Rule = {
  // null이면 항상 실행한다. 키 규칙은 켜고 끄기를 ctx.keyKind가 판단한다
  id: RuleId | null
  re: RegExp
  // null이면 오탐으로 보고 원문 유지
  apply: (ctx: Ctx, m: string, g: string[]) => string | null
}

export const SECRET = '비밀값'

const digitsOf = (s: string) => s.replace(/\D/g, '')

const SEP = /[-. ]/

// 가린 글자. '*'는 한 줄에 두 묶음 이상이면 화면의 마크다운이 강조 기호로 먹어 010--5678처럼 보인다
const MASK = '•'

// 구분자는 남기고, 구분자를 뺀 글자 중 앞 n자·뒤 n자만 보인다. 2n자 이하면 전부 가린다
export const keepEnds = (s: string, n: number) => {
  const chars = [...s]
  const total = chars.filter(c => !SEP.test(c)).length
  let i = 0
  return chars
    .map(c => {
      if (SEP.test(c)) return c
      const idx = i++
      return total > n * 2 && (idx < n || idx >= total - n) ? c : MASK
    })
    .join('')
}

// 접두어로 서비스를 구분한다. sk-ant- 가 sk- 보다 먼저 와야 한다
const SERVICE_LABELS: [RegExp, string][] = [
  [/^(AKIA|ASIA)/, 'AWS키'],
  [/^(gh[pousr]_|github_pat_)/, 'GitHub토큰'],
  [/^glpat-/, 'GitLab토큰'],
  [/^sk-ant-/, 'Anthropic키'],
  [/^sk-/, 'OpenAI키'],
  [/^xox/, 'Slack토큰'],
  [/^AIza/, 'Google키'],
  [/^[sr]k_(live|test)_/, 'Stripe키'],
  [/^npm_/, 'npm토큰'],
]

const serviceLabel = (token: string) => SERVICE_LABELS.find(([re]) => re.test(token))?.[1] ?? '토큰'

const luhn = (digits: string) => {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i])
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return sum % 10 === 0
}

// 카드사 번호 대역(BIN). 16자리 ID가 우연히 Luhn을 통과하는 오탐(약 10%)을 줄인다
// Visa 4 · Master 51~55, 2221~2720 · Amex 34/37 · JCB 35 · Diners 36/38 · Discover/UnionPay 6 · 국내 전용 9
const isCardBin = (digits: string) => {
  if (/^(4|5[1-5]|3[4-8]|6|9)/.test(digits)) return true
  const head = Number(digits.slice(0, 4))
  return head >= 2221 && head <= 2720
}

// 사업자등록번호 검증: 앞 9자리 × 1,3,7,1,3,7,1,3,5 + ⌊9번째 × 5 / 10⌋, (10 − 합 mod 10) mod 10 = 끝자리
const BIZ_WEIGHTS = [1, 3, 7, 1, 3, 7, 1, 3, 5]

const isBizNo = (d: string) => {
  if (d.length !== 10) return false
  let sum = 0
  for (let i = 0; i < 9; i++) sum += Number(d[i]) * (BIZ_WEIGHTS[i] ?? 0)
  sum += Math.floor((Number(d[8]) * 5) / 10)
  return (10 - (sum % 10)) % 10 === Number(d[9])
}

// 2014년 이전 면허증의 지역명 표기
const LICENSE_REGIONS = '서울|부산|경기|강원|충북|충남|전북|전남|경북|경남|제주|대구|인천|광주|대전|울산'

// 코드로 보이는 값: ::·==의 뒷부분, 함수 호출(getToken(), 타입 표기(password: string).
// 실제 비밀값일 가능성이 거의 없는 꼴만 거른다. password: hashedPassword 같은 식별자나 키와 같은 값(password=password)은
// 비밀값과 구분할 수 없어 그대로 가린다
const TYPE_NAMES = /^(string|number|boolean|bool|any|unknown|object|str|int|float|double|long|char|bytes)$/i

const isCodeValue = (v: string) => /^[:=]/.test(v) || /^[\w.$]+\($/.test(v) || TYPE_NAMES.test(v)

// 따옴표는 남기고 안쪽만 바꾼다. 빈 따옴표("")는 null(원문 유지)
const replaceInQuotes = (v: string, fn: (inner: string) => string) => {
  const q = v[0]
  if ((q === '"' || q === "'") && v.length >= 2 && v.endsWith(q)) {
    const inner = v.slice(1, -1)
    return inner ? `${q}${fn(inner)}${q}` : null
  }
  return fn(v)
}

// 순서가 중요하다: 비밀값 → (키로 찾은 값 전체 치환) → 개인정보 → IP·MAC. 앞 단계가 남긴 [..] 자리표시자는 뒤 규칙이 건드리지 않는다
export const SECRET_RULES: Rule[] = [
  // ---- 비밀값: 형식만으로 잡히는 것 ----
  {
    id: 'private_key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    apply: (ctx, m) => ctx.tag('개인키', m),
  },
  {
    id: 'jwt',
    re: /\beyJ[\w-]{5,}\.eyJ[\w-]{5,}\.[\w-]+/g,
    apply: (ctx, m) => ctx.tag('JWT', m),
  },
  {
    id: 'service_token',
    re: /https:\/\/(?:hooks\.slack\.com\/services\/[\w/-]+|(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+)/g,
    apply: (ctx, m) => ctx.tag('웹훅URL', m),
  },
  {
    id: 'service_token',
    re: /\b(?:(?:AKIA|ASIA)[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{22,}|glpat-[\w-]{20,}|sk-ant-[\w-]{20,}|sk-proj-[\w-]{20,}|sk-[A-Za-z0-9]{20,}|xox[abprs]-[\w-]{10,}|AIza[\w-]{35}|[sr]k_(?:live|test)_[0-9A-Za-z]{24,}|npm_[A-Za-z0-9]{36})\b/g,
    apply: (ctx, m) => ctx.tag(serviceLabel(m), m),
  },
  {
    id: 'jasypt',
    // Jasypt 암호문
    re: /ENC\([^)\s]+\)/g,
    apply: (ctx, m) => ctx.tag('암호문', m),
  },
  {
    id: 'auth_header',
    re: /(authorization["']?\s*[:=]\s*["']?(?:bearer|basic)\s+)([\w\-.~+/]+=*)/gi,
    apply: (ctx, _m, g) => g[0] + ctx.tag('인증토큰', g[1]),
  },
  {
    id: 'auth_header',
    re: /(\bbearer\s+)([\w\-.~+/]{20,}=*)/gi,
    apply: (ctx, _m, g) => g[0] + ctx.tag('인증토큰', g[1]),
  },
  {
    id: 'connection_string',
    // jdbc:oracle:thin:user/password@host
    re: /(jdbc:oracle:\w+:[^/\s@:]+\/)([^@\s]+)(@)/gi,
    apply: (ctx, _m, g) => g[0] + ctx.tag('접속비밀번호', g[1]) + g[2],
  },
  {
    id: 'connection_string',
    // scheme://user:password@host. 비밀번호에 /가 그대로 들어가도 잡되, 숫자 뒤 /는 host:port/경로로 본다
    re: /(:\/\/[^/\s:@]+:)(?!\d+\/)([^@\s]+)(@)/g,
    apply: (ctx, _m, g) => g[0] + ctx.tag('접속비밀번호', g[1]) + g[2],
  },
  {
    // Azure 접속 문자열
    id: 'connection_string',
    re: /(\b(?:AccountKey|SharedAccessKey)=)([A-Za-z0-9+/]+=*)/g,
    apply: (ctx, _m, g) => g[0] + ctx.tag('접속비밀번호', g[1]),
  },
  {
    // Cookie·Set-Cookie 헤더: 값 안의 이름=값 쌍을 하나하나 보지 않고 통째로 가린다
    id: 'cookie',
    re: /(["']?\b(?:set-)?cookie["']?\s*:\s*)("[^"\n]*"|'[^'\n]*'|[^\r\n]+)/gi,
    apply: (ctx, _m, g) => {
      const [head, v] = g
      const masked = replaceInQuotes(v, inner => ctx.tag('쿠키', inner))
      return masked === null ? null : head + masked
    },
  },
  // ---- 키 이름으로 잡는 것 (비밀값·개인정보) ----
  {
    id: null,
    // <property name="password" value="..."/>
    re: /((?:name|key)\s*=\s*"([^"]+)"\s+value\s*=\s*")([^"]*)(")/g,
    apply: (ctx, _m, g) => {
      const kind = ctx.keyKind(g[1])
      return kind && g[2] ? g[0] + ctx.keyed(g[1], g[2], kind) + g[3] : null
    },
  },
  {
    id: null,
    // <entry key="password">...</entry>. 자기닫힘 태그(<add key=… />)는 값이 없으니 뒤 텍스트를 잡지 않는다
    re: /(key\s*=\s*"([^"]+)"[^>]*(?<!\/)>)([^<]+)(<)/g,
    apply: (ctx, _m, g) => {
      const kind = ctx.keyKind(g[1])
      return kind ? g[0] + ctx.keyed(g[1], g[2], kind) + g[3] : null
    },
  },
  {
    id: null,
    // <password>...</password>
    re: /(<([A-Za-z0-9_.-]+)(?:\s[^>]*)?>)([^<]+)(<\/\2>)/g,
    apply: (ctx, _m, g) => {
      const kind = ctx.keyKind(g[1])
      return kind ? g[0] + ctx.keyed(g[1], g[2], kind) + g[3] : null
    },
  },
  {
    id: null,
    // key=value · key: value · "key": "value"
    // 구분자 앞뒤 공백은 줄을 넘지 않는다: 값이 빈 YAML 키(auth:) 다음 줄의 키(enabled:)를 값으로 잡지 않게
    // 키는 글자 묶음의 처음에서만 시작한다. 묶음 중간에서 다시 시작해도 결과는 같고, 긴 base64에서 시간이 제곱으로 는다
    re: /(?<![A-Za-z0-9_.\-가-힣])(["']?)([A-Za-z0-9_.\-가-힣]+)\1([ \t]*[:=][ \t]*)("[^"\n]*"|'[^'\n]*'|[^\s,;&)}\]<>"']+)/g,
    apply: (ctx, _m, g) => {
      const [q, key, sep, v] = g
      const kind = ctx.keyKind(key)
      if (!kind || v.startsWith('[') || /^(bearer|basic)$/i.test(v) || isCodeValue(v)) return null
      const masked = replaceInQuotes(v, inner => ctx.keyed(key, inner, kind))
      return masked === null ? null : q + key + q + sep + masked
    },
  },
]

export const PII_RULES: Rule[] = [
  // ---- 개인정보 ----
  {
    id: 'email',
    // 아이디는 글자 묶음의 처음에서만 시작한다 (key=value 규칙과 같은 이유)
    re: /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]+)@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,
    apply: (ctx, m, g) => `${ctx.tag('이메일', m.toLowerCase())} ${keepEnds(g[0], ctx.keep)}@${g[1]}`,
  },
  {
    id: 'card',
    re: /(?<!\d)(?:\d{4}[- ]?){3}\d{4}(?!\d)/g,
    apply: (ctx, m) => {
      const d = digitsOf(m)
      return isCardBin(d) && luhn(d) ? `${ctx.tag('카드번호', d)} ${MASK.repeat(4)}-${d.slice(-4)}` : null
    },
  },
  {
    id: 'rrn',
    // 13자리 epoch ms 오탐은 앞 6자리 월·일 검사로 거른다. 17·18로 시작하는 ms(2023-11~2024-04, 2027-01~06)는
    // 월·일을 통과하므로, 구분자가 없고 1900~1919년생(106세 이상)이면 번호가 아닌 것으로 본다.
    // 같은 구간의 2000년대생 꼴(성별 3·4·7·8)은 남는다: 체크섬은 2020년 개편 뒤 번호에 쓸 수 있는지 확인되지 않았다
    re: /(?<!\d)(\d{2})(\d{2})(\d{2})([- ]?)([1-8])\d{6}(?!\d)/g,
    apply: (ctx, m, g) => {
      const [yy, mm, dd, , gender] = g.map(Number)
      if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null
      if (g[3] === '' && yy < 20 && [1, 2, 5, 6].includes(gender)) return null
      return ctx.tag('주민번호', digitsOf(m))
    },
  },
  {
    id: 'phone',
    re: /(?<!\d)01[016789][- .]?\d{3,4}[- .]?\d{4}(?!\d)/g,
    apply: (ctx, m) => {
      const d = digitsOf(m)
      return `${ctx.tag('전화번호', d)} ${d.slice(0, 3)}-${MASK.repeat(4)}-${d.slice(-4)}`
    },
  },
  {
    id: 'phone',
    // 지역번호는 구분자가 있을 때만 (숫자열 오탐 방지)
    re: /(?<!\d)(0(?:2|[3-6][1-5]|70))[-)]\d{3,4}-\d{4}(?!\d)/g,
    apply: (ctx, m, g) => `${ctx.tag('전화번호', digitsOf(m))} ${g[0]}-${MASK.repeat(4)}-${digitsOf(m).slice(-4)}`,
  },
  {
    // 지역 코드(11~26, 28)-연도-일련번호-검증 / 2014년 이전: 지역명 연도-일련번호-검증
    id: 'driver_license',
    re: new RegExp(
      `(?<![\\w-])(?:(?:${LICENSE_REGIONS})\\s?\\d{2}-\\d{6}-\\d{2}|(?:1[1-9]|2[0-6]|28)-\\d{2}-\\d{6}-\\d{2})(?![\\w-])`,
      'g',
    ),
    apply: (ctx, m) => ctx.tag('운전면허', digitsOf(m)),
  },
  {
    // 체크섬이 틀리면 null → 계좌 규칙이 다시 본다
    id: 'biz_no',
    re: /(?<![\w-])\d{3}-\d{2}-\d{5}(?![\w-])/g,
    apply: (ctx, m) => {
      const d = digitsOf(m)
      return isBizNo(d) ? `${ctx.tag('사업자번호', d)} ${keepEnds(m, ctx.keep)}` : null
    },
  },
  {
    id: 'account',
    // 하이픈 구분 계좌번호, 숫자 합계 10~14자리 (날짜·시각은 자릿수로 제외)
    // 앞뒤가 영숫자·하이픈으로 이어지면 파일명·문서번호의 일부로 보고 제외
    re: /(?<![\w-])\d{2,6}(?:-\d{2,7}){2,3}(?![\w-])/g,
    apply: (ctx, m) => {
      const d = digitsOf(m)
      return d.length >= 10 && d.length <= 14 ? `${ctx.tag('계좌번호', d)} ${keepEnds(m, ctx.keep)}` : null
    },
  },
  // ---- IP: 첫·끝 옥텟만 남겨 서버 구분은 가능하게 ----
  {
    id: 'ip',
    re: /(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\d|\.\d)/g,
    apply: (ctx, m, g) => {
      if (g.some(o => Number(o) > 255) || m === '127.0.0.1' || m === '0.0.0.0') return null
      return `${ctx.tag('IP', m)} ${g[0]}.${MASK.repeat(3)}.${MASK.repeat(3)}.${g[3]}`
    },
  },
  // ---- MAC: IP처럼 첫·끝 바이트만. 구분자는 한 종류로 6바이트 ----
  {
    id: 'mac',
    // 앞뒤에 hex 묶음이 구분자로 더 이어지거나 ::가 붙으면 IPv6·EUI-64로 보고 제외.
    // mac:… 처럼 단어 뒤 콜론, 끝의 콜론·-based 같은 단어는 묶음이 아니므로 잡는다
    re: /(?<!\w)(?<!(?<![0-9a-z])[0-9a-f]{1,4}[:-])(?<!::)([0-9a-f]{2})([:-])(?:[0-9a-f]{2}\2){4}([0-9a-f]{2})(?!\w|[:-][0-9a-f]{1,4}(?![0-9a-z])|::)/gi,
    apply: (ctx, m, g) => {
      const norm = m.toLowerCase().replace(/-/g, ':')
      // 숫자만 있으면 yy-mm-dd-hh-mm-ss 같은 날짜로 본다 (0 주소 포함). 숫자만으로 된 실제 MAC은 놓친다
      if (norm === 'ff:ff:ff:ff:ff:ff' || !/[a-f]/.test(norm)) return null
      return `${ctx.tag('MAC', norm)} ${g[0]}${`${g[1]}${MASK.repeat(2)}`.repeat(4)}${g[1]}${g[2]}`
    },
  },
]
