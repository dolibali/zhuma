# Zhuma 品牌资源

`icon-source.png` 是用户确认的唯一原图（1254×1254 RGBA），原始文件保持不变，SHA-256：

```text
e0fd8cc6d4706ad60af35d6ea12415f36582fdd8cae92e0a20d390538475bf00
```

## 实际应用图标

用户要求去除 Dock 和应用内部图标的外侧黑边。本轮只将**原图圆角蓝色轮廓之外的深色背景改为透明**，不重新生成、不重绘 Z、不改渐变颜色，不去掉图标内部的深色底板。

- `icon-transparent.png`：与原图同尺寸的透明派生母版。全部 RGB 像素与原图逐像素一致，只改外部 alpha；没有裁切或拉伸。
- `icon.png`：透明母版缩放得到的 1024 PNG，README 和桌面使用。
- `icons/icon-*.png`：16—1024 的无损 PNG，包括内部 24／34 CSS 像素的 1×、2×、3× 资源。
- `icon-manifest.json`：原图、透明母版与导出尺寸的校验值及可重复的 alpha 处理策略。
- `export_icons.py`：从原图沿已有蓝色外轮廓提取 alpha 后导出。只对已确认原图生效，不是画图脚本。`--check` 复算并比对派生母版和全部尺寸。
- `social-preview.png`：使用同一透明资源更新既有分享卡片。GitHub Social preview 是否已上传需另行核实。

`pnpm brand:check` 在 CI 中解码 PNG，检查原图校验值、原图／派生母版 RGB 一致、外边缘 alpha 为零以及中心保持不透明，避免下一次构建又生成黑底。普通构建只需 Node.js 和 macOS iconutil，不需要 Pillow。

桌面直接使用生成的 `.icns`；应用启动时设置本次构建的透明 Dock 图标，不清空系统 Dock 或其他应用缓存。UI 无额外背景、裁切、滤镜或阴影，缓存版本根据派生资源更新。任何后续改变 Z 形状、颜色或新母版都需用户确认。
