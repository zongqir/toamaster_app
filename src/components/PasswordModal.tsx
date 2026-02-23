import {Button, Input, Text, View} from '@tarojs/components'
import {useState} from 'react'

interface PasswordModalProps {
  visible: boolean
  onConfirm: (password: string) => void
  onCancel: () => void
}

export default function PasswordModal({visible, onConfirm, onCancel}: PasswordModalProps) {
  const [password, setPassword] = useState('')

  if (!visible) return null

  const handleConfirm = () => {
    onConfirm(password)
    setPassword('')
  }

  const handleCancel = () => {
    onCancel()
    setPassword('')
  }

  return (
    <View className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60" onClick={handleCancel}>
      <View
        className="ui-card-strong ui-modal-panel p-6 mx-4 w-full max-w-[calc(100vw-2rem)] max-h-[80vh] overflow-y-auto box-border"
        onClick={(e) => e.stopPropagation()}>
        <Text className="text-lg font-bold text-foreground block mb-2">需要授权</Text>
        <Text className="text-sm text-muted-foreground block mb-4">请输入授权密码</Text>

        <Input
          className="ui-input w-full mb-6 px-4 py-3"
          placeholder="请输入密码"
          password
          value={password}
          onInput={(e) => setPassword(e.detail.value)}
        />

        <View className="flex flex-wrap gap-3">
          <Button className="ui-btn-secondary flex-1" onClick={handleCancel}>
            取消
          </Button>
          <Button className="ui-btn-primary flex-1" onClick={handleConfirm}>
            确定
          </Button>
        </View>
      </View>
    </View>
  )
}
