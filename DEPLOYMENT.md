# 启航AACTP 时间官 - 部署指南

## 📱 微信小程序部署

### 一、准备工作

#### 1. 下载微信开发者工具
- 访问：https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html
- 下载并安装适合你操作系统的版本

#### 2. 注册微信小程序账号（可选，测试时不需要）
- 访问：https://mp.weixin.qq.com/
- 注册小程序账号
- 获取 AppID（测试时可以使用"测试号"）

### 二、本地开发和预览

#### 1. 编译小程序代码

在项目根目录执行：

```bash
# 开发模式（支持热更新）
pnpm run dev:weapp

# 或者生产模式（优化后的代码）
pnpm run build:weapp
```

编译完成后，代码会输出到 `dist` 目录。

#### 2. 在微信开发者工具中打开

1. 打开微信开发者工具
2. 选择"导入项目"
3. 项目路径选择：`/workspace/app-9br3x1tvwn41/dist`
4. AppID：
   - 如果有正式 AppID，填入你的 AppID
   - 如果没有，选择"测试号"或"不使用 AppID"
5. 项目名称：启航AACTP 时间官
6. 点击"导入"

#### 3. 预览和调试

- 在微信开发者工具中可以直接预览和调试
- 点击"预览"按钮，扫描二维码可以在真机上预览
- 点击"真机调试"可以在真机上调试

### 三、发布到微信小程序平台

#### 1. 上传代码

在微信开发者工具中：
1. 点击右上角"上传"按钮
2. 填写版本号（如：1.0.0）
3. 填写项目备注
4. 点击"上传"

#### 2. 提交审核

1. 登录微信公众平台：https://mp.weixin.qq.com/
2. 进入"版本管理"
3. 找到刚上传的版本
4. 点击"提交审核"
5. 填写审核信息：
   - 功能页面：选择所有主要页面
   - 功能描述：Toastmasters 会议计时工具
   - 测试账号：如果需要
6. 提交等待审核（通常 1-7 天）

#### 3. 发布上线

审核通过后：
1. 在"版本管理"中找到审核通过的版本
2. 点击"发布"
3. 小程序即可上线，用户可以搜索到

### 四、H5 网页版部署（备选方案）

如果暂时不想发布小程序，可以先部署 H5 版本：

```bash
# 编译 H5 版本
pnpm run build:h5
```

编译后的文件在 `dist` 目录，可以部署到任何静态网站托管服务：
- Vercel
- Netlify
- GitHub Pages
- 阿里云 OSS
- 腾讯云 COS

### 五、配置说明

#### 1. 小程序配置文件

主要配置文件：`src/app.config.ts`

```typescript
export default defineAppConfig({
  pages: [
    'pages/history/index',
    'pages/import/index',
    'pages/timeline/index',
    'pages/timer/index',
    'pages/settings/index'
  ],
  window: {
    backgroundTextStyle: 'light',
    navigationBarBackgroundColor: '#0f172a',
    navigationBarTitleText: '启航AACTP 时间官',
    navigationBarTextStyle: 'white'
  },
  tabBar: {
    color: '#6b7280',
    selectedColor: '#3b82f6',
    backgroundColor: '#ffffff',
    list: [
      {
        pagePath: 'pages/history/index',
        text: '会议',
        iconPath: 'assets/images/unselected/history.png',
        selectedIconPath: 'assets/images/selected/history.png'
      },
      {
        pagePath: 'pages/settings/index',
        text: '设置',
        iconPath: 'assets/images/unselected/settings.png',
        selectedIconPath: 'assets/images/selected/settings.png'
      }
    ]
  }
})
```

#### 2. 项目配置文件

`project.config.json` - 微信开发者工具配置

```json
{
  "miniprogramRoot": "./",
  "projectname": "aactp-timer",
  "description": "启航AACTP 时间官",
  "appid": "你的AppID",
  "setting": {
    "urlCheck": true,
    "es6": false,
    "enhance": true,
    "compileHotReLoad": false,
    "postcss": false,
    "minified": false
  },
  "compileType": "miniprogram"
}
```

### 六、注意事项

#### 1. 数据存储
- 当前使用本地存储（`Taro.getStorageSync`）
- 数据仅保存在用户设备上
- 不需要后端服务器
- 不需要数据库

#### 2. AI 解析功能
- AI 智能解析使用 Supabase Edge Function
- 如果 Edge Function 不可用，会自动降级到本地解析
- 不影响核心功能使用

#### 3. 隐私政策
微信小程序审核需要提供隐私政策，主要说明：
- 本应用不收集用户个人信息
- 所有数据仅存储在用户设备本地
- 不上传任何数据到服务器
- AI 解析功能仅处理会议流程文本，不涉及个人信息

#### 4. 功能限制
微信小程序环境限制：
- ✅ 本地存储：支持
- ✅ 震动反馈：支持
- ✅ 剪贴板：支持
- ❌ 文件系统：不支持（已使用本地存储替代）
- ❌ 真实音频播放：不支持（已使用震动替代）

### 七、常见问题

#### Q1: 没有 AppID 可以预览吗？
A: 可以！在微信开发者工具中选择"测试号"即可预览和调试。

#### Q2: 如何在手机上预览？
A: 在微信开发者工具中点击"预览"，用微信扫描二维码即可在手机上预览。

#### Q3: 审核需要多久？
A: 通常 1-7 天，首次提交可能需要更长时间。

#### Q4: 审核不通过怎么办？
A: 根据审核反馈修改后重新提交。常见问题：
- 需要补充隐私政策
- 需要提供测试账号
- 功能描述不清晰

#### Q5: 可以不发布小程序，只用 H5 版本吗？
A: 可以！编译 H5 版本后部署到任何网站托管服务即可。

### 八、技术支持

如有问题，可以：
1. 查看 Taro 官方文档：https://taro-docs.jd.com/
2. 查看微信小程序官方文档：https://developers.weixin.qq.com/miniprogram/dev/framework/

### 九、版本信息

- 项目名称：启航AACTP 时间官
- 版本：1.0.0
- 框架：Taro 4.1.10
- 支持平台：微信小程序、H5
- 开发语言：TypeScript + React
