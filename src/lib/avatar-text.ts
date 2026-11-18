// 中日韩等全角字符算 2 个宽度，其余算 1 个
const wide = (c: string) => /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u.test(c)

export const AVATAR_TEXT_WIDTH = 4

/** 昵称最多取 4 个半角宽度：中文 2 个、英文 4 个；返回文字、宽度和估算的字宽（中文 1em，其余 0.6em） */
export function avatarText(name: string) {
  let text = ''
  let width = 0
  let em = 0
  for (const c of [...name.trim()]) {
    const w = wide(c) ? 2 : 1
    if (width + w > AVATAR_TEXT_WIDTH) break
    text += c
    width += w
    em += w === 2 ? 1 : 0.6
  }
  return { text, width, em }
}

/** 文字总宽约占直径的 72%，单字不超过直径的一半 */
export function avatarFontSize(size: number, em: number) {
  return (
    Math.round(Math.min(size * 0.5, (size * 0.72) / Math.max(em, 1)) * 10) / 10
  )
}

export const NAME_LIMIT = 16

/** 和 Rust clean_name 一致：只留各国文字、数字、空格和 - _ . ·，合并空白，最多 16 个字 */
export function cleanName(input: string) {
  const kept = [...input.replace(/\s/gu, ' ')]
    .filter((c) => /[\p{L}\p{N} \-_.·]/u.test(c))
    .join('')
  const name = [...kept.split(' ').filter(Boolean).join(' ')]
    .slice(0, NAME_LIMIT)
    .join('')
    .trim()
  return name
}

/** 清洗后还有内容 */
export const hasName = (name?: string | null) =>
  !!name && cleanName(name) !== ''
