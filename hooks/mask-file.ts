import type { MaskConfig } from './config.ts'
import { maskText } from './mask.ts'

// $.fs는 값으로 넘길 수 없어 호출부에서 화살표로 감싸 넘긴다 (테스트는 메모리 맵으로 대신한다)
export type FileIo = {
  stat: (path: string) => Promise<{ kind: 'file' | 'dir' | 'other'; size: number }>
  read: (path: string) => Promise<string>
  write: (path: string, text: string) => Promise<void>
}

// $.fs.read가 이보다 큰 파일은 거부한다
export const MAX_FILE_BYTES = 4 * 1024 * 1024

// '@a.log' · '@"my logs/a.log"' · 'a.log' → 경로. 비면 null
export const parseMaskArgs = (args: string): string | null => {
  let path = args.trim().replace(/^@/, '')
  const quoted = /^(["'])(.*)\1$/.exec(path)
  if (quoted) path = quoted[2] ?? ''
  path = path.trim()
  return path ? path : null
}

// 입력창 위 알림과 /mask 결과가 같은 형식을 쓴다: '이메일 2, 전화번호 3'
export const formatCounts = (counts: Record<string, number>) => {
  const labels = Object.keys(counts)
  return {
    total: labels.reduce((s, k) => s + (counts[k] ?? 0), 0),
    text: labels.map(k => `${k} ${counts[k] ?? 0}`).join(', '),
  }
}

// 돌려주는 문구는 Claude 컨텍스트로 들어간다. 파일 내용은 넣지 않고 경로·건수·라벨만 쓴다
export const maskFile = async (io: FileIo, path: string, config: MaskConfig): Promise<string> => {
  const info = await io.stat(path).catch(() => null)
  if (info === null || info.kind !== 'file') return '파일을 찾을 수 없습니다.'
  if (info.size > MAX_FILE_BYTES) {
    return `최대 파일 크기(4 MiB)를 초과합니다: ${(info.size / 1024 / 1024).toFixed(1)} MiB`
  }
  const original = await io.read(path)
  if (original.includes('\u0000')) return '지원하지 않는 파일입니다.'
  // 런타임은 UTF-8로만 디코딩해 다른 인코딩의 글자가 U+FFFD로 바뀐다. 그대로 쓰면 원본이 깨진다.
  // 원래 U+FFFD가 든 UTF-8 파일도 거부되지만 안전한 쪽 실수로 받아들인다
  if (original.includes('�')) return 'UTF-8 형식이 아닙니다.'
  const { text, counts } = maskText(original, config, 'file')
  const { total, text: detail } = formatCounts(counts)
  if (total === 0) return `${path}: 민감정보를 찾지 못했습니다.`
  await io.write(path, text)
  return `${path}: 민감정보 ${total}건 마스킹 (${detail})`
}
