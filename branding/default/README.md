# Zhuma 品牌资源

唯一母版是用户最终确认并上传的 `icon-source.png`（1254×1254 RGBA），保留原始文件字节。SHA-256：

```text
e0fd8cc6d4706ad60af35d6ea12415f36582fdd8cae92e0a20d390538475bf00
```

**不重新生成、不程序重绘、不改颜色、不添加纹理、不裁切或额外遮罩，也不先转换成 JPEG。** 所有桌面和内部图标只从这张 PNG 按比例缩放导出。

- `icon.png`：1024×1024 PNG，README 和桌面资源共用。
- `icons/icon-*.png`：16—1024 像素的无损 PNG，包含内部 24／34 CSS 像素的 1×、2×、3× 资源。
- `icon-manifest.json`：母版与各导出文件的尺寸、SHA-256，构建和 CI 都检查。
- `export_icons.py`：维护者导出脚本（Pillow）。它只缩放原图；正常构建直接使用已提交的导出资源，不需要 Python。
- `social-preview.png`：1280×640 分享卡片，使用同一原图缩放后放入既有版式。README 已使用 `icon.png`；GitHub Social preview 是否已上传应单独确认。

`pnpm brand:check` 校验资源。桌面准备阶段将已导出的 PNG 尺寸封装成 `.icns`，打包器直接使用该原生容器，不再从 JPEG 或旧图标缓存重新转换。开发版的缓存标识包含 ICNS 校验值；内部 UI 使用不同像素密度资源和母版版本标识，避免误取旧资源。

变更母版需要用户明确确认，并同步更新固定校验值和导出记录；不得以风格相似的重绘图冒充原图。
