/** 字节数写成 1.2 MB 这样，1024 进制 */
export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = -1
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/** 最后在线时间写成「刚刚 / 5 分钟前 / 3 小时前 / 2 天前」；Syncthing 没见过的设备返回空串 */
export function formatSeen(iso: string | null, now = Date.now()) {
  if (!iso) return ''
  const at = Date.parse(iso)
  // Syncthing 对从没连上过的设备给的是 1970 年
  if (Number.isNaN(at) || at < Date.UTC(2000, 0, 1)) return ''
  const minutes = Math.floor((now - at) / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}

/** Syncthing 的文件夹状态写成中文；忙碌中的返回 busy，界面用来转圈 */
export function folderState(state: string, needBytes: number) {
  switch (state) {
    case 'idle':
      return needBytes > 0
        ? { text: '未完成', tone: 'warn' as const }
        : { text: '已同步', tone: 'ok' as const }
    case 'scanning':
    case 'scan-waiting':
      return { text: '扫描中', tone: 'busy' as const }
    case 'syncing':
    case 'sync-preparing':
    case 'sync-waiting':
    case 'cleaning':
    case 'clean-waiting':
      return { text: '同步中', tone: 'busy' as const }
    case 'paused':
      return { text: '已暂停', tone: 'muted' as const }
    case 'error':
      return { text: '出错', tone: 'error' as const }
    default:
      return { text: '未知', tone: 'muted' as const }
  }
}

/** Syncthing 的文件夹类型；双向是默认，不显示 */
export const folderKinds: Record<string, string> = {
  sendonly: '仅发送',
  receiveonly: '仅接收',
  receiveencrypted: '加密接收',
}

/** 连接方式：局域网、直连（经公网直接连上）、经中转；局域网用 Syncthing 自己的判定 */
export function connectionKind(kind: string, local: boolean) {
  if (kind.startsWith('relay')) return '经中转'
  if (local) return '局域网'
  return kind ? '直连' : ''
}

// Syncthing 出错原因是英文，常见的几种换成中文，认不出的原样显示
const ERRORS: [RegExp, string][] = [
  [/permission denied|operation not permitted/i, '没有权限读写'],
  [/no such file or directory/i, '文件或目录不存在'],
  [/modified but not rescanned/i, '文件刚改过，下次扫描后再同步'],
  [/insufficient space|no space left/i, '磁盘空间不足'],
  [/file name too long/i, '文件名太长'],
  [/invalid filename|contains invalid/i, '文件名在这台电脑上不合法'],
  [/folder path missing/i, '文件夹路径不存在'],
  [/peers who had this file went away/i, '有这个文件的设备离线了'],
  [
    /no connected device has the required version/i,
    '在线的设备上都没有需要的版本',
  ],
]

export function syncError(text: string) {
  return ERRORS.find(([re]) => re.test(text))?.[1] ?? text
}
