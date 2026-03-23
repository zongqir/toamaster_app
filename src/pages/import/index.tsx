import {Text, Textarea, View} from '@tarojs/components'
import Taro from '@tarojs/taro'
import {useRef, useState} from 'react'
import {AgendaV2DatabaseService} from '../../db/agendaV2Database'
import {DatabaseService} from '../../db/database'
import {StorageService} from '../../services/storage'
import {useMeetingStore} from '../../store/meetingStore'
import type {MeetingItemType, MeetingSession} from '../../types/meeting'
import {generateId} from '../../utils/id'
import {safeRedirectTo} from '../../utils/safeNavigation'

export default function ImportPage() {
  const [inputText, setInputText] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [_isOCRLoading, setIsOCRLoading] = useState(false)
  const isNavigatingRef = useRef(false)
  const {setCurrentSession} = useMeetingStore()
  const remainingChars = 5000 - inputText.length

  const goToTimeline = async () => {
    if (isNavigatingRef.current) return
    isNavigatingRef.current = true

    const ok = await safeRedirectTo('/pages/timeline/index')
    if (!ok) {
      Taro.showToast({title: '页面跳转失败，请重试', icon: 'none'})
    }

    setTimeout(() => {
      isNavigatingRef.current = false
    }, 800)
  }

  const handleImageOCR = async () => {
    try {
      // 选择图片
      const res = await Taro.chooseImage({
        count: 1,
        sizeType: ['compressed'],
        sourceType: ['album', 'camera']
      })

      if (!res.tempFilePaths || res.tempFilePaths.length === 0) {
        return
      }

      setIsOCRLoading(true)
      Taro.showLoading({title: 'OCR 识别中...', mask: false})

      const imagePath = res.tempFilePaths[0]
      console.log('图片路径:', imagePath)

      // 获取图片信息
      const imageInfo = await Taro.getImageInfo({src: imagePath})
      console.log('图片信息:', imageInfo)

      // 将图片转为 base64
      const fileSystemManager = Taro.getFileSystemManager()
      const base64 = fileSystemManager.readFileSync(imagePath, 'base64') as string
      console.log('Base64 长度:', base64.length)

      // 根据文件扩展名或类型确定 MIME 类型
      let mimeType = 'image/jpeg'
      if (imagePath.toLowerCase().endsWith('.png')) {
        mimeType = 'image/png'
      } else if (imagePath.toLowerCase().endsWith('.jpg') || imagePath.toLowerCase().endsWith('.jpeg')) {
        mimeType = 'image/jpeg'
      }
      const imageBase64 = `data:${mimeType};base64,${base64}`

      // 调用硅基流动 Qwen2-VL OCR API
      const apiUrl = 'https://api.siliconflow.cn/v1/chat/completions'
      const apiKey = 'sk-oksisvxuztrfhyitxuycftbcgkyathnkmtextetbnbmfkzns'

      console.log('调用 OCR API')
      console.log('图片 base64 大小:', imageBase64.length, '字节')

      // 30秒后更新提示
      setTimeout(() => {
        Taro.showLoading({title: '识别中，请稍候...', mask: false})
      }, 30000)
      setTimeout(() => {
        Taro.showLoading({title: '处理较慢，继续等待...', mask: false})
      }, 60000)

      const startTime = Date.now()
      const response = await Taro.request({
        url: apiUrl,
        method: 'POST',
        timeout: 300000,
        header: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`
        },
        data: {
          model: 'Qwen/Qwen2-VL-72B-Instruct',
          messages: [
            {
              role: 'user',
              content: [
                {
                  type: 'image_url',
                  image_url: {
                    url: imageBase64
                  }
                },
                {
                  type: 'text',
                  text: '请识别图片中的所有文字内容，包括表格中的文字。直接输出识别到的文字，不要使用 HTML 标签，不要使用 Markdown 格式，只输出纯文本内容。'
                }
              ]
            }
          ],
          max_tokens: 8000,
          temperature: 0.0
        }
      })
      const endTime = Date.now()

      console.log('OCR 响应状态:', response.statusCode)
      console.log('OCR 耗时:', (endTime - startTime) / 1000, '秒')

      Taro.hideLoading()

      if (response.statusCode >= 200 && response.statusCode < 300) {
        const aiResponse = response.data
        if (aiResponse.choices && aiResponse.choices.length > 0) {
          const ocrText = aiResponse.choices[0].message.content
          setInputText(ocrText)
          Taro.showToast({title: 'OCR 识别成功', icon: 'success'})
        } else {
          throw new Error('OCR 返回数据格式错误')
        }
      } else {
        const errorText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
        console.error('OCR 失败详情:', errorText)
        throw new Error(`OCR 失败 (${response.statusCode}): ${errorText}`)
      }
    } catch (error) {
      console.error('OCR 错误:', error)
      Taro.hideLoading()
      const errorMessage = error instanceof Error ? error.message : '未知错误'
      Taro.showToast({
        title: `OCR 失败: ${errorMessage}`,
        icon: 'none',
        duration: 3000
      })
    } finally {
      setIsOCRLoading(false)
    }
  }

  const handleParse = async () => {
    console.log('=== handleParse called ===')
    console.log('input length:', inputText.length)

    if (!inputText.trim()) {
      Taro.showToast({title: '请输入表格文本', icon: 'none'})
      return
    }

    const supabaseUrl = process.env.TARO_APP_SUPABASE_URL
    if (!supabaseUrl) {
      Taro.showToast({title: '缺少后端地址配置', icon: 'none'})
      return
    }

    setIsLoading(true)
    Taro.showLoading({title: 'AI 解析中...', mask: false})

    try {
      // OCR flow remains unchanged; only parse flow is moved to backend function.
      const response = await Taro.request({
        url: `${supabaseUrl}/functions/v1/parse-meeting-table`,
        method: 'POST',
        timeout: 300000,
        header: {
          'Content-Type': 'application/json'
        },
        data: {
          tableText: inputText
        }
      })

      console.log('parse response status:', response.statusCode)
      console.log('parse response data:', response.data)

      if (response.statusCode < 200 || response.statusCode >= 300) {
        const errorText = typeof response.data === 'string' ? response.data : JSON.stringify(response.data)
        throw new Error(`解析失败 (${response.statusCode}): ${errorText}`)
      }

      const parsedData = response.data as {
        error?: string
        metadata?: Record<string, any>
        items?: Array<{
          title?: string
          speaker?: string
          durationSec?: number
          duration?: number
          startTime?: string
          type?: MeetingItemType
          parentTitle?: string
        }>
      }

      if (parsedData?.error) {
        throw new Error(parsedData.error)
      }

      const {metadata, items} = parsedData

      if (!items || items.length === 0) {
        Taro.showToast({title: '未能识别出会议环节', icon: 'none'})
        return
      }

      const processedItems = items.map((item) => {
        const duration = item.durationSec || item.duration || 60
        return {
          id: generateId('item'),
          title: item.title || '未命名',
          speaker: item.speaker || '主持人',
          plannedDuration: duration,
          startTime: item.startTime,
          type: item.type || inferType(item.title || ''),
          ruleId: duration > 180 ? 'long' : 'short',
          parentTitle: item.parentTitle || undefined
        }
      })

      const uniqueMeetingNo = await DatabaseService.generateUniqueMeetingNo(metadata?.meetingNo || null)

      const newSession: MeetingSession = {
        id: generateId('session'),
        metadata: {
          ...(metadata || {}),
          meetingNo: uniqueMeetingNo
        },
        items: processedItems,
        createdAt: Date.now(),
        isCompleted: false
      }

      Taro.showLoading({title: '保存中...', mask: true})
      const saveResult = await DatabaseService.saveMeeting(newSession)
      Taro.hideLoading()

      if (!saveResult.success) {
        Taro.showToast({title: `保存失败：${saveResult.error}`, icon: 'none'})
        return
      }

      const bootstrapResult = await AgendaV2DatabaseService.bootstrapAgendaFromSession(newSession)
      if (!bootstrapResult.success) {
        console.warn('导入会议后初始化 Agenda V2 失败:', bootstrapResult.error)
      }

      const versionedSession: MeetingSession = {
        ...newSession,
        agendaVersion: bootstrapResult.data?.agendaVersion || newSession.agendaVersion || 1
      }

      StorageService.saveSession(versionedSession, {syncToCloud: false})
      setCurrentSession(versionedSession)

      Taro.showToast({title: '会议已保存', icon: 'success', duration: 1500})
      setTimeout(() => {
        void goToTimeline()
      }, 1500)
    } catch (error) {
      console.error('parse error:', error)
      Taro.hideLoading()

      const errorMessage = error instanceof Error ? error.message : '未知错误'

      Taro.showToast({
        title: `解析失败: ${errorMessage}`,
        icon: 'none',
        duration: 3000
      })
    } finally {
      setIsLoading(false)
    }
  }

  const inferType = (title: string): MeetingItemType => {
    const t = title.toLowerCase()

    // 开场
    if (t.includes('开场') || t.includes('opening')) return 'opening'

    // 介绍
    if (t.includes('介绍') || t.includes('intro')) return 'intro'

    // 角色报告
    if (
      t.includes('时间官') ||
      t.includes('语法官') ||
      t.includes('哼哈官') ||
      t.includes('总点评') ||
      t.includes('timer') ||
      t.includes('grammarian') ||
      t.includes('官') ||
      t.includes('master') ||
      t.includes('报告')
    )
      return 'role'

    // 即兴演讲
    if (t.includes('即兴') || t.includes('table topic')) return 'tableTopics'

    // 备稿演讲
    if (
      t.includes('备稿') ||
      t.includes('prepared') ||
      t.includes('演讲') ||
      t.includes('破冰') ||
      t.includes('speech')
    )
      return 'preparedSpeech'

    // 点评
    if (t.includes('点评') || t.includes('evaluation')) return 'evaluation'

    // 休息
    if (t.includes('休息') || t.includes('拍照') || t.includes('break')) return 'break'

    // 问答
    if (t.includes('q&a') || t.includes('问答') || t.includes('qa')) return 'qa'

    // 投票
    if (t.includes('投票') || t.includes('voting') || t.includes('分享')) return 'voting'

    // 颁奖
    if (t.includes('颁奖') || t.includes('最佳') || t.includes('award')) return 'award'

    // 结束
    if (t.includes('结束') || t.includes('ending') || t.includes('closing')) return 'closing'

    return 'other'
  }

  return (
    <View className="app-page flex flex-col p-6 pt-10 pb-10">
      <View className="app-hero mb-6 fade-in-up">
        <View className="flex items-center gap-2 mb-2">
          <View className="ui-icon-btn" onClick={() => Taro.navigateBack()}>
            <View className="i-mdi-arrow-left text-base text-foreground" />
          </View>
          <Text className="text-2xl font-bold text-foreground block">📋 导入会议流程</Text>
        </View>
        <Text className="text-sm text-muted-foreground mt-2 block ml-10">粘贴表格文本或上传图片，使用 AI 智能解析</Text>
      </View>

      {/* 图片 OCR 按钮 */}
      <View className="mb-4 flex justify-center">
        <View className="ui-btn-secondary w-full max-w-[220px] min-h-[44px] px-4" onClick={handleImageOCR}>
          <View className="flex items-center justify-center">
            <View className="i-mdi-image-outline text-lg mr-2 text-primary" />
            <Text className="text-foreground font-semibold text-sm">上传图片识别</Text>
          </View>
        </View>
      </View>

      <View className="flex-1 ui-card border-2 border-dashed border-primary/30 p-4 relative min-h-[300px]">
        <Textarea
          className="w-full text-foreground text-sm bg-transparent"
          style={{height: '44vh', minHeight: '220px', maxHeight: '320px'}}
          placeholder="📝 在此粘贴表格内容...&#10;&#10;示例格式：&#10;19:00  开场致辞  2分钟  主持人&#10;19:02  即兴演讲  15分钟  即兴官"
          maxlength={5000}
          value={inputText}
          onInput={(e) => setInputText(e.detail.value)}
          focus
          cursorSpacing={20}
        />
        {inputText.length > 0 && (
          <View
            className="absolute top-2 right-2 p-2 bg-destructive/80 rounded-full z-10"
            onClick={() => setInputText('')}>
            <View className="i-mdi-close text-xs text-white" />
          </View>
        )}
        <View className="mt-2 flex items-center justify-between">
          <Text className="text-[11px] text-muted-foreground">支持最多 5000 字，建议保留原始表格顺序</Text>
          <Text className={`text-[11px] font-semibold ${remainingChars < 300 ? 'text-amber-300' : 'text-primary'}`}>
            {inputText.length}/5000
          </Text>
        </View>
      </View>

      <View className="mt-6 space-y-4">
        <View className="ui-card p-5 border-primary/20">
          <Text className="text-base text-primary block mb-4 font-bold">🤖 AI 智能解析</Text>
          <View className="space-y-3">
            <View className="flex items-start">
              <Text className="text-primary mr-2 text-sm font-bold">1.</Text>
              <Text className="text-sm text-muted-foreground flex-1">打开会议流程 PDF 或 Excel 文件</Text>
            </View>
            <View className="flex items-start">
              <Text className="text-primary mr-2 text-sm font-bold">2.</Text>
              <Text className="text-sm text-muted-foreground flex-1">选中表格内容并复制（Ctrl+C 或长按复制）</Text>
            </View>
            <View className="flex items-start">
              <Text className="text-primary mr-2 text-sm font-bold">3.</Text>
              <Text className="text-sm text-muted-foreground flex-1">粘贴到上方输入框，AI 将自动识别负责人和时长</Text>
            </View>
          </View>
          <View className="mt-4 pt-3 border-t border-border/30">
            <Text className="text-xs text-muted-foreground/70 block">✨ 支持复杂表格结构、嵌套环节、多种时间格式</Text>
          </View>
        </View>

        <View
          className={`ui-btn-primary text-white mb-4 flex items-center justify-center mx-auto w-full max-w-[220px] min-h-[48px] px-6 ${isLoading ? 'opacity-80' : ''}`}
          onClick={(e) => {
            e.stopPropagation()
            console.log('=== View 容器被点击 ===')
            if (isLoading || isNavigatingRef.current) {
              console.log('正在加载中，忽略点击')
              return
            }
            console.log('调用 handleParse')
            handleParse()
          }}>
          {isLoading ? (
            <View className="flex items-center justify-center">
              <View className="i-mdi-loading animate-spin text-lg mr-2 text-white" />
              <Text className="text-white font-bold text-sm">解析中...</Text>
            </View>
          ) : (
            <View className="flex items-center justify-center">
              <View className="i-mdi-auto-fix text-lg mr-2 text-white" />
              <Text className="text-white font-bold text-sm">AI 解析</Text>
            </View>
          )}
        </View>
      </View>
    </View>
  )
}
