#!/bin/bash

echo "🚀 启航AACTP 时间官 - 微信小程序编译"
echo "=================================="
echo ""

# 检查 node_modules
if [ ! -d "node_modules" ]; then
    echo "📦 首次运行，正在安装依赖..."
    npm install
    echo ""
fi

echo "🔨 正在编译微信小程序..."
echo ""

# 编译小程序
npm run build:weapp

echo ""
echo "✅ 编译完成！"
echo ""
echo "📱 下一步操作："
echo "1. 下载微信开发者工具：https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html"
echo "2. 打开微信开发者工具"
echo "3. 选择'导入项目'"
echo "4. 项目路径选择：$(pwd)/dist"
echo "5. AppID 选择'测试号'（如果没有正式 AppID）"
echo "6. 点击'导入'即可预览"
echo ""
echo "💡 提示：编译后的代码在 dist 目录中"
echo ""
