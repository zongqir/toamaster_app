import type {UserConfigExport} from '@tarojs/cli'
import {patchTaroAppConfig} from 'miaoda-sc-plugin'

const base = String(process.argv[process.argv.length - 1])
const publicPath = /^http/.test(base) ? base : '/'

export default {
  mini: {},
  h5: {},
  compiler: {
    type: 'vite',
    vitePlugins: [patchTaroAppConfig(publicPath)]
  }
} satisfies UserConfigExport<'vite'>
