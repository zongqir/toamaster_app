import fs from 'node:fs'
import path from 'node:path'
import {defineConfig, type UserConfigExport} from '@tarojs/cli'

import tailwindcss from 'tailwindcss'
import type {Plugin} from 'vite'
import {UnifiedViteWeappTailwindcssPlugin as uvtw} from 'weapp-tailwindcss/vite'

import devConfig from './dev'
import lintConfig from './lint'
import inlineIconSvg from './postcss-inline-icon-svg'
import prodConfig from './prod'

const base = String(process.argv[process.argv.length - 1])
const publicPath = /^http/.test(base) ? base : '/'
const outputRoot = process.env.TARO_ENV === 'h5' ? 'dist-h5' : 'dist'

function ensureWeappPageWxssFiles(root: string) {
  if (!fs.existsSync(root)) return

  const stack = [root]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue

    for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
      const entryPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(entryPath)
      }
    }

    const indexWxmlPath = path.join(current, 'index.wxml')
    const indexWxssPath = path.join(current, 'index.wxss')
    if (fs.existsSync(indexWxmlPath) && !fs.existsSync(indexWxssPath)) {
      fs.writeFileSync(indexWxssPath, '')
    }
  }
}

// https://taro-docs.jd.com/docs/next/config#defineconfig-辅助函数
export default defineConfig<'vite'>(async (merge) => {
  const baseConfig: UserConfigExport<'vite'> = {
    projectName: 'taro-vite',
    date: '2025-8-25',
    designWidth: 375,
    deviceRatio: {
      640: 2.34 / 2,
      750: 1,
      375: 2,
      828: 1.81 / 2
    },
    sourceRoot: 'src',
    outputRoot,
    plugins: ['@tarojs/plugin-generator'],
    alias: {
      '@': path.resolve(__dirname, '../src'),
      // 小程序场景使用微信polyfill版本supabase-js
      '@supabase/supabase-js': process.env.TARO_ENV === 'h5' ? '@supabase/supabase-js' : 'supabase-wechat-js'
    },
    defineConstants: {},
    copy: {
      patterns: [],
      options: {}
    },
    framework: 'react',
    compiler: {
      type: 'vite',
      vitePlugins: [
        {
          // 通过 vite 插件加载 postcss,
          name: 'postcss-config-loader-plugin',
          config(config) {
            // 加载 tailwindcss + 图标 SVG 内联插件
            if (typeof config.css?.postcss === 'object') {
              config.css?.postcss.plugins?.unshift(tailwindcss())
              config.css?.postcss.plugins?.push(inlineIconSvg)
            }
          }
        },
        {
          name: 'ensure-weapp-page-wxss-files',
          apply: 'build',
          closeBundle() {
            if (process.env.TARO_ENV !== 'weapp') return

            const pagesRoot = path.resolve(__dirname, '..', outputRoot, 'pages')
            ensureWeappPageWxssFiles(pagesRoot)
          }
        },
        uvtw({
          // rem转rpx
          rem2rpx: {
            rootValue: 24,
            propList: ['*'],
            transformUnit: 'rpx'
          } as any,
          // 除了小程序这些，其他平台都 disable
          disabled: process.env.TARO_ENV === 'h5',
          // 由于 taro vite 默认会移除所有的 tailwindcss css 变量，所以一定要开启这个配置，进行css 变量的重新注入
          injectAdditionalCssVarScope: true
        })
      ] as Plugin[]
    },
    mini: {
      // 禁止将图片转换为 base64，确保图片作为独立文件输出
      imageUrlLoaderOption: {
        limit: 0
      },
      fontUrlLoaderOption: {
        limit: 0
      },
      mediaUrlLoaderOption: {
        limit: 0
      },
      postcss: {
        pxtransform: {
          enable: true,
          config: {
            baseFontSize: 12,
            minRootSize: 12
          }
        },
        cssModules: {
          enable: false, // 默认为 false，如需使用 css modules 功能，则设为 true
          config: {
            namingPattern: 'module', // 转换模式，取值为 global/module
            generateScopedName: '[name]__[local]___[hash:base64:5]'
          }
        }
      }
    },
    h5: {
      publicPath,
      staticDirectory: 'static',

      sassLoaderOption: {
        additionalData: `@use "@/styles/overrides.scss";\n`
      },

      miniCssExtractPluginOption: {
        ignoreOrder: true,
        filename: 'css/[name].[hash].css',
        chunkFilename: 'css/[name].[chunkhash].css'
      },
      postcss: {
        pxtransform: {
          enable: true,
          config: {
            baseFontSize: 12,
            minRootSize: 12
          }
        },
        autoprefixer: {
          enable: true,
          config: {}
        },
        cssModules: {
          enable: false, // 默认为 false，如需使用 css modules 功能，则设为 true
          config: {
            namingPattern: 'module', // 转换模式，取值为 global/module
            generateScopedName: '[name]__[local]___[hash:base64:5]'
          }
        }
      },
      devServer: {
        open: false
      }
    }
  }

  if (process.env.LINT_MODE === 'true') {
    return merge({}, baseConfig, lintConfig)
  }

  if (process.env.NODE_ENV === 'development') {
    // 本地开发构建配置（不混淆压缩）
    return merge({}, baseConfig, devConfig)
  }

  // 生产构建配置（默认开启压缩混淆等）
  return merge({}, baseConfig, prodConfig)
})
