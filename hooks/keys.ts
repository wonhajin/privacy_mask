import type { MaskConfig } from './config.ts'

export type KeyKind = 'secret' | 'pii'

// username류는 계정 식별용이라 제외 (사용자 ID로 로그 추적이 필요함)
const SECRET_KEY =
  /pass(word|wd)?|pwd|pw$|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential|auth(?!or)|jsessionid|session[_-]?id|client[_-]?id|비밀번호|비번/

// pass·token을 품은 다른 단어 (테스트 결과·토큰 개수·설정 플래그). 키에서 지운 뒤 판정해 bypass_password는 그대로 잡는다.
// 복수형 tokens는 개수를 뜻할 때만 뺀다: api_tokens·refresh_tokens는 토큰 값을 담는다
const NOT_SECRET_WORDS =
  /passed|bypass|compass|passeng|passthrough|(?:max|num|total|input|output|prompt|completion)[_-]?tokens|tokens[_-]?(?:used|count|limit|len)|tokeniz|token[_-]?(?:count|type|limit|len)/g

const isSecretKey = (key: string) => {
  const k = key.toLowerCase()
  return !/user(name)?$/.test(k) && SECRET_KEY.test(k.replace(NOT_SECRET_WORDS, ' '))
}

// 마지막 . 뒤 이름을 _ - 공백·camelCase 경계로 나눈다: order.custName → [cust, name]
const keyTokens = (key: string) =>
  (key.split('.').pop() ?? '')
    .split(/[_\-\s]+|(?<=[a-z0-9])(?=[A-Z])/)
    .filter(Boolean)
    .map(t => t.toLowerCase())

const NAME_OWNERS = new Set(['cust', 'customer', 'member', 'mbr', 'buyer', 'receiver', 'recipient', 'holder', 'owner', 'emp', 'employee', 'real', 'full'])
const BIRTH = new Set(['birth', 'birthday', 'birthdate', 'birthdt', 'birthymd', 'brthdy', 'dob'])

// custname·membernm처럼 소유자와 name이 붙어 한 토큰인 경우
const OWNER_NAME = new RegExp(`^(${[...NAME_OWNERS].join('|')})(name|nm)$`)

const PII_KEY_IDS = ['name_key', 'birth_key', 'card_extra_key'] as const
type PiiKeyId = (typeof PII_KEY_IDS)[number]

// keyTokens로 나눈 토큰을 받는다.
// "name"은 기술 용어(fileName·hostName)에도 쓰여서 앞에 붙는 말로 거른다. 놓친 키는 사용자 키로 보완한다
const PII_KEY_MATCHERS: Record<PiiKeyId, (t: string[]) => boolean> = {
  name_key: t => {
    const last = t.at(-1) ?? ''
    const prev = t.at(-2) ?? ''
    return (
      ((last === 'name' || last === 'nm') && NAME_OWNERS.has(prev)) ||
      OWNER_NAME.test(last) ||
      /^(성명|이름|고객명)$/.test(last)
    )
  },
  birth_key: t => {
    const last = t.at(-1) ?? ''
    const prev = t.at(-2) ?? ''
    return BIRTH.has(last) || (prev === 'birth' && /^(date|dt|day|ymd)$/.test(last)) || /생년월일$/.test(last)
  },
  card_extra_key: t => {
    const last = t.at(-1) ?? ''
    return /^(cvc|cvv)2?$/.test(last) || /card(exp|expiry|expdate|expiration)$/.test(t.slice(-3).join(''))
  },
}

export const normKey = (key: string) => key.toLowerCase().replace(/[_-]/g, '')

// 사용자 키는 키 전체 또는 마지막 . 뒤 이름과 비교한다 (custom은 normKey로 정규화된 값)
const isCustomKey = (custom: readonly string[], key: string) => {
  const full = normKey(key)
  const last = full.split('.').pop() ?? full
  return custom.some(c => c === full || c === last)
}

// 가릴 키인가, 어떤 종류인가 (켜진 키 규칙 기준). null이면 가리지 않는다
export const keyKindOf = (config: MaskConfig, key: string): KeyKind | null => {
  if (config.enabled.has('secret_key') && isSecretKey(key)) return 'secret'
  if (isCustomKey(config.customKeys, key)) return 'pii'
  const t = keyTokens(key)
  return PII_KEY_IDS.some(id => config.enabled.has(id) && PII_KEY_MATCHERS[id](t)) ? 'pii' : null
}
