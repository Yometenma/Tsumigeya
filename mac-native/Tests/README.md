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

## 界面回归与旧代码清理

默认 `swift test --no-parallel` 包含 4 项真实窗口渲染回归，共 12 种界面状态。窗口可能短暂显示；负坐标和 SSH 都不能保证桌面隔离。这些测试验证像素与文字，不代替真实下载、交互和观感验收。

界面是否过时要沿应用入口追踪调用，不能因为文件仍能编译或仍被测试引用，就认定它是当前界面。当前游戏库采用侧边栏与详情布局；旧的整库卡片／列表组件及失效的 `listView` 开关已移除，渲染回归改验当前侧边栏、完整详情页、编辑和搜索结果。旧设置键仍作为原始 JSON 保留，兼容测试检查其不影响当前界面且不会在保存其他设置时丢失。

`swift build` 只编译；应用的 `--snapshot` 是单独的快照验收入口。不要通过默认跳过界面测试来掩盖旧代码残留。

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
