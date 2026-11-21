# 官网

`website/` 是发布到 GitHub Pages 的静态官网，推送到 `main` 后由 `.github/workflows/pages.yml` 自动部署，地址为 <https://yometenma.github.io/Tsumigeya/>。首次使用需要在仓库 **Settings → Pages → Build and deployment** 中把来源设为 **GitHub Actions**。

- 版本号和交流群写在 `site-config.js`；在 `groups` 里加一项，「社区」区块会自动显示该群并替换“筹备中”卡片。每项可另写 `nameEn`／`nameJa`、`noteEn`／`noteJa`，供语言切换使用；没有对应译文时回落到中文。
- 页面为纯 HTML／CSS／JS，无需构建。本地预览可在本目录执行 `python3 -m http.server`，再打开 <http://localhost:8000>。
- 中文标题字体 `assets/fonts/serif-sc.woff2` 是 Noto Serif SC 按页面现有文字裁剪的子集。修改文案后新增的字会回退到系统宋体，可用 fontTools 重新生成：

  ```bash
  pyftsubset NotoSerifSC[wght].ttf --text-file=<页面文字> --flavor=woff2 --layout-features='*' --output-file=assets/fonts/serif-sc.woff2
  ```

- 字体 Fraunces、Manrope、Noto Serif SC 以 SIL Open Font License 发布，许可证见 `assets/fonts/OFL-*.txt`。
- 演示画面来自『雲海のフロンティア』体験版（© New RPG Project），页面中已注明来源。

## 语言切换

页面是单份 HTML，右上角提供 简体中文／English／日本語 切换，不复制三份页面。

- **简体中文是源**：文案直接写在 `index.html`，`app.js` 在首次应用语言时抓取原文，切回中文时还原，所以中文只需维护一处。
- **英文与日文在 `i18n.js`**：`window.TSUMIGEYA_I18N.ui.en`／`.ja` 是按 key 组织的字典，值可以是 HTML（保留 `<br>`、`<em>`、`<code>` 等强调结构）。
- **新增或修改文案**：在 `index.html` 给元素加 `data-i18n="key"`（内联 HTML），属性用 `data-i18n-alt`（图片 alt）、`data-i18n-aria`（aria-label）、`data-i18n-content`（meta content）；需要按语言换链接时用 `data-i18n-href="key"`，并在字典里补 `key.href`。然后两种译文各补一条。
- **默认语言**：访客存过选择就用存的；否则看网址 `?lang=en|ja`；再否则按浏览器语言偏好列表 `navigator.languages` 的顺序找第一个能对应的（`zh-*` → 简体中文，`ja-*` → 日文，`en-*` → 英文），全都对不上时用英文，`i18n.js` 的 `defaultLang` 只管“连偏好列表都为空”的情况。选择记录在 `localStorage` 的 `tsumigeya.lang`。
- **不按 IP 判断地区**：没有服务端，也不请求地理位置；系统是日文但浏览器用英文的访客会看到英文，这是按浏览器偏好而不是按国籍猜的结果。`zh-Hant`（台港澳）目前同样展示简体中文页面，没有单独的繁体版本。
- **窄屏**：760px 以下只显示当前语言，点一下循环到下一种，避免和下载按钮抢位置。桌面端是三个按钮，当前语言高亮。
- **字体**：`styles.css` 按 `html[lang]` 切字体栈，日文用系统明朝／黑体，英文用系统无衬线；中文子集字体不含假名，不要指望它渲染日文。
- **已知限制**：三语共用同一个网址，`<html lang>` 与标题、描述由脚本改写，静态 HTML 仍是中文，搜索引擎抓到的初始版本是中文；没有做 `hreflang` 与分语言静态页。日文标题在部分系统上会回落到系统字体，与中文标题的宋体观感不同。

改动后建议在浏览器里实际切一遍三种语言，检查首屏、引擎表、社区卡片和下载区的换行；离屏截图不能代替真实交互。
