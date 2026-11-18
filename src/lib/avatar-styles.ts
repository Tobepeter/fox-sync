// DiceBear 9 的头像风格，键名和 @dicebear/collection 导出一致；不含 initials（会把设备 ID 当字母显示，和“名字”重复）
// 前 6 套是 CC0 的拟人风格，首次启动从中随机；Rust data.rs 的 AVATAR_STYLES 与此保持一致
export const HUMAN_STYLES = [
  'lorelei',
  'notionists',
  'openPeeps',
  'loreleiNeutral',
  'notionistsNeutral',
  'thumbs',
] as const

export const AVATAR_STYLES = [
  ...HUMAN_STYLES,
  'adventurer',
  'adventurerNeutral',
  'avataaars',
  'avataaarsNeutral',
  'bigEars',
  'bigEarsNeutral',
  'bigSmile',
  'micah',
  'miniavs',
  'personas',
  'dylan',
  'toonHead',
  'funEmoji',
  'croodles',
  'croodlesNeutral',
  'bottts',
  'botttsNeutral',
  'pixelArt',
  'pixelArtNeutral',
  'glass',
  'icons',
  'identicon',
  'rings',
  'shapes',
] as const

export type AvatarStyle = (typeof AVATAR_STYLES)[number]

export const styleLabel = (style: string) =>
  style.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())

// CC BY 4.0 的风格需要署名
export const AVATAR_CREDITS = [
  ['Adventurer', 'Lisa Wischofsky'],
  ['Big Ears', 'The Visual Team'],
  ['Big Smile', 'Ashley Seo'],
  ['Croodles', 'vijay verma'],
  ['Dylan', 'Natalia Spivak'],
  ['Fun Emoji', 'Davis Uche'],
  ['Micah', 'Micah Lanier'],
  ['Miniavs', 'Webpixels'],
  ['Personas', 'Draftbit'],
  ['Toon Head', 'Johan Melin'],
] as const
