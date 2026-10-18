import { expect, test } from 'claude-code/testing'
import { DEFAULT_CONFIG } from './config.ts'
import { type FileIo, maskFile, parseMaskArgs } from './mask-file.ts'

const withEmail = { ...DEFAULT_CONFIG, enabled: new Set([...DEFAULT_CONFIG.enabled, 'email']) }

// 메모리 맵으로 만든 파일 시스템. dirs는 폴더, sizes는 stat 크기를 덮어쓸 때
const fakeIo = (files: Record<string, string>, opts: { dirs?: string[]; sizes?: Record<string, number> } = {}) => {
  const calls = { read: 0, write: 0 }
  const io: FileIo = {
    stat: async path => {
      if (opts.dirs?.includes(path)) return { kind: 'dir', size: 0 }
      const text = files[path]
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return { kind: 'file', size: opts.sizes?.[path] ?? new TextEncoder().encode(text).length }
    },
    read: async path => {
      calls.read++
      const text = files[path]
      if (text === undefined) throw new Error(`ENOENT: ${path}`)
      return text
    },
    write: async (path, text) => {
      calls.write++
      files[path] = text
    },
  }
  return { io, files, calls }
}

test('parseMaskArgs: @와 따옴표를 떼고, 비면 null', () => {
  expect(parseMaskArgs('@a.log')).toBe('a.log')
  expect(parseMaskArgs('a.log')).toBe('a.log')
  expect(parseMaskArgs('@"my logs/a.log"')).toBe('my logs/a.log')
  expect(parseMaskArgs('  ')).toBe(null)
})

test('maskFile: 가린 것이 있으면 덮어쓰고 라벨별 건수를 알린다', async () => {
  const { io, files } = fakeIo({ 'a.log': 'from hong.gildong@example.com to kim.chulsoo@example.com\n' })
  expect(await maskFile(io, 'a.log', withEmail)).toBe('a.log: 민감정보 2건 마스킹 (이메일 2)')
  expect(files['a.log']).not.toContain('hong.gildong@example.com')
  expect(files['a.log']).not.toContain('kim.chulsoo@example.com')
})

test('maskFile: 가릴 것이 없거나 빈 파일이면 쓰지 않는다', async () => {
  for (const text of ['plain log line\n', '']) {
    const { io, calls } = fakeIo({ 'a.log': text })
    expect(await maskFile(io, 'a.log', withEmail)).toBe('a.log: 민감정보를 찾지 못했습니다.')
    expect(calls.write).toBe(0)
  }
})

test('maskFile: 없는 경로·폴더는 찾을 수 없다고 알린다', async () => {
  expect(await maskFile(fakeIo({}).io, 'none.log', withEmail)).toBe('파일을 찾을 수 없습니다.')
  expect(await maskFile(fakeIo({}, { dirs: ['logs'] }).io, 'logs', withEmail)).toBe('파일을 찾을 수 없습니다.')
})

test('maskFile: 4 MiB를 넘으면 읽지 않고 크기를 알린다', async () => {
  const { io, calls } = fakeIo({ 'big.log': 'x' }, { sizes: { 'big.log': 12.3 * 1024 * 1024 } })
  expect(await maskFile(io, 'big.log', withEmail)).toBe('최대 파일 크기(4 MiB)를 초과합니다: 12.3 MiB')
  expect(calls.read).toBe(0)
})

test('maskFile: NUL이 있으면 바이너리로 보고, U+FFFD가 있으면 UTF-8이 아니라고 보고 쓰지 않는다', async () => {
  const secret = 'hong.gildong@example.com'
  const bin = fakeIo({ 'a.bin': `${secret}\u0000` })
  const message = await maskFile(bin.io, 'a.bin', withEmail)
  expect(message).toBe('지원하지 않는 파일입니다.')
  expect(bin.calls.write).toBe(0)
  const cp949 = fakeIo({ 'a.log': `${secret} ��` })
  const message2 = await maskFile(cp949.io, 'a.log', withEmail)
  expect(message2).toBe('UTF-8 형식이 아닙니다.')
  expect(cp949.calls.write).toBe(0)
  expect(message + message2).not.toContain(secret)
})
