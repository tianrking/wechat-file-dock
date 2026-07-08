# WeChat File Dock

一个轻量的微信文件传输助手桌面工具。

它把 `https://filehelper.weixin.qq.com/` 放到隐藏会话里运行，前台只保留文件接收、扫码、文本发送和账号管理。

## 能力

- 扫码登录，二维码直接嵌入应用界面
- 多账号独立会话，不共用 Cookie
- 关闭窗口隐藏到托盘，后台继续接收
- 新文件自动保存到本机，可按类型过滤
- 下载按日期和账号归档，避免文件名冲突
- 快速文本优先通过隐藏网页会话发送，DOM 发送作为兜底
- 支持全局界面缩放

## 开发

```powershell
npm install
npm run dev
```

## 构建

```powershell
npm run build
npm run dist
```

## 清理

```powershell
npm run clean
```

清理本地构建产物、Playwright 验证截图和开发日志。运行中的开发进程可能会占用 `dev.log`，脚本会跳过被占用文件并继续。

## 边界

会话仍以微信网页端为准。服务器要求重新登录时，应用会回到扫码状态。

自动接收依赖当前网页结构。微信改版后，可能需要更新 `src/preload/wechatPreload.ts` 的选择器。
