import { useMemo } from 'react'
import { createAvatar } from '@dicebear/core'
import * as collection from '@dicebear/collection'
import { avatarFontSize, avatarText, hasName } from '../lib/avatar-text'
import {
  AVATAR_STYLES,
  HUMAN_STYLES,
  type AvatarStyle,
} from '../lib/avatar-styles'

// 以设备 ID 为种子，同一台机器处处一样
type Preset = AvatarStyle
const isPreset = (value: unknown): value is Preset =>
  AVATAR_STYLES.includes(value as Preset)

// 底色取 Fox 系列主题：狐狸橙、奶油、淡紫、浅紫、杏色
const BACKGROUNDS = ['f2843a', 'fbe3c8', 'b1b8d7', 'd8c8f0', 'f6c79e']
// 昵称头像的底色，避开太浅的颜色，保证白字可读
const TEXT_BACKGROUNDS = ['#F2843A', '#5B3A29', '#8C6BD9', '#D9693A', '#6F7AB0']

function hash(text: string) {
  let h = 2166136261
  for (const c of text) h = Math.imul(h ^ c.codePointAt(0)!, 16777619)
  return h >>> 0
}

function Generated(props: { seed: string; preset: Preset; size: number }) {
  const src = useMemo(
    () => dataUri(props.seed, props.preset),
    [props.seed, props.preset],
  )
  return (
    <img
      src={src}
      width={props.size}
      height={props.size}
      alt=''
      draggable={false}
      className='shrink-0 rounded-full select-none'
    />
  )
}

/**
 * 头像：avatar 为 name 且设了昵称时显示昵称文字，否则按设备 ID 画预设风格；
 * 发送者没带风格或是旧版本的风格名时按 ID 算一套；没有 ID（curl 发的）用固定的机器人头像
 */
export function Avatar(props: {
  id?: string | null
  name?: string | null
  avatar?: string | null
  size: number
}) {
  const { id, size } = props
  // 没有身份的消息（curl、Agent、解不开的、旧模拟）统一用一个固定的机器人头像
  if (!id)
    return (
      <Generated seed='fox-sync-unknown' preset='botttsNeutral' size={size} />
    )
  if (props.avatar === 'name' && hasName(props.name)) {
    const { text, em } = avatarText(props.name!)
    return (
      <span
        className='inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full leading-none font-medium text-white select-none'
        style={{
          width: size,
          height: size,
          background: TEXT_BACKGROUNDS[hash(id) % TEXT_BACKGROUNDS.length],
          fontSize: avatarFontSize(size, em),
        }}
        aria-hidden='true'
      >
        {text}
      </span>
    )
  }
  // 发送者没带风格或是旧版本的风格名时，按 ID 从拟人风格里算一套
  const preset = isPreset(props.avatar)
    ? props.avatar
    : HUMAN_STYLES[hash(id) % HUMAN_STYLES.length]
  return <Generated seed={id} preset={preset} size={size} />
}

const dataUri = (seed: string, preset: Preset) =>
  createAvatar(collection[preset] as never, {
    seed,
    backgroundColor: BACKGROUNDS,
    radius: 50,
  }).toDataUri()

/**
 * 把头像画成 PNG（base64，不带前缀），给系统通知右侧的小图用。
 * 规则和 <Avatar> 一致：名字头像画字，预设和兜底画 DiceBear 的 SVG
 */
export async function renderAvatarPng(
  props: { id?: string | null; name?: string | null; avatar?: string | null },
  size = 128,
) {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = size
  const ctx = canvas.getContext('2d')!
  const { id } = props
  if (id && props.avatar === 'name' && hasName(props.name)) {
    const { text, em } = avatarText(props.name!)
    ctx.fillStyle = TEXT_BACKGROUNDS[hash(id) % TEXT_BACKGROUNDS.length]
    ctx.beginPath()
    ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = '#fff'
    ctx.font = `500 ${avatarFontSize(size, em)}px -apple-system, 'PingFang SC', sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text, size / 2, size / 2)
  } else {
    const preset = !id
      ? 'botttsNeutral'
      : isPreset(props.avatar)
        ? props.avatar
        : HUMAN_STYLES[hash(id) % HUMAN_STYLES.length]
    const image = new Image()
    image.src = dataUri(id ?? 'fox-sync-unknown', preset)
    await image.decode()
    ctx.drawImage(image, 0, 0, size, size)
  }
  return canvas.toDataURL('image/png').split(',')[1]
}
