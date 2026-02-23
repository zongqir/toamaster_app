import {Input, ScrollView, Text, View} from '@tarojs/components'
import {useMeetingStore} from '../../store/meetingStore'

export default function SettingsPage() {
  const {settings, updateSettings} = useMeetingStore()

  const updateRule = (id: string, field: string, value: string) => {
    const num = parseInt(value, 10) || 0
    const newRules = {...settings.rules}
    newRules[id] = {...newRules[id], [field]: num}
    updateSettings({...settings, rules: newRules})
  }

  return (
    <ScrollView className="app-page overflow-x-hidden" scrollY>
      <View className="app-content overflow-x-hidden">
        <View className="app-hero fade-in-up">
          <Text className="app-title">系统设置</Text>
          <Text className="app-subtitle">自定义你的 AACTP 时间官规则</Text>
        </View>

        <View className="space-y-6">
          <View>
            <Text className="ui-section-label mb-4 block">计时规则</Text>
            {Object.values(settings.rules).map((rule) => (
              <View key={rule.id} className="ui-card mb-4 overflow-hidden min-w-0">
                <Text className="text-lg font-semibold text-foreground mb-3 block">{rule.name}</Text>
                <View className="grid grid-cols-1 gap-2 min-w-0">
                  <View>
                    <Text className="text-sm text-muted-foreground block mb-1">黄牌(剩余s)</Text>
                    <Input
                      className="ui-input text-base w-full max-w-full"
                      type="number"
                      value={rule.yellowThreshold.toString()}
                      onInput={(e) => updateRule(rule.id, 'yellowThreshold', e.detail.value)}
                      adjustPosition={false}
                    />
                  </View>
                  <View>
                    <Text className="text-sm text-muted-foreground block mb-1">红牌(剩余s)</Text>
                    <Input
                      className="ui-input text-base w-full max-w-full"
                      type="number"
                      value={rule.redThreshold.toString()}
                      onInput={(e) => updateRule(rule.id, 'redThreshold', e.detail.value)}
                      adjustPosition={false}
                    />
                  </View>
                  <View>
                    <Text className="text-sm text-muted-foreground block mb-1">超时(超过s)</Text>
                    <Input
                      className="ui-input text-base w-full max-w-full"
                      type="number"
                      value={Math.abs(rule.timeoutThreshold).toString()}
                      onInput={(e) => updateRule(rule.id, 'timeoutThreshold', `-${e.detail.value}`)}
                      adjustPosition={false}
                    />
                  </View>
                </View>
              </View>
            ))}
          </View>

          <View className="pt-8 pb-20">
            <Text className="text-[10px] text-center text-muted-foreground block uppercase tracking-[0.16em]">
              © 2026 启航 AACTP 时间官
            </Text>
          </View>
        </View>
      </View>
    </ScrollView>
  )
}
