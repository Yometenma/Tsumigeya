# 测试维护

在 `mac-native/` 中执行：

```bash
swift build
swift test --no-parallel
```

Swift 测试由同一个 `TsumigeyaTests` target 递归收集；移动到功能子目录不应改变测试发现结果。`Fixtures/` 中的真实页面继续通过 `Bundle.module` 读取，不依赖源码相对路径。

| 目录 | 主要判据 |
|---|---|
| `App` | 设置加载、观察链、视图绑定、请求及会话失效、窗口快照 |
| `CoreData` | 开发目录隔离、JSON 原子写入、损坏原件与未知字段保护 |
| `Engines` | 识别、二进制路径、启动计划、安装解压、版本比较及下载 |
| `Library` | 添加、导入、分类、删除与编号复用 |
| `Metadata` | DLsite 解析与缓存、来源预览确认、手改保护、批量队列及外部资料协议 |
| `Saves` | 定位、SHA-256、真实 ZIP 往返与先备份后写入 |
| `Settings` | 分组完整性、默认值与历史格式兼容 |
| `Assist` | 辅助安装恢复、文本处理及各引擎运行时脚本 |

## 窗口渲染测试单独启用

默认测试不执行会创建真实窗口的 4 项渲染回归（共 12 种界面状态）。它们使用当前生产视图和隔离示例数据，并不启动已安装的旧版应用；独立页面看起来可能不同于完整主窗口。

需要检查窗口像素和 OCR 时，明确启用：

```bash
TSUMIGEYA_UI_TESTS=1 swift test --no-parallel
```

这条命令可能使窗口短暂显示，请在可以接受桌面干扰时执行，不要将该环境变量长期设为默认值。负坐标不能保证窗口完全不可见；从 SSH 运行也仍可能影响 Mac 桌面。

只编译的 `swift build` 不会执行这些测试。显式运行应用的 `--snapshot` 模式也会创建真实窗口，不属于静默编译；参见 UI 验收文档。新增需要创建或显示窗口的测试也应使用同一启用条件，不要通过跳过整个业务测试组来规避窗口。位图算法、视图绑定、设置持久化和请求失效等不创建窗口的测试仍默认运行。

## 保留与去重原则

- 只删除已被同层或更强行为测试覆盖的重复判据；不能仅因文件年代、测试数量或旧功能名称就删除。
- Core 的合并函数、磁盘持久化、AppStore 请求失效和视图绑定属于不同边界，不因使用同一份数据就视为重复。
- 旧隐私设置不再生效，但其未知键保留及不阻止现有操作仍需回归。
- 单测和离屏快照不证明真实游戏、实时网站、材质及完整窗口交互可用；实测方法见根目录开发文档。

## 外部依赖与运行时脚本

下列 Swift 用例有条件启用，默认不访问真实服务或下载安装外部运行时。跳过必须如实报告，不能算作实测成功：

| 环境变量 | 验证内容 |
|---|---|
| `TSUMIGEYA_LIVE_ARTWORK=1` | 真实 DLsite 图片下载及本地缓存 |
| `TSUMIGEYA_LIVE_SCRAPING=1` | 真实 DLsite 批量查找与保存 |
| `TSUMIGEYA_TRANSLATION_TEST_ENDPOINT` | 真实翻译接口收发 |
| `TSUMIGEYA_WINE_TEST_ARCHIVE` | 指定的真实 Wine 归档安装与运行 |

辅助脚本还需要分别执行，不由 `swift test` 自动运行：

```bash
node --test Tests/TsumigeyaTests/Assist/runtime.test.cjs
python3 Tests/TsumigeyaTests/Assist/renpy_runtime_test.py
ruby Tests/TsumigeyaTests/Assist/rgss_runtime_test.rb
```

这里的脚本测试使用模拟宿主，不代替真实作品验收。不要将接口密钥、商业游戏或私人存档加入夹具。
