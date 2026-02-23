/**
 * PostCSS 插件：将 @egoist/tailwindcss-icons 生成的图标 CSS 中的
 * mask-image: var(--svg) 内联替换为实际的 SVG data URL。
 *
 * 原因：微信小程序对 mask-image + CSS var() 的组合支持不稳定，
 * 导致图标时有时无。内联后消除 CSS 变量依赖，确保图标稳定显示。
 */
import type {Plugin} from 'postcss'

const inlineIconSvg: Plugin = {
  postcssPlugin: 'postcss-inline-icon-svg',
  Once(root) {
    root.walkRules(/^\.i-/, (rule) => {
      let svgValue: string | null = null

      // 找到 --svg 声明并提取值
      rule.walkDecls('--svg', (decl) => {
        svgValue = decl.value
        decl.remove()
      })

      if (!svgValue) return

      // 将 mask-image: var(--svg) 替换为实际 SVG URL
      rule.walkDecls(/^(-webkit-)?mask-image$/, (decl) => {
        if (decl.value.includes('var(--svg)')) {
          decl.value = svgValue!
        }
      })
    })
  }
}

export default inlineIconSvg
