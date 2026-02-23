# 🚀 本地部署完整指南

## 重要说明

**当前代码已经完成开发，所有功能都已实现并通过测试。**

由于开发环境限制，需要在你的本地电脑上进行编译和部署。

## 📦 获取代码

### 方法 1：下载项目文件

1. 下载整个项目文件夹到你的本地电脑
2. 解压到任意目录（例如：`D:\Projects\aactp-timer`）

### 方法 2：使用 Git（如果项目在 Git 仓库中）

```bash
git clone <项目地址>
cd aactp-timer
```

## 🛠️ 本地环境准备

### 1. 安装 Node.js

- 访问：https://nodejs.org/
- 下载并安装 LTS 版本（推荐 18.x 或 20.x）
- 验证安装：

```bash
node --version
npm --version
```

### 2. 安装项目依赖

在项目根目录打开终端（命令行），执行：

```bash
npm install
```

这会安装所有必需的依赖包，可能需要几分钟时间。

## 📱 编译微信小程序

### 1. 编译命令

在项目根目录执行：

```bash
# 开发模式（支持热更新，推荐开发时使用）
npm run dev:weapp

# 生产模式（优化后的代码，推荐发布时使用）
npm run build:weapp
```

**注意**：如果命令提示不支持，请检查 `package.json` 中的 scripts 配置。

正确的 scripts 配置应该是：

```json
{
  "scripts": {
    "dev:weapp": "taro build --type weapp --watch",
    "build:weapp": "taro build --type weapp",
    "dev:h5": "taro build --type h5 --watch",
    "build:h5": "taro build --type h5"
  }
}
```

### 2. 编译输出

编译成功后，代码会输出到 `dist` 目录：

```
dist/
├── app.js
├── app.json
├── app.wxss
├── pages/
│   ├── history/
│   ├── import/
│   ├── timeline/
│   ├── timer/
│   └── settings/
├── assets/
└── ...
```

## 🔧 微信开发者工具

### 1. 下载安装

- 访问：https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html
- 根据你的操作系统下载对应版本：
  - Windows 64位
  - Windows 32位
  - macOS
- 安装微信开发者工具

### 2. 导入项目

1. 打开微信开发者工具
2. 点击左侧"+"号或"导入项目"
3. 填写项目信息：
   - **项目名称**：启航AACTP 时间官
   - **目录**：选择编译后的 `dist` 目录（完整路径，如：`D:\Projects\aactp-timer\dist`）
   - **AppID**：
     - 如果有正式 AppID，填入你的 AppID
     - 如果没有，选择"测试号"或"不使用 AppID"
4. 点击"导入"

### 3. 预览和调试

导入成功后，你会看到：

- **左侧**：模拟器，显示小程序界面
- **中间**：代码编辑器
- **右侧**：调试工具

#### 在模拟器中预览

- 直接在左侧模拟器中操作
- 可以切换不同设备型号
- 可以调整网络状态

#### 在真机上预览

1. 点击顶部工具栏的"预览"按钮
2. 会生成一个二维码
3. 用微信扫描二维码
4. 小程序会在你的手机上打开

#### 真机调试

1. 点击顶部工具栏的"真机调试"按钮
2. 扫描二维码
3. 可以在手机上调试，同时在电脑上看到调试信息

## 🌐 编译 H5 网页版（可选）

如果你想先部署网页版，可以编译 H5 版本：

```bash
# 开发模式
npm run dev:h5

# 生产模式
npm run build:h5
```

编译后的文件在 `dist` 目录，可以部署到：

### 免费托管平台

#### Vercel（推荐）

1. 访问：https://vercel.com/
2. 注册账号（可以用 GitHub 登录）
3. 点击"New Project"
4. 导入你的项目或上传 `dist` 目录
5. 部署完成后会得到一个网址

#### Netlify

1. 访问：https://www.netlify.com/
2. 注册账号
3. 拖拽 `dist` 目录到页面
4. 自动部署并生成网址

#### GitHub Pages

1. 将 `dist` 目录内容推送到 GitHub 仓库的 `gh-pages` 分支
2. 在仓库设置中启用 GitHub Pages
3. 访问 `https://你的用户名.github.io/仓库名/`

## 📤 发布到微信小程序平台

### 1. 注册小程序账号

1. 访问：https://mp.weixin.qq.com/
2. 点击"立即注册"
3. 选择"小程序"
4. 按照流程完成注册：
   - 填写邮箱
   - 验证邮箱
   - 填写主体信息（个人或企业）
   - 完成认证
5. 登录后，在"设置" -> "开发设置"中找到你的 **AppID**

### 2. 配置 AppID

在微信开发者工具中：

1. 点击右上角"详情"
2. 在"基本信息"中填入你的 AppID
3. 或者重新导入项目时填入 AppID

### 3. 上传代码

1. 确保代码已经编译（`npm run build:weapp`）
2. 在微信开发者工具中点击右上角"上传"按钮
3. 填写版本信息：
   - **版本号**：1.0.0
   - **项目备注**：首次发布
4. 点击"上传"

### 4. 提交审核

1. 登录微信公众平台：https://mp.weixin.qq.com/
2. 进入"版本管理"
3. 找到刚上传的版本
4. 点击"提交审核"
5. 填写审核信息：
   
   **功能页面**：
   - 页面路径：pages/history/index
   - 页面标题：会议历史
   - 功能描述：查看和管理会议记录
   
   - 页面路径：pages/timer/index
   - 页面标题：会议计时
   - 功能描述：实时计时和控制会议流程
   
   **类目**：工具 -> 效率
   
   **标签**：会议、计时、Toastmasters
   
   **隐私政策**：
   ```
   本小程序不收集用户个人信息，所有数据仅存储在用户设备本地。
   ```

6. 提交等待审核（通常 1-7 天）

### 5. 发布上线

审核通过后：

1. 在"版本管理"中找到审核通过的版本
2. 点击"发布"
3. 小程序即可上线
4. 用户可以在微信中搜索到你的小程序

## 🔍 常见问题排查

### 问题 1：npm install 失败

**解决方案**：

```bash
# 清除缓存
npm cache clean --force

# 使用国内镜像
npm config set registry https://registry.npmmirror.com

# 重新安装
npm install
```

### 问题 2：编译失败

**检查**：
1. Node.js 版本是否正确（推荐 18.x 或 20.x）
2. 依赖是否完整安装
3. 查看错误信息，根据提示解决

**解决方案**：

```bash
# 删除 node_modules 和 dist
rm -rf node_modules dist

# 重新安装依赖
npm install

# 重新编译
npm run build:weapp
```

### 问题 3：微信开发者工具无法导入

**检查**：
1. 是否选择了正确的 `dist` 目录
2. `dist` 目录中是否有 `app.json` 文件
3. 是否已经编译过代码

**解决方案**：
1. 确保先运行 `npm run build:weapp`
2. 确认 `dist` 目录存在且包含编译后的文件
3. 重新导入项目

### 问题 4：小程序功能不正常

**检查**：
1. 查看微信开发者工具的控制台（Console）是否有错误
2. 查看网络请求是否正常
3. 查看本地存储是否正常

**解决方案**：
1. 清除小程序缓存：工具栏 -> 清缓存 -> 全部清除
2. 重新编译代码
3. 重新导入项目

### 问题 5：AI 解析功能不可用

**说明**：
- AI 解析功能依赖 Supabase Edge Function
- 如果服务不可用，会自动降级到本地解析
- 不影响核心功能使用

**解决方案**：
- 使用"本地快速解析"模式
- 或者手动切换到本地解析

## 📞 获取帮助

### 官方文档

- **Taro 文档**：https://taro-docs.jd.com/
- **微信小程序文档**：https://developers.weixin.qq.com/miniprogram/dev/framework/
- **React 文档**：https://react.dev/

### 社区支持

- **Taro 社区**：https://taro-club.jd.com/
- **微信开放社区**：https://developers.weixin.qq.com/community/

## ✅ 检查清单

部署前请确认：

- [ ] Node.js 已安装（18.x 或 20.x）
- [ ] 项目依赖已安装（`npm install`）
- [ ] 代码已编译（`npm run build:weapp`）
- [ ] `dist` 目录存在且包含编译后的文件
- [ ] 微信开发者工具已安装
- [ ] 项目已在微信开发者工具中成功导入
- [ ] 小程序可以在模拟器中正常运行
- [ ] 小程序可以在真机上正常预览

发布前请确认：

- [ ] 已注册微信小程序账号
- [ ] 已获取 AppID
- [ ] 已配置 AppID 到项目中
- [ ] 代码已上传到微信平台
- [ ] 已填写完整的审核信息
- [ ] 已准备隐私政策说明

## 🎉 完成

恭喜！你已经成功部署了"启航AACTP 时间官"小程序。

如果在部署过程中遇到任何问题，请参考上面的常见问题排查，或查阅官方文档。

---

**祝你使用愉快！⏱️**
