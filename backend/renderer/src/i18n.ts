// vue-i18n 初始化：zh-CN 为唯一语言，fallback 也是它（§4 i18n.ts）。
import { createI18n } from 'vue-i18n'
import zhCN from './locales/zh-CN.json'

export const SUPPORTED_LOCALES = ['zh-CN'] as const

export const i18n = createI18n({
  legacy: false,
  globalInjection: true,
  locale: 'zh-CN',
  fallbackLocale: 'zh-CN',
  messages: { 'zh-CN': zhCN }
})

export type MessageSchema = typeof zhCN
