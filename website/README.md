# 官网

`website/` 是发布到 GitHub Pages 的静态官网，推送到 `main` 后由 `.github/workflows/pages.yml` 自动部署，地址为 <https://yometenma.github.io/Tsumigeya/>。首次使用需要在仓库 **Settings → Pages → Build and deployment** 中把来源设为 **GitHub Actions**。

- 版本号和交流群写在 `site-config.js`；在 `groups` 里加一项，「社区」区块会自动显示该群并替换“筹备中”卡片。
- 页面为纯 HTML／CSS／JS，无需构建。本地预览可在本目录执行 `python3 -m http.server`，再打开 <http://localhost:8000>。
- 中文标题字体 `assets/fonts/serif-sc.woff2` 是 Noto Serif SC 按页面现有文字裁剪的子集。修改文案后新增的字会回退到系统宋体，可用 fontTools 重新生成：

  ```bash
  pyftsubset NotoSerifSC[wght].ttf --text-file=<页面文字> --flavor=woff2 --layout-features='*' --output-file=assets/fonts/serif-sc.woff2
  ```

- 字体 Fraunces、Manrope、Noto Serif SC 以 SIL Open Font License 发布，许可证见 `assets/fonts/OFL-*.txt`。
- 演示画面来自『雲海のフロンティア』体験版（© New RPG Project），页面中已注明来源。
