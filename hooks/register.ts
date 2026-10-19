import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'
import { buildConfig, loadUserFile, readOptions, userFilePath } from './config.ts'
import { isAllBypass, joinSegments, maskText, splitBypass } from './mask.ts'
import { formatCounts, maskFile, parseMaskArgs } from './mask-file.ts'

// 입력창 바로 위(AbovePrompt)에 한 줄로 띄웠다가 이 시간이 지나면 지운다
const NOTICE_MS = 5000
const notice = atom({ plugin: 'privacy-mask', key: 'notice' } as const, null)

// $.fs는 값으로 넘길 수 없다 (엔진이 $.noun.event(...) 호출 형태만 허용)
// Windows는 HOME이 따로 잡혀 있어도(Git Bash·네트워크 홈) 사용자 폴더가 USERPROFILE이라 먼저 본다. macOS·Linux엔 없다
const loadSettings = async ($: EngineInterface) => {
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME'))
  return loadUserFile({ exists: p => $.fs.exists(p), read: p => $.fs.read(p) }, userFilePath(home))
}

export const register: Register = (on, options) => {
  let hideTimer: Timer | undefined
  // 설정을 바꾸면 엔진이 모듈을 다시 불러 register가 새 options로 다시 돈다
  const opts = readOptions(options)
  // 다시 불러오면 타이머는 사라지고 $.state는 남는다. 지울 타이머가 없는 알림이 계속 떠 있지 않게 비운다
  // /mask는 마스킹을 꺼도 등록한다. 등록이 없으면 /mask @파일이 일반 메시지가 되어 원본이 첨부된다
  on('session.start', async ($, e, next) => {
    await update($, notice, () => null)
    await $.command.register({ name: 'mask', description: '파일을 마스킹해 원본에 덮어쓴다', argumentHint: '@파일' })
    return next(e)
  })
  on('prompt.submit', async ($, e, next) => {
    // 꺼 두면 설치하지 않은 것과 같다 (###도 지우지 않는다)
    if (!opts.enabled) return next(e)

    // 전부 제외 구간이면 설정을 읽지 않는다 (설정 오류로 막힌 상황에서도 보낼 수 있게)
    const segments = splitBypass(e.text)
    if (isAllBypass(segments)) return next({ ...e, text: joinSegments(segments) })

    // 설정 파일이 있는데 틀린 채 보내면 가릴 줄 안 값이 그대로 나가므로 막는다
    const loaded = await loadSettings($)
    if (!loaded.ok) return { drop: `privacy-mask: ${loaded.reason}` }

    const { text, counts } = maskText(e.text, buildConfig(opts, loaded.file))
    const { total, text: detail } = formatCounts(counts)
    if (total === 0) return next({ ...e, text })

    const result = await next({ ...e, text })
    const message = `민감정보 ${total}건 마스킹 (${detail})`
    // 연달아 보내면 앞 타이머가 새 알림을 일찍 지우지 않도록 다시 건다
    hideTimer?.cancel()
    await update($, notice, () => message)
    hideTimer = $.clock.after(NOTICE_MS, () => void update($, notice, () => null))
    return result
  }).catch(($, e, next) =>
    // 마스킹 전에 실패하면 원문이 나가지 않도록 전송을 막는다
    next.called ? next(e) : { drop: 'privacy-mask 오류로 전송을 막았습니다. 내용 확인 후 다시 보내주세요.' },
  )

  // 출력은 다음 턴에 Claude 컨텍스트로 들어간다. 파일 내용은 넣지 않는다 (maskFile 문구도 경로·건수만)
  on('command.run', { command: 'mask' }, async ($, e) => {
    const path = parseMaskArgs(e.args)
    if (path === null) return { text: '사용법: /mask @파일경로' }
    if (!opts.enabled) return { text: '마스킹 사용이 꺼져 있습니다.' }
    const loaded = await loadSettings($)
    if (!loaded.ok) return { text: `privacy-mask: ${loaded.reason}` }
    // 상대 경로는 $.fs가 세션 작업 폴더 기준으로 푼다
    const io = { stat: (p: string) => $.fs.stat(p), read: (p: string) => $.fs.read(p), write: (p: string, t: string) => $.fs.write(p, t) }
    return { text: await maskFile(io, path, buildConfig(opts, loaded.file)) }
  }).catch(() =>
    // 쓰는 도중 실패했을 수 있다. 오류 문구에 경로·값이 섞일 수 있어 그대로 보이지 않는다
    ({ text: 'privacy-mask 오류로 파일을 처리하지 못했습니다.' }),
  )

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const message = await read($, notice)
    if (message === null || e.props.hasSurvey) return next(e)
    const { Text } = $.ui.resolve(e)
    return h(Text, { dimColor: true }, message)
  })
}
