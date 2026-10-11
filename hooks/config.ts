import type { PluginOptions } from 'claude-code'
import { normKey, RULE_IDS, SCOPE_RULES, SCOPES, type RuleId, type Scope } from './rules.ts'

export type UserPattern = { label: string; source: string; partial: boolean }

export type MaskConfig = {
  enabled: ReadonlySet<RuleId>
  // 키로 찾은 값을 프롬프트 전체에서 치환하는 최소 길이 (Y·1 같은 값이 로그 곳곳을 가리는 것 방지)
  propagateMin: number
  // 개인정보 키·사용자 키의 문자 값 전체 치환 최소 길이 (이름은 2~4자)
  propagateMinText: number
  // 사용자 키 이름 (normKey로 정규화)
  customKeys: readonly string[]
  patterns: readonly UserPattern[]
}

export const DEFAULT_CONFIG: MaskConfig = {
  enabled: new Set(SCOPE_RULES.표준),
  propagateMin: 6,
  propagateMinText: 2,
  customKeys: [],
  patterns: [],
}

// 음수·소수·누락은 기본값으로
export const intOption = (v: unknown, fallback: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback

export type Options = { enabled: boolean; scope: Scope; propagateMin: number; propagateMinText: number }

const isScope = (v: unknown): v is Scope => (SCOPES as readonly unknown[]).includes(v)

export const readOptions = (options: PluginOptions): Options => ({
  enabled: options.enabled !== false,
  scope: isScope(options.scope) ? options.scope : '표준',
  propagateMin: intOption(options.propagate_min, DEFAULT_CONFIG.propagateMin),
  propagateMinText: intOption(options.propagate_min_text, DEFAULT_CONFIG.propagateMinText),
})

export type UserFile = { rules: Partial<Record<RuleId, boolean>>; keys: string[]; patterns: UserPattern[] }

export const EMPTY_FILE: UserFile = { rules: {}, keys: [], patterns: [] }

export type Loaded = { ok: true; file: UserFile } | { ok: false; reason: string }

export const buildConfig = (o: Options, f: UserFile): MaskConfig => {
  const enabled = new Set<RuleId>(SCOPE_RULES[o.scope])
  for (const [id, on] of Object.entries(f.rules) as [RuleId, boolean][]) {
    if (on) enabled.add(id)
    else enabled.delete(id)
  }
  return {
    enabled,
    propagateMin: o.propagateMin,
    propagateMinText: o.propagateMinText,
    customKeys: f.keys.map(normKey).filter(Boolean),
    patterns: f.patterns,
  }
}

const fail = (reason: string): Loaded => ({ ok: false, reason })

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

const isRuleId = (s: string): s is RuleId => (RULE_IDS as readonly string[]).includes(s)

// 오류면 이유 문자열. 차단 메시지에 프롬프트 내용은 넣지 않고 항목 번호만 알린다
const parsePatterns = (items: unknown[]): UserPattern[] | string => {
  const patterns: UserPattern[] = []
  for (const [i, item] of items.entries()) {
    const at = `설정 파일 patterns ${i + 1}번째 항목: `
    if (!isObject(item)) return `${at}객체가 아닙니다`
    const { label, regex, partial } = item
    if (typeof label !== 'string' || !label.trim()) return `${at}label이 없습니다`
    // 자리표시자 [라벨#n] 판별이 깨진다
    if (/[[\]#\n]/.test(label)) return `${at}label에 [ ] # 줄바꿈은 쓸 수 없습니다`
    if (typeof regex !== 'string' || !regex) return `${at}regex가 없습니다`
    if (partial !== undefined && typeof partial !== 'boolean') return `${at}partial은 true 또는 false여야 합니다`
    try {
      new RegExp(regex, 'g')
    } catch {
      return `${at}regex 문법 오류`
    }
    patterns.push({ label, source: regex, partial: partial === true })
  }
  return patterns
}

// 잘못 적은 항목이 조용히 무시되면 가려질 줄 안 값이 그대로 나가므로 모두 막는다
export const parseUserFile = (text: string): Loaded => {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return fail('설정 파일이 올바른 JSON이 아닙니다')
  }
  if (!isObject(data)) return fail('설정 파일은 객체여야 합니다')
  const { rules = {}, keys = [], patterns = [], ...rest } = data
  const unknownField = Object.keys(rest)[0]
  if (unknownField !== undefined) return fail(`설정 파일: 알 수 없는 항목 ${unknownField}`)
  if (!isObject(rules)) return fail('설정 파일 rules는 객체여야 합니다')
  for (const [id, on] of Object.entries(rules)) {
    if (!isRuleId(id)) return fail(`설정 파일 rules: 알 수 없는 규칙 ${id}`)
    if (typeof on !== 'boolean') return fail(`설정 파일 rules.${id}: true 또는 false여야 합니다`)
  }
  if (!Array.isArray(keys) || keys.some(k => typeof k !== 'string')) return fail('설정 파일 keys는 문자열 배열이어야 합니다')
  if (!Array.isArray(patterns)) return fail('설정 파일 patterns는 배열이어야 합니다')
  const parsed = parsePatterns(patterns)
  if (typeof parsed === 'string') return fail(parsed)
  return { ok: true, file: { rules: rules as UserFile['rules'], keys: keys as string[], patterns: parsed } }
}

export const userFilePath = (home: string | undefined) => (home ? `${home}/.claude/privacy-mask.json` : '')

// 프롬프트마다 다시 읽는다: 고친 내용이 /reload-plugins 없이 반영된다
export const loadUserFile = async (
  fs: { exists: (path: string) => Promise<boolean>; read: (path: string) => Promise<unknown> },
  path: string,
): Promise<Loaded> => {
  if (!path) return { ok: true, file: EMPTY_FILE }
  let text: unknown
  try {
    if (!(await fs.exists(path))) return { ok: true, file: EMPTY_FILE }
    text = await fs.read(path)
  } catch {
    return fail(`설정 파일을 읽을 수 없습니다 (${path})`)
  }
  return typeof text === 'string' ? parseUserFile(text) : fail(`설정 파일을 읽을 수 없습니다 (${path})`)
}
