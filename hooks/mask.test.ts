import { expect, test } from 'claude-code/testing'
import { DEFAULT_CONFIG } from './config.ts'
import { isAllBypass, maskText, splitBypass } from './mask.ts'

const withPatterns = (patterns: { label: string; source: string; partial: boolean }[]) => ({ ...DEFAULT_CONFIG, patterns })

test('maskText: 훅을 거치지 않고 직접 호출할 수 있다', () => {
  expect(maskText('tel=010-1234-5678').text).toBe('tel=[전화번호#1] 010-••••-5678')
})

test('isAllBypass: 구간 밖이 공백뿐이면 전체 제외', () => {
  expect(isAllBypass(splitBypass('  ###a=1###\n'))).toBe(true)
  expect(isAllBypass(splitBypass('###a=1### b'))).toBe(false)
  expect(isAllBypass(splitBypass('plain'))).toBe(false)
})

test('사용자 정규식: 전체 가림 · 일부 노출', () => {
  const config = withPatterns([
    { label: '사번', source: 'EMP\\d{6}', partial: false },
    { label: '여권번호', source: '[A-Z]\\d{8}', partial: true },
  ])
  expect(maskText('emp EMP123456 / passport M12345678 / EMP123456', config).text).toBe(
    'emp [사번#1] / passport [여권번호#1] M1•••••78 / [사번#1]',
  )
})

test('사용자 정규식: 이미 넣은 자리표시자 안은 건드리지 않는다', () => {
  expect(maskText('pw=abcdef 7', withPatterns([{ label: '숫자', source: '\\d+', partial: false }])).text).toBe(
    'pw=[pw#1] [숫자#1]',
  )
})

test('사용자 정규식: 빈 문자열에 매치되는 정규식은 원문 유지', () => {
  expect(maskText('aaa bbb', withPatterns([{ label: 'x', source: 'z*', partial: false }])).text).toBe('aaa bbb')
})

test('사용자 정규식: 제외 구간은 건드리지 않는다', () => {
  expect(maskText('###EMP123456### EMP123456', withPatterns([{ label: '사번', source: 'EMP\\d{6}', partial: false }])).text).toBe(
    'EMP123456 [사번#1]',
  )
})

test('maskText: 공백 없는 긴 문자열(base64·숫자열)도 길이에 비례한 시간에 끝난다', () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const b64 = Array.from({ length: 40000 }, (_, i) => chars[(i * 7919) % 62]).join('')
  const start = performance.now()
  maskText(`${b64} ${'1'.repeat(40000)}`)
  // 위치마다 다시 훑으면 수십 초가 걸린다. 여유를 크게 둔다
  expect(performance.now() - start).toBeLessThan(1000)
})
