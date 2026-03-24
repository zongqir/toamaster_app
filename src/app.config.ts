const pages = [
  'pages/history/index',
  'pages/import/index',
  'pages/timeline/index',
  'pages/timer/index',
  'pages/officer-notes/index',
  'pages/settings/index',
  'pages/vote-entrance/index',
  'pages/vote-edit/index',
  'pages/vote/index',
  'pages/vote-result/index',
  'pages/login/index'
]

//  To fully leverage TypeScript's type safety and ensure its correctness, always enclose the configuration object within the global defineAppConfig helper function.
export default defineAppConfig({
  pages,
  // 微信小程序: 开启组件按需注入，减少首包注入代码量
  lazyCodeLoading: 'requiredComponents',
  tabBar: {
    color: '#8da0b4',
    selectedColor: '#2dd4bf',
    backgroundColor: '#0b1320',
    borderStyle: 'black',
    list: [
      {
        pagePath: 'pages/history/index',
        text: '会议列表',
        iconPath: './assets/images/unselected/history.png',
        selectedIconPath: './assets/images/selected/history.png'
      },
      {
        pagePath: 'pages/vote-entrance/index',
        text: '投票入口',
        iconPath: './assets/images/unselected/vote.png',
        selectedIconPath: './assets/images/selected/vote.png'
      },
      {
        pagePath: 'pages/settings/index',
        text: '设置',
        iconPath: './assets/images/unselected/settings.png',
        selectedIconPath: './assets/images/selected/settings.png'
      }
    ]
  },
  window: {
    backgroundTextStyle: 'light',
    backgroundColor: '#0b1320',
    backgroundColorTop: '#0b1320',
    backgroundColorBottom: '#0b1320',
    navigationBarBackgroundColor: '#0b1320',
    navigationBarTitleText: '启航时间官',
    navigationBarTextStyle: 'white'
  }
  // Location APIs: Use 'getFuzzyLocation' for fuzzy location (cannot combine with precise APIs),
  // or use precise APIs: 'getLocation', 'onLocationChange', 'startLocationUpdate', 'chooseLocation', 'choosePoi', 'chooseAddress'
  // Background location: 'startLocationUpdateBackground'. Other values are strictly prohibited.
  // requiredPrivateInfos: []
})
