// 任务 store：当前长任务的进度 / 取消 / 日志尾巴（§4 task.ts）。
// 事件订阅只装一次；overlay 从这里的 state 读。
import { defineStore } from 'pinia'
import { computed, ref, shallowRef } from 'vue'
import { bridge, type CoreEvent, type TsumiError } from '@/api/client'

export interface TaskState {
  requestId: string
  label: string
  key?: string
  detail?: unknown
  cancellable: boolean
}

/** 日志只留尾巴，避免无限增长。 */
const MAX_LOGS = 200

export const useTaskStore = defineStore('task', () => {
  const current = ref<TaskState | null>(null)
  const logs = ref<string[]>([])
  const error = shallowRef<unknown>(null)
  /** 事件订阅只装一次（App 挂载时调 install）。 */
  let unsubscribe: (() => void) | null = null

  const running = computed(() => current.value !== null)
  const progressKey = computed(() => current.value?.key)

  function pushLog(message: string): void {
    logs.value.push(message)
    if (logs.value.length > MAX_LOGS) logs.value.splice(0, logs.value.length - MAX_LOGS)
  }

  /** 处理一条主进程事件（进度 / 日志）。 */
  function handleEvent(event: CoreEvent): void {
    if (event.event === 'log' && event.message) {
      pushLog(event.message)
      return
    }
    if (event.event !== 'progress') return
    // 只认当前任务的进度；没有当前任务时忽略（避免旧请求的尾巴污染 UI）
    if (current.value && event.requestID && event.requestID !== current.value.requestId) return
    if (!current.value) return
    if (event.key) current.value.key = event.key
    if (event.arguments && event.arguments.module) current.value.label = event.arguments.module
    current.value.detail = event.detail ?? current.value.detail
  }

  function install(): void {
    if (unsubscribe) return
    unsubscribe = bridge().onEvent(handleEvent)
  }

  function dispose(): void {
    unsubscribe?.()
    unsubscribe = null
  }

  /**
   * 跑一个可取消的长任务。Promise 拒绝时把错误留在 store 里并原样抛出，
   * 调用方（页面）自己决定要不要弹 toast。
   */
  async function start<T>(
    label: string,
    task: { requestId: string; promise: Promise<T> },
    options: { cancellable?: boolean } = {}
  ): Promise<T> {
    current.value = {
      requestId: task.requestId,
      label,
      cancellable: options.cancellable !== false,
      detail: undefined
    }
    error.value = null
    try {
      return await task.promise
    } catch (caught) {
      error.value = caught
      throw caught
    } finally {
      // 只有自己仍是当前任务时才清空（避免并发任务互相清）
      if (current.value?.requestId === task.requestId) current.value = null
    }
  }

  /** 便捷封装：把 api 里返回 { requestId, promise } 的方法配上一个标签直接跑。 */
  function run<T>(
    label: string,
    task: { requestId: string; promise: Promise<T> },
    options: { cancellable?: boolean } = {}
  ): Promise<T> {
    return start(label, task, options)
  }

  function cancel(): void {
    if (!current.value) return
    bridge().cancel(current.value.requestId)
    current.value.cancellable = false
  }

  function isCancelled(value: unknown): boolean {
    return (value as TsumiError | undefined)?.key === 'error.cancelled'
  }

  function reset(): void {
    current.value = null
    logs.value = []
    error.value = null
  }

  return {
    current,
    logs,
    error,
    running,
    progressKey,
    install,
    dispose,
    handleEvent,
    pushLog,
    start,
    run,
    cancel,
    isCancelled,
    reset
  }
})
