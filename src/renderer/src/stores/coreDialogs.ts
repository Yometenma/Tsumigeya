// core 对话框 store：把 core 的 ui.alert / ui.confirm 队列化后交给 CoreDialogHost 渲染，
// 用户应答后经 bridge.dialogReply 回给主进程（§4 coreDialogs.ts、§3.4）。
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { bridge, type CoreEvent } from '@/api/client'

export interface CoreDialog {
  dialogId: string
  kind: 'alert' | 'confirm'
  title: string
  message: string
}

export const useCoreDialogsStore = defineStore('coreDialogs', () => {
  /** 队列：同一时刻只显示一个（core 可能在队列里等应答，绝不能丢）。 */
  const queue = ref<CoreDialog[]>([])
  let unsubscribe: (() => void) | null = null

  const current = computed<CoreDialog | null>(() => queue.value[0] ?? null)
  const visible = computed(() => current.value !== null)

  function enqueue(dialog: CoreDialog): void {
    queue.value.push(dialog)
  }

  /** 处理一条主进程事件：只关心 dialog。 */
  function handleEvent(event: CoreEvent): void {
    if (event.event !== 'dialog' || !event.dialogID) return
    enqueue({
      dialogId: event.dialogID,
      kind: event.kind === 'confirm' ? 'confirm' : 'alert',
      title: event.title ?? '',
      message: event.message ?? ''
    })
  }

  function install(): void {
    if (unsubscribe) return
    unsubscribe = bridge().onEvent(handleEvent)
  }

  function dispose(): void {
    unsubscribe?.()
    unsubscribe = null
  }

  /** 应答当前对话框；alert 一律回答 true（core 只关心流程是否继续）。 */
  function reply(accepted: boolean): void {
    const dialog = queue.value.shift()
    if (!dialog) return
    bridge().dialogReply(dialog.dialogId, dialog.kind === 'alert' ? true : accepted)
  }

  function accept(): void {
    reply(true)
  }

  function dismiss(): void {
    reply(false)
  }

  return { queue, current, visible, enqueue, handleEvent, install, dispose, reply, accept, dismiss }
})
