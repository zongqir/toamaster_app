# ⚡ 快速开始 - 3 步部署微信小程序

## 📋 准备工作

你需要：
1. ✅ 一台电脑（Windows / macOS / Linux）
2. ✅ 下载本项目的所有文件
3. ✅ 10-20 分钟时间

## 🚀 三步部署

### 第 1 步：安装 Node.js 和 pnpm

1. 访问：https://nodejs.org/
2. 下载并安装 LTS 版本
3. 验证安装成功：
   ```bash
   node --version
   # 应该显示：v18.x.x 或 v20.x.x
   ```
4. 安装 pnpm（项目使用 pnpm 作为包管理器）：
   ```bash
   npm install -g pnpm
   pnpm --version
   ```

### 第 2 步：编译小程序代码

1. 打开终端（命令行）
2. 进入项目目录：
   ```bash
   cd /path/to/aactp-timer
   ```
3. 安装依赖：
   ```bash
   pnpm install
   ```
4. 编译代码：
   ```bash
   pnpm run build:weapp
   ```
5. 等待编译完成，代码会输出到 `dist` 目录

### 第 3 步：在微信开发者工具中预览

1. 下载微信开发者工具：
   - 访问：https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html
   - 下载并安装

2. 打开微信开发者工具

3. 导入项目：
   - 点击"导入项目"
   - 项目路径：选择 `dist` 目录
   - AppID：选择"测试号"
   - 点击"导入"

4. 预览：
   - 在模拟器中直接预览
   - 或点击"预览"按钮，扫码在手机上预览

## 🎉 完成！

现在你可以在微信开发者工具或手机上体验小程序了！

## 📖 更多信息

- **完整部署指南**：查看 [LOCAL_DEPLOYMENT.md](./LOCAL_DEPLOYMENT.md)
- **功能说明**：查看 [README.md](./README.md)
- **发布到微信平台**：查看 [DEPLOYMENT.md](./DEPLOYMENT.md)

## ❓ 遇到问题？

### 问题 1：pnpm install 很慢

使用国内镜像：
```bash
pnpm config set registry https://registry.npmmirror.com
pnpm install
```

### 问题 2：编译失败

检查 Node.js 版本：
```bash
node --version
# 应该是 v18.x.x 或 v20.x.x
```

如果版本不对，重新安装 Node.js。

### 问题 3：微信开发者工具无法导入

确保：
1. 已经运行过 `pnpm run build:weapp`
2. `dist` 目录存在
3. 选择的是 `dist` 目录，不是项目根目录

## 💡 提示

- **测试号**：不需要注册小程序账号，可以直接预览和调试
- **真机预览**：点击"预览"按钮，用微信扫码即可在手机上看到
- **发布上线**：需要注册小程序账号，详见 [DEPLOYMENT.md](./DEPLOYMENT.md)

---

**开始使用"启航AACTP 时间官"吧！⏱️**
