# WeChat File Dock

一个面向微信文件传输助手网页端的跨平台桌面壳。

目标不是绕过微信，而是把官方 `https://filehelper.weixin.qq.com/` 做成长期常驻、独立多账号、可自动接管下载的桌面工作台。

## 能力

- 微信官方扫码登录，账号会话保存在 Electron 持久化分区里
- 多账号独立 Profile，不共用 Cookie
- 关闭窗口时隐藏到托盘，后台保持网页会话
- 新文件出现后由页面注入脚本保守点击下载按钮
- Electron 主进程接管下载并按日期/账号保存
- 登录失效时工作台会提示重新扫码
- 支持快速文本发送的 best-effort 自动填入

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

## 重要边界

微信服务端仍可能让网页登录态过期。本应用不会绕过失效策略；失效时会把窗口弹出来，让用户重新扫码。

自动下载依赖网页 DOM。微信改版后可能需要更新 `src/preload/wechatPreload.ts` 里的候选选择器。
