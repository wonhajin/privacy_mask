import { expect, test } from 'claude-code/testing'
import { buildConfig, EMPTY_FILE, loadUserFile, parseUserFile, readOptions, userFilePath } from './config.ts'
import { RULE_IDS, SCOPE_RULES } from './rules.ts'

test('범위: 넓을수록 앞 범위를 포함하고, 전체는 모든 규칙', () => {
  expect(SCOPE_RULES.표준).toEqual(expect.arrayContaining([...SCOPE_RULES.최소]))
  expect(SCOPE_RULES.전체).toEqual(expect.arrayContaining([...SCOPE_RULES.표준]))
  expect([...SCOPE_RULES.전체].sort()).toEqual([...RULE_IDS].sort())
  expect(SCOPE_RULES.표준).not.toContain('email')
  expect(SCOPE_RULES.최소).not.toContain('phone')
})

test('readOptions: 기본값, 목록 밖 범위는 표준', () => {
  expect(readOptions({})).toEqual({ enabled: true, scope: '표준', propagateMin: 6, propagateMinText: 2 })
  expect(readOptions({ enabled: false, scope: '최소' }).enabled).toBe(false)
  expect(readOptions({ scope: '최소' }).scope).toBe('최소')
  expect(readOptions({ scope: 'high' }).scope).toBe('표준')
})

test('buildConfig: 범위에서 시작해 rules로 켜고 끈다', () => {
  const o = readOptions({ scope: '표준' })
  const c = buildConfig(o, { rules: { phone: false, ip: true }, keys: ['order_Memo'], patterns: [] })
  expect(c.enabled.has('phone')).toBe(false)
  expect(c.enabled.has('ip')).toBe(true)
  expect(c.enabled.has('rrn')).toBe(true)
  expect(c.enabled.has('email')).toBe(false)
  expect(c.customKeys).toEqual(['ordermemo'])
})

test('parseUserFile: 정상, 모든 항목은 선택', () => {
  expect(parseUserFile('{}')).toEqual({ ok: true, file: EMPTY_FILE })
  expect(
    parseUserFile('{"rules":{"ip":false},"keys":["orderApiToken"],"patterns":[{"label":"사번","regex":"EMP\\\\d{6}","partial":true}]}'),
  ).toEqual({
    ok: true,
    file: { rules: { ip: false }, keys: ['orderApiToken'], patterns: [{ label: '사번', source: 'EMP\\d{6}', partial: true }] },
  })
})

test('parseUserFile: 형식 오류는 막는다', () => {
  const reason = (text: string) => {
    const r = parseUserFile(text)
    return r.ok ? null : r.reason
  }
  expect(reason('{')).toBe('설정 파일이 올바른 JSON이 아닙니다')
  expect(reason('[]')).toBe('설정 파일은 객체여야 합니다')
  expect(reason('{"pattern":[]}')).toBe('설정 파일: 알 수 없는 항목 pattern')
  expect(reason('{"rules":null}')).toBe('설정 파일 rules는 객체여야 합니다')
  expect(reason('{"rules":{"emial":true}}')).toBe('설정 파일 rules: 알 수 없는 규칙 emial')
  expect(reason('{"rules":{"ip":"no"}}')).toBe('설정 파일 rules.ip: true 또는 false여야 합니다')
  expect(reason('{"keys":"abc"}')).toBe('설정 파일 keys는 문자열 배열이어야 합니다')
  expect(reason('{"keys":[1]}')).toBe('설정 파일 keys는 문자열 배열이어야 합니다')
  expect(reason('{"patterns":{}}')).toBe('설정 파일 patterns는 배열이어야 합니다')
  expect(reason('{"patterns":[{"regex":"a"}]}')).toBe('설정 파일 patterns 1번째 항목: label이 없습니다')
  expect(reason('{"patterns":[{"label":"a","regex":"a"},{"label":"b","regex":"("}]}')).toBe(
    '설정 파일 patterns 2번째 항목: regex 문법 오류',
  )
  expect(reason('{"patterns":[{"label":"a#1","regex":"a"}]}')).toBe(
    '설정 파일 patterns 1번째 항목: label에 [ ] # 줄바꿈은 쓸 수 없습니다',
  )
  expect(reason('{"patterns":[{"label":"a","regex":"a","partial":"yes"}]}')).toBe(
    '설정 파일 patterns 1번째 항목: partial은 true 또는 false여야 합니다',
  )
})

test('userFilePath: 홈이 없으면 빈 문자열', () => {
  expect(userFilePath('/home/u')).toBe('/home/u/.claude/privacy-mask.json')
  expect(userFilePath(undefined)).toBe('')
  expect(userFilePath('')).toBe('')
})

test('loadUserFile: 경로가 비거나 파일이 없으면 빈 설정, 있는데 못 읽으면 막는다', async () => {
  const P = '/home/u/.claude/privacy-mask.json'
  const never = { exists: async () => Promise.reject(new Error('unused')), read: async () => Promise.reject(new Error('unused')) }
  expect(await loadUserFile(never, '')).toEqual({ ok: true, file: EMPTY_FILE })
  const missing = { exists: async () => false, read: async () => Promise.reject(new Error('ENOENT')) }
  expect(await loadUserFile(missing, P)).toEqual({ ok: true, file: EMPTY_FILE })
  const broken = { exists: async () => true, read: async () => Promise.reject(new Error('EACCES')) }
  expect(await loadUserFile(broken, P)).toEqual({ ok: false, reason: `설정 파일을 읽을 수 없습니다 (${P})` })
  const ok = { exists: async () => true, read: async () => '{"keys":["orderApiToken"]}' }
  expect(await loadUserFile(ok, P)).toEqual({ ok: true, file: { ...EMPTY_FILE, keys: ['orderApiToken'] } })
})
