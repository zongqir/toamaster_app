import {
  injectedGuiListenerPlugin,
  injectOnErrorPlugin,
  makeTagger,
  miaodaDevPlugin,
  monitorPlugin
} from 'miaoda-sc-plugin'

const base = String(process.argv[process.argv.length - 1])
const publicPath = /^http/.test(base) ? base : '/'

const sentryDsn = process.env.INJECT_SENTRY_DSN
const environment = process.env.MIAODA_ENV
const appId = process.env.TARO_APP_APP_ID
const cdnHost = process.env.MIAODA_CDN_HOST || 'resource-static.cdn.bcebos.com'

export default {
  mini: {
    debugReact: true
  },
  h5: {},
  compiler: {
    type: 'vite',
    vitePlugins: [
      makeTagger({
        root: process.cwd()
      }),
      injectedGuiListenerPlugin({
        path: 'https://resource-static.cdn.bcebos.com/common/v2/injected.js'
      }),
      injectOnErrorPlugin(),
      monitorPlugin({
        scriptSrc: `https://${cdnHost}/sentry/browser.sentry.min.js`,
        sentryDsn: sentryDsn || '',
        environment: environment || '',
        appId: appId || ''
      }),

      {
        name: 'hmr-toggle',
        configureServer(server) {
          let hmrEnabled = true

          // 包装原来的 send 方法
          const _send = server.ws.send
          server.ws.send = (payload) => {
            if (hmrEnabled) {
              return _send.call(server.ws, payload)
            } else {
              console.log('[HMR disabled] skipped payload:', payload.type)
            }
          }

          // 提供接口切换 HMR
          server.middlewares.use('/innerapi/v1/sourcecode/__hmr_off', (_req, res) => {
            hmrEnabled = false
            const body = {
              status: 0,
              msg: 'HMR disabled'
            }
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(body))
          })

          server.middlewares.use('/innerapi/v1/sourcecode/__hmr_on', (_req, res) => {
            hmrEnabled = true
            const body = {
              status: 0,
              msg: 'HMR enabled'
            }
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(body))
          })

          // 注册一个 HTTP API，用来手动触发一次整体刷新
          server.middlewares.use('/innerapi/v1/sourcecode/__hmr_reload', (_req, res) => {
            if (hmrEnabled) {
              server.ws.send({
                type: 'full-reload',
                path: '*' // 整页刷新
              })
            }
            res.statusCode = 200
            const body = {
              status: 0,
              msg: 'Manual full reload triggered'
            }
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify(body))
          })
        },
        load(id) {
          if (id === 'virtual:after-update') {
            return `
        if (import.meta.hot) {
          import.meta.hot.on('vite:afterUpdate', () => {
            window.postMessage(
              {
                type: 'editor-update'
              },
              '*'
            );
          });
        }
      `
          }
        },
        transformIndexHtml(html) {
          return {
            html,
            tags: [
              {
                tag: 'script',
                attrs: {
                  type: 'module',
                  src: '/@id/virtual:after-update'
                },
                injectTo: 'body'
              }
            ]
          }
        }
      },

      miaodaDevPlugin({appType: 'miniapp', cdnBase: publicPath})
    ]
  }
}
