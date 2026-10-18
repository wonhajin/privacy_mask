import { DEFAULT_CONFIG, type MaskConfig } from './config.ts'
import { keyKindOf } from './keys.ts'
import { type Ctx, keepEnds, PII_RULES, type Rule, SECRET, SECRET_RULES } from './rules.ts'

// 일부 노출(계좌·사업자번호·이메일 아이디·사용자 정규식 partial)에서 앞뒤로 보여 줄 글자 수
const PARTIAL_KEEP = 2

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// replace 콜백 인자에서 캡처 그룹만 추린다 (offset 숫자 앞까지, 빠진 그룹은 '')
const groupsOf = (rest: unknown[]) => {
  const end = rest.findIndex(x => typeof x === 'number')
  return rest.slice(0, end).map(x => (typeof x === 'string' ? x : ''))
}

export type Segment = { text: string; raw: boolean }

// ### 바로 안쪽 양 끝이 공백·#이 아닐 때만 구분자 (### 제목, ##########와 구분). 여러 줄 가능
// 여는 ###는 줄 처음이나 공백 뒤에서만 본다: 비밀번호 같은 값 속 ###(Ab###Cd###1)가 구간을 열면 값 일부가 그대로 나간다
const BYPASS = /(?<!\S)###(?=[^\s#])([\s\S]*?[^\s#])###(?!#)/g

export const splitBypass = (text: string): Segment[] => {
  const out: Segment[] = []
  let last = 0
  for (const m of text.matchAll(BYPASS)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), raw: false })
    out.push({ text: m[1] ?? '', raw: true })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), raw: false })
  return out
}

export const isAllBypass = (segments: Segment[]) =>
  segments.some(s => s.raw) && segments.every(s => s.raw || !s.text.trim())

export const joinSegments = (segments: Segment[]) => segments.map(s => s.text).join('')

const PLACEHOLDER = /\[[^[\]\n]*#\d+\]/
const PLACEHOLDER_ONLY = new RegExp(`^${PLACEHOLDER.source}$`)

const EXISTING_PLACEHOLDER = /\[([^[\]\n#]*)#(\d+)\]/g
// 이미 가린 자리표시자와 바로 뒤 일부 노출 꼬리(010-••••-5678). 규칙이 다시 보면 따옴표·태그 안 자리표시자를
// 값으로 다시 가리거나, 꼬리의 남은 글자(ng@example.com)를 새 이메일로 잡는다.
// 앞 공백도 함께 뺀다: 남겨 두면 'Cookie: '처럼 끊긴 구간에서 그 공백을 값으로 본다.
// 꼬리는 규칙이 만드는 형식만 인정한다. 넓게 잡으면 공백 없는 JSON 로그에서 "[a#1] x•" 뒤의 다른 필드가
// 통째로 제외돼 가려지지 않는다
const KEEP_ENDS = `[.-]*(?:[\\w+%][.-]*){0,${PARTIAL_KEEP}}•[•.-]*(?:[\\w+%][.-]*){0,${PARTIAL_KEEP}}(?:@[\\w.-]+)?`
const TAILS = [
  KEEP_ENDS, // 계좌·사업자번호·이메일·사용자 정규식 partial (keepEnds)
  '\\d{2,4}-••••-\\d{4}', // 전화번호
  '••••-\\d{4}', // 카드번호
  '\\d{1,3}\\.•••\\.•••\\.\\d{1,3}', // IP
  '[0-9A-Fa-f]{2}(?:[:-]••){4}[:-][0-9A-Fa-f]{2}', // MAC
]
const MASKED = new RegExp(`[ \\t]*\\[[^[\\]\\n#]*#\\d+\\](?: (?:${TAILS.join('|')})(?![\\w+%•@]))?`, 'g')

const splitMasked = (text: string): Segment[] => {
  const out: Segment[] = []
  let last = 0
  for (const m of text.matchAll(MASKED)) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), raw: false })
    out.push({ text: m[0], raw: true })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), raw: false })
  return out
}

// 번호는 프롬프트마다 1부터. 호출이 끝나면 상태를 남기지 않는다.
// 파일 모드는 예외: 이미 가린 파일을 다시 가릴 때 새 값이 기존 [이메일#1]과 같은 번호를 받으면
// 서로 다른 값이 같아 보이므로, 파일에 있는 라벨별 최대 번호 다음부터 매긴다.
// 또 파일 속 ###는 사용자가 넣은 제외 표시가 아니므로 구간을 나누지 않는다 (구분자를 지우면 파일 내용이 바뀐다).
// 대신 이미 가린 자리를 제외 구간으로 두어 다시 돌려도 결과가 같게 한다
export const maskText = (text: string, config: MaskConfig = DEFAULT_CONFIG, mode: 'prompt' | 'file' = 'prompt') => {
  const counts: Record<string, number> = {}
  const ids = new Map<string, number>()
  const last: Record<string, number> = {}
  if (mode === 'file') {
    for (const [, label = '', n = '0'] of text.matchAll(EXISTING_PLACEHOLDER)) {
      last[label] = Math.max(last[label] ?? 0, Number(n))
    }
  }
  // 키로 찾은 값 → 자리표시자와 집계 라벨 (같은 값이 여러 키에 걸리면 처음 키 이름으로 통일)
  const keyedValues = new Map<string, { ph: string; label: string }>()

  const placeholder = (label: string, norm: string) => {
    const key = `${label}\u0000${norm}`
    let id = ids.get(key)
    if (id === undefined) {
      id = (last[label] ?? 0) + 1
      last[label] = id
      ids.set(key, id)
    }
    return `[${label}#${id}]`
  }

  const ctx: Ctx = {
    count: label => {
      counts[label] = (counts[label] ?? 0) + 1
    },
    tag: (label, norm) => {
      ctx.count(label)
      return placeholder(label, norm)
    },
    keep: PARTIAL_KEEP,
    keyed: (key, value, kind) => {
      // <entry key="password"> 뒤의 줄바꿈·들여쓰기 같은 공백뿐인 값은 비밀값이 아니다
      if (!value.trim()) return value
      // JSON·설정의 빈 값 표기는 개인정보·비밀값이 아니다. 가리면 같은 리터럴이 프롬프트 곳곳에서 바뀐다
      if (/^(null|undefined|true|false|none|nil)$/i.test(value)) return value
      const label = kind === 'secret' ? SECRET : '개인정보'
      ctx.count(label)
      const known = keyedValues.get(value)
      if (known !== undefined) return known.ph
      const ph = placeholder(key, value)
      // 숫자로만 된 값과 비밀값은 짧으면 다른 뜻으로 흔히 쓰여(cvc=123, flag_pw=Y) 기준을 높게 둔다
      const min = kind === 'secret' || /^[\d.-]+$/.test(value) ? config.propagateMin : config.propagateMinText
      // 공백이 낀 값은 전체 치환하지 않는다 (줄바꿈·들여쓰기가 프롬프트 곳곳에서 바뀌는 것 방지)
      if (value.length >= min && !/\s/.test(value)) keyedValues.set(value, { ph, label })
      return ph
    },
    keyKind: key => keyKindOf(config, key),
  }

  const segments = mode === 'file' ? splitMasked(text) : splitBypass(text)
  // 제외 구간은 어떤 단계에도 들어가지 않는다 (키 값 수집 포함)
  const each = (fn: (s: string) => string) => {
    for (const seg of segments) if (!seg.raw) seg.text = fn(seg.text)
  }

  const run = (rules: Rule[]) => {
    for (const rule of rules) {
      if (rule.id !== null && !config.enabled.has(rule.id)) continue
      each(s => s.replace(rule.re, (m: string, ...rest: unknown[]) => rule.apply(ctx, m, groupsOf(rest)) ?? m))
    }
  }

  run(SECRET_RULES)
  // 키 없이 다시 나온 같은 값(요청 URL·다른 로그 줄)도 가린다. 긴 값부터 치환해 부분 겹침 방지.
  // 앞뒤가 영숫자로 이어지면 다른 숫자·단어의 일부(ts=1760123456000)로, [..#n] 안이면 이미 넣은
  // 자리표시자로 보고 건드리지 않는다. 키 자리(password=), 태그 이름(<password>),
  // 키 이름 속성(key="password" · name="password")도 값이 아니다
  for (const [value, { ph, label }] of [...keyedValues].sort((a, b) => b[0].length - a[0].length)) {
    const re = new RegExp(
      `(?<![\\w\\[#<])(?<!<\\/)(?<!(?:key|name)\\s*=\\s*["'])${escapeRegExp(value)}(?![\\w#\\]])(?!["']?\\s*[:=])`,
      'g',
    )
    each(s =>
      s.replace(re, () => {
        ctx.count(label)
        return ph
      }),
    )
  }
  run(PII_RULES)
  // 사용자 정규식은 마지막. 자리표시자를 먼저 대안으로 두어, 그 자리에서는 자리표시자가 통째로 매치돼 그대로 남게 한다
  for (const p of config.patterns) {
    const re = new RegExp(`${PLACEHOLDER.source}|(?:${p.source})`, 'g')
    each(s =>
      s.replace(re, (m: string) => {
        if (!m || PLACEHOLDER_ONLY.test(m)) return m
        const ph = ctx.tag(p.label, m)
        return p.partial ? `${ph} ${keepEnds(m, PARTIAL_KEEP)}` : ph
      }),
    )
  }
  return { text: joinSegments(segments), counts }
}
