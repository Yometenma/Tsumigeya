// contextBridge 白名单桥：只暴露 window.tsumi（§3.5）。
// 这里不 import 任何 Node 内置模块——窗口用 sandbox: true，preload 只能要求 electron。
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { encodeBridgeError } from '../shared/bridge-error'

/** 主进程事件形态（与 api/client.ts 的 CoreEvent 保持一致）。 */
export interface CoreEvent {
  event: 'progress' | 'log' | 'dialog' | 'ready' | 'gameStarted' | 'gameExited'
  requestID?: string
  name?: string
  key?: string
  detail?: unknown
  arguments?: Record<string, string>
  message?: string
  dialogID?: string
  kind?: 'alert' | 'confirm'
  title?: string
  nodeVersion?: string
  /** M3.5：进程事件的字段。 */
  gameId?: string
  pid?: number
  engine?: string
  startedAt?: string
  exitCode?: number | null
  signal?: string | null
}

interface InvokeResponse<T> {
  ok: boolean
  result?: T
  error?: { message?: string; key?: string; arguments?: Record<string, unknown> }
}

export interface TsumiBridge {
  invoke<T>(method: string, params?: unknown): Promise<T>
  startTask<T>(method: string, params?: unknown): { requestId: string; promise: Promise<T> }
  cancel(requestId: string): void
  dialogReply(dialogId: string, accepted: boolean): void
  pickPath(kind: 'file' | 'folder'): Promise<string | null>
  /**
   * 拖拽进窗口的 File → 绝对路径。
   * Electron 32+ 已移除 File.path，必须走 webUtils.getPathForFile（否则恒为 undefined）。
   */
  pathForFile(file: File): string | null
  onEvent(listener: (event: CoreEvent) => void): () => void
  readonly platform: string
  readonly appVersion: string
}

/**
 * 把 key / arguments 编进 message 一起过 contextBridge。
 * 实现见 src/shared/bridge-error.ts（preload 与渲染层共享，标记常量只有一处定义）。
 */
function decorateErrorForBridge(payload: InvokeResponse<unknown>['error']): Error {
  return encodeBridgeError(payload)
}

function requestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

async function invokeWithId<T>(id: string, method: string, params?: unknown): Promise<T> {
  const response = (await ipcRenderer.invoke('tsumi:invoke', {
    method,
    params,
    requestId: id
  })) as InvokeResponse<T>
  // 注意：**不要**在这里 throw 带自定义属性的 Error（contextBridge 会丢掉 key，
  // 见 decorateErrorForBridge 的注释）。渲染层用 decodeBridgeError 解回来。
  if (!response?.ok) throw decorateErrorForBridge(response?.error)
  return response.result as T
}

const bridge: TsumiBridge = {
  invoke<T>(method: string, params?: unknown): Promise<T> {
    return invokeWithId<T>(requestId(), method, params)
  },
  startTask<T>(method: string, params?: unknown): { requestId: string; promise: Promise<T> } {
    // 与 invoke 完全同一条路径，只是把 requestId 交出去给「取消」按钮用。
    const id = requestId()
    return { requestId: id, promise: invokeWithId<T>(id, method, params) }
  },
  cancel(id: string): void {
    ipcRenderer.send('tsumi:cancel', { requestId: id })
  },
  dialogReply(dialogId: string, accepted: boolean): void {
    ipcRenderer.send('tsumi:dialog', { dialogID: dialogId, accepted })
  },
  pickPath(kind: 'file' | 'folder'): Promise<string | null> {
    return ipcRenderer.invoke('tsumi:pick', { kind }) as Promise<string | null>
  },
  pathForFile(file: File): string | null {
    try {
      // webUtils 是 Electron 32+ 的官方替代（File.path 已被移除）。
      const target = webUtils.getPathForFile(file)
      return target || null
    } catch {
      return null
    }
  },
  onEvent(listener: (event: CoreEvent) => void): () => void {
    const handler = (_event: unknown, payload: CoreEvent): void => listener(payload)
    ipcRenderer.on('tsumi:event', handler as never)
    return () => {
      ipcRenderer.removeListener('tsumi:event', handler as never)
    }
  },
  platform: process.platform,
  appVersion: process.env.npm_package_version ?? '0.0.0'
}

contextBridge.exposeInMainWorld('tsumi', bridge)
