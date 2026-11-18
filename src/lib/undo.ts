import { toast } from 'sonner'

// 照 FoxNudge / TalkMore：操作立即生效，同一个通知位倒计时“撤销 5s”；新的撤销顶掉旧的，过时自动消失
// 只给“一键生效、没有确认、东西会从眼前消失”的操作用（忽略大文件、忽略设备请求、忽略文件夹邀请）；
// 开关类拨回去就是撤销，有确认框的危险操作不加
const ID = 'undo'
const MS = 5000
let stopCurrent = () => {}

export function offerUndo(label: string, undo: () => unknown) {
  stopCurrent()
  const expires = Date.now() + MS
  let previous = -1
  let done = false
  const stop = () => {
    done = true
    clearInterval(timer)
  }
  function update() {
    if (done) return
    const seconds = Math.ceil((expires - Date.now()) / 1000)
    if (seconds <= 0) {
      stop()
      toast.dismiss(ID)
      return
    }
    if (seconds === previous) return
    previous = seconds
    toast(label, {
      id: ID,
      duration: Infinity,
      onDismiss: stop,
      action: {
        label: `撤销 ${seconds}s`,
        onClick: (event) => {
          event.preventDefault()
          stop()
          toast.dismiss(ID)
          void undo()
        },
      },
    })
  }
  const timer = window.setInterval(update, 250)
  stopCurrent = stop
  update()
}
