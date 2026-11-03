# M2 前置调研：DLsite 元数据获取（2026-11-04 实测）

> **本文是调研记录，不是契约。** M2 开工前先读它，能省掉重复踩坑。
> 结论在 §4，赶时间的只看那节。

## 1. 网络可达性（本机 Windows 实测）

| 目标 | 直连 | 走系统代理 `127.0.0.1:7897` |
|---|---|---|
| `www.dlsite.com` 作品页 | ❌ 超时（`http=000`，12s） | ✅ `http=200`，0.4s |
| `img.dlsite.jp` 封面图 | 未测（同域策略，预计同结果） | — |
| `api.github.com` | ✅ | ✅ |
| `raw.githubusercontent.com` | ❌ DNS 失败 | ✅ `http=200` |

**含义**：M2 的数据源（DLsite）和 M1 的引擎源（GitHub raw）一样，**都依赖系统代理**。
产品侧注入 `net.fetch` 会自动继承 Chromium/系统代理，所以**代码路径没问题**；
但纯 Node 脚本、vitest、curl 验收必须显式 `-x` 或设代理环境变量，否则一律超时。

## 2. 页面结构（RJ294126 实测）

```
GET https://www.dlsite.com/maniax/work/=/product_id/{RJ}.html
Cookie: adultchecked=1
```

- 页面 ~61KB，**不是 SPA 壳**，HTML 直出。
- R18 作品有年龄确认，但**加了 `adultchecked=1` cookie 后仍能拿到作品名与 og 标签**；
  详情表（标签/分类）本来就不在首屏 HTML 里。

### 2.1 能直接拿到的（已实测解析成功）

| 字段 | 来源 | 示例 |
|---|---|---|
| 作品名 | `<h1 id="work_name">` | `純愛おま○こ当番【アップデート版】` |
| 完整标题（含社团） | `<meta property="og:title">` | `純愛おま○こ当番【アップデート版】 [青春×フェティシズム] \| DLsite` |
| 简介 | `<meta property="og:description">` | 长描述 |
| 封面图 URL | `<meta property="og:image">` | `https://img.dlsite.jp/.../RJ294126_img_main.jpg` |
| 社团名 | 面包屑 `circle/profile/=/maker_id/{RG}.html` 的 `<span>` | `青春×フェティシズム` |
| 社团 ID | 同上正则 `maker_id/(RG\d+)` | `RG51931` |

### 2.2 **最佳数据源：页面末尾的 `var contents = {...}`** ⭐

这是本调研最重要的发现。页面 `</body>` 前有一段：

```html
<script type="text/javascript">var contents = {"impression":[],"detail":[{...}],"time":0.0009410381317138672};</script>
```

`JSON.parse` 后 `contents.detail[0]` 的完整字段（实测）：

```json
{
  "id": "RJ294126",
  "name": "純愛おま○こ当番【アップデート版】",
  "category": "maniax",
  "brand": "RG51931",
  "price": 750,
  "regist_date": "2020/08/30",
  "image_main": "//img.dlsite.jp/modpub/images2/work/doujin/RJ295000/RJ294126_img_main.jpg",
  "official_price": 1650,
  "series_id": "SRI0000026279",
  "series_name": "おま○こ当番",
  "title_id": "SRI0000026279",
  "title_name": "おま○こ当番",
  "discount": 825,
  "work_type": "SOU",
  "lang_options": "JPN",
  "price_with_tax": 1650
}
```

**优势**：纯 JSON、字段稳定、不用扛 HTML 结构改版、`\uXXXX` 由 JSON 解析器自动还原。
**提取方式**：正则 `var\s+contents\s*=\s*(\{[\s\S]*?\})\;\s*<\/script>`，再 `JSON.parse`。
（注意：直接对整个 `<script>` 做正则容易贪到别的脚本，**用 `contents` 变量名锚定 + 最后一个匹配**。）

**缺什么**：`detail[0]` 里**没有标签/分类（genre）**，也没有社团名（只有 `brand` = RG 号）。
→ 标签要么另找接口，要么这版 M2 先不做标签。

## 3. 试过但不可用的路径

| 路径 | 结果 |
|---|---|
| `GET /maniax/product/info/ajax?product_id=RJ...` | ❌ 返回 `[]`（空数组，带 cookie / referer 也一样） |
| `GET /maniax/api/product/{RJ}` | ❌ 404 |
| 页面 JSON-LD (`application/ld+json`) | ⚠️ 只有 `BreadcrumbList` 和 `WebSite`，**没有 Product 结构化数据**；面包屑里能拿到社团名和系列名 |
| 第三方服务 [null-base/dlsite-api](https://github.com/null-base/dlsite-api) | ⚠️ 文档站 `dlsite.null-base.com` 实测 404；仓库 0 star、2 commit，**不可依赖** |
| 第三方库 [bhrevol/dlsite-async](https://github.com/bhrevol/dlsite-async) | ✅ 功能最全（Python），可读源码抄它的解析逻辑；但它是 Python，不能直接用 |

> 参考资料：[dlsite-async README](https://github.com/bhrevol/dlsite-async)（展示了完整字段集：
> `work_name / maker_id / circle / genre[] / regist_date / work_image / work_type / age_category`），
> 以及 [Rust dlsite crate](https://docs.rs/dlsite/latest/dlsite/struct.DlsiteClient.html)
> —— 它 `get_product` 会**发 3 个请求**（HTML + AJAX + review），说明标签确实来自额外请求。

## 4. 结论与 M2 建议

### 4.1 技术结论

1. **必须走代理**：DLsite 直连超时。产品里靠 `net.fetch`（D9）没问题，但要有明确失败提示。
2. **数据源用 `var contents` 那段 JSON**，不要解析 HTML 表格。
3. **标签（genre）拿不到**——除非复刻 `dlsite-async` 的多请求流程（HTML → AJAX → review），
   但 AJAX 端点实测返回空数组，**短期不可行**。
4. 封面图在 `img.dlsite.jp`，需要走 `tsmg://` 之外的方式加载（远程 URL 直接用 `<img src>`，
   但 CSP 的 `img-src` 目前只有 `'self' data: tsmg:`，**必须加白名单**）。

### 4.2 建议的 M2 范围（缩小版，可落地）

**M2-A：RJ 号识别 + 元数据**（建议先做这个）

- 从游戏目录名 / 文件夹内 `readme` 猜 RJ 号（正则 `RJ\d{6,8}`）。
- 用户可手填 RJ 号。
- 拉元数据 → 写入 `GameRecord` 的扩展字段。
- **但注意：D10 规定 `gameArgs` schema 与上游一致**，新字段要**新增而非改语义**，
  且不能破坏上游读取（详见 §4.3）。
- 显示：封面、日文原名、社团、发售日、价格；封面墙模式。

**M2-B：标签/分类**（暂缓）

- 依赖额外接口，实测不可用，**不要在 M2-A 里承诺**。
- 替代方案：用 `work_type`（`SOU`=语音/ASMR 等）+ 用户自定义 tag 兜住。

### 4.3 与现有契约的冲突（**M2 开工必须先解决**）

现有 `GameRecord`（`src/renderer/src/api/client.ts`）：

```ts
export interface GameRecord {
  id: string
  gameTitle: string
  gamePath: string
  iconPath?: string
  tags?: string[]
  gameEngine: string
  gameArgs?: Record<string, unknown>
}
```

上游 Xenolauncher 只认这 6 个字段 + `id`。要加 DLsite 元数据，有两条路：

| 方案 | 做法 | 优点 | 风险 |
|---|---|---|---|
| **A（推荐）** | **不改 GameRecord**，另建 `<dataDir>/dlsite/<RJ>.json` 缓存，按 RJ 号关联；另加 `<dataDir>/library-meta.json` 存 `{ [gameId]: { rj, cover, circle, ... } }` | 完全不动上游 schema（D10 安全），删了也不影响启动 | 多一个文件要维护；导出/迁移要带上 |
| B | 给 `GameRecord` 加可选字段 | 一处搞定 | **违反 D10**，上游读到未知字段会 `{...value}` 合并保留（实测上游 saveGame 会 merge），但风险由我们承担 |

**建议 A**，并把「上游 schema 零改动」写进 M2 的验收标准。

## 5. 复现命令（留给下一个会话）

```bash
# 1. 确认网络（直连应当失败，代理应当 200）
curl -s -o /dev/null -w "%{http_code}\n" -m 12 "https://www.dlsite.com/maniax/work/=/product_id/RJ294126.html"
curl -s -o /dev/null -w "%{http_code}\n" -m 12 -x http://127.0.0.1:7897 "https://www.dlsite.com/maniax/work/=/product_id/RJ294126.html"

# 2. 抓页面并验证 contents JSON
curl -s -m 20 -x http://127.0.0.1:7897 \
  -H "Cookie: adultchecked=1" \
  "https://www.dlsite.com/maniax/work/=/product_id/RJ294126.html" -o /tmp/dl.html

node -e "
const h=require('fs').readFileSync('/tmp/dl.html','utf8');
const m=[...h.matchAll(/var\s+contents\s*=\s*(\{[\s\S]*?\})\;\s*<\/script>/g)].pop();
const d=JSON.parse(m[1]).detail[0];
console.log(d.id, d.name, d.brand, d.regist_date, d.image_main);
"
```

预期输出：`RJ294126 純愛おま○こ当番【アップデート版】 RG51931 2020/08/30 //img.dlsite.jp/...`
