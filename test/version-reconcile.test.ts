// 版本修正的回归测试：模拟「deps 下真实目录带 v、但 gameArgs 里没设或不带 v」的场景。
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createCoreHost, resolveCorePath } from '../src/main/core-host'

let dataDir: string
let host: ReturnType<typeof createCoreHost>

beforeAll(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'tsmg-ver-'))
  const modDir = path.join(dataDir, 'modules', 'nwjs')
  mkdirSync(modDir, { recursive: true })
  // 关键：deps 下的真实目录带 v 前缀（与用户 Mac 上的实测一致）
  const verDir = path.join(modDir, 'deps', 'version', 'v0.106.1', 'nwjs-sdk-v0.106.1-osx-arm64')
  mkdirSync(verDir, { recursive: true })
  writeFileSync(path.join(verDir, 'placeholder.txt'), 'x')

  writeFileSync(
    path.join(modDir, 'manifest.json'),
    JSON.stringify({
      name: 'NW.js',
      version: '1.4.4',
      gameArgs: {
        version: { type: 'multi-version', label: 'NW.js Version', 'version-script': 'nwjs.js' },
        cheat: { type: 'boolean', label: 'Cheat', default: false }
      }
    })
  )
  writeFileSync(path.join(modDir, 'launcher.js'), 'exports.launch = async () => {}')

  host = createCoreHost({
    dataDir,
    corePath: resolveCorePath({ env: {}, appPath: process.cwd() }),
    fetchImpl: async () => {
      throw new Error('network disabled in tests')
    },
    onEvent: () => undefined
  })
})

afterAll(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

describe('reconcileVersionArgs（修复 nwjs 点启动没反应）', () => {
  // 回归背景：上游 launcher 在未设置 version 时兜底 "0.106.1"（不带 v），
  // 而真实目录是 "v0.106.1"，拼出的路径不存在 → exec 静默失败。
  test('未设置 version 时，自动填入 deps 下的真实目录名', () => {
    const out = host.reconcileVersionArgs('nwjs', {})
    expect(out.version).toBe('v0.106.1')
  })

  test('version 是去 v 的 "0.106.1" 时，被修正成 "v0.106.1"', () => {
    const out = host.reconcileVersionArgs('nwjs', { version: '0.106.1' })
    expect(out.version).toBe('v0.106.1')
  })

  test('version 已经正确时保持原值', () => {
    const out = host.reconcileVersionArgs('nwjs', { version: 'v0.106.1' })
    expect(out.version).toBe('v0.106.1')
  })

  test('非 multi-version 参数不受影响', () => {
    const out = host.reconcileVersionArgs('nwjs', { cheat: true })
    expect(out.cheat).toBe(true)
  })

  test('不修改传入的对象（纯函数语义）', () => {
    const input = { version: '0.106.1' }
    host.reconcileVersionArgs('nwjs', input)
    expect(input.version).toBe('0.106.1')
  })

  test('模块未安装时不抛错、原样返回', () => {
    const out = host.reconcileVersionArgs('nonexistent', { foo: 'bar' })
    expect(out).toEqual({ foo: 'bar' })
  })
})
