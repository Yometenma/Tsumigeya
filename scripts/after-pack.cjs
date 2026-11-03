// electron-builder afterPack 钩子：对 .app 做 ad-hoc 签名。
//
// 为什么需要：
//   Apple Silicon（arm64）要求所有可执行文件至少被签名（哪怕是 ad-hoc）。
//   完全未签名的 app 在 arm64 上会被 macOS 直接判为「已损坏」，而不是「无法验证开发者」。
//   仅设置 identity: null 只是「跳过签名」，并不会做 ad-hoc 签名，所以必须在这里手动补一次。
//
// ad-hoc 签名（codesign --sign -）的特点：
//   - 不需要开发者证书，任何人都能跑
//   - App 能被系统正常加载，不再报「已损坏」
//   - 但仍未通过公证，首次打开会提示「无法验证开发者」→ 右键打开即可
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appName = context.packager.appInfo.productFilename
  const appPath = path.join(context.appOutDir, `${appName}.app`)
  if (!fs.existsSync(appPath)) {
    console.warn(`[afterPack] 找不到 ${appPath}，跳过 ad-hoc 签名`)
    return
  }

  console.log(`[afterPack] 对 ${appPath} 做 ad-hoc 签名`)
  try {
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })

    // 顺手校验签名结果，让构建日志有据可查
    const verify = execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    if (verify) console.log(verify)
    console.log('[afterPack] ad-hoc 签名完成并通过校验')
  } catch (error) {
    // 签名失败必须让构建失败：否则会产出「已损坏」的 dmg，用户装完打不开
    console.error('[afterPack] ad-hoc 签名失败：', error.message)
    throw error
  }
}
