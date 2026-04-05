import {Text, Textarea, View} from '@tarojs/components'
import Taro from '@tarojs/taro'
import {useEffect, useRef, useState} from 'react'
import {AgendaV2DatabaseService} from '../../db/agendaV2Database'
import {DatabaseService} from '../../db/database'
import {StorageService} from '../../services/storage'
import {useMeetingStore} from '../../store/meetingStore'
import type {MeetingItemBusinessType, MeetingItemType, MeetingSession} from '../../types/meeting'
import {IMPROMPTU_BLOCK_DURATION_SECONDS, IMPROMPTU_BLOCK_TITLE} from '../../utils/agendaBusiness'
import {generateId} from '../../utils/id'
import {safeRedirectTo} from '../../utils/safeNavigation'

const supabaseUrl = process.env.TARO_APP_SUPABASE_URL
const supabaseAnonKey = process.env.TARO_APP_SUPABASE_ANON_KEY
const edgeFunctionTransportVersion = 'public-anon-v1-20260328'
const parsePollIntervalMs = 2000
const maxParseStatusFailures = 3

type ParseFunctionResponse = {
  error?: string
  metadata?: {
    clubName?: string
    meetingNo?: string | number
    theme?: string
    date?: string
    wordOfTheDay?: string
    location?: string
    timeRange?: string
    startTime?: string
    endTime?: string
  }
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

type ParseJobResponse = {
  jobId: string
  status: 'queued' | 'processing' | 'succeeded' | 'failed'
  result?: ParseFunctionResponse
  errorMessage?: string
}

function isImpromptuHostRoleTitle(title: string | null | undefined) {
  const normalized = title?.trim().toLowerCase() || ''
  return normalized.includes('即兴主持') || normalized.includes('table topics master')
}

function isPlaceholderImpromptuHostName(name: string | null | undefined) {
  const normalized = name?.trim().toLowerCase() || ''
  return normalized === '即兴演讲官' || normalized === '即兴主持' || normalized === 'table topics master'
}

async function invokePublicEdgeFunction<T>(functionName: string, body: Record<string, unknown>): Promise<T> {
  if (!supabaseUrl || !supabaseAnonKey) {
    throw new Error('缺少 Supabase 配置')
  }

  console.log('[import-edge]', {
    version: edgeFunctionTransportVersion,
    functionName,
    usingAnonTransport: true,
    url: `${supabaseUrl}/functions/v1/${functionName}`
  })

  const response = await Taro.request({
    url: `${supabaseUrl}/functions/v1/${functionName}`,
    method: 'POST',
    timeout: 300000,
    header: {
      'Content-Type': 'application/json',
      apikey: supabaseAnonKey,
      Authorization: `Bearer ${supabaseAnonKey}`
    },
    data: body
  })

  const payload =
    typeof response.data === 'string'
      ? (() => {
          try {
            return JSON.parse(response.data)
          } catch {
            return response.data
          }
        })()
      : response.data

  if (response.statusCode < 200 || response.statusCode >= 300) {
    const errorText = typeof payload === 'string' ? payload : JSON.stringify(payload)
    throw new Error(errorText)
  }

  return payload as T
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export default function ImportPage() {
  const [inputText, setInputText] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [_isOCRLoading, setIsOCRLoading] = useState(false)
  const [parseStatusText, setParseStatusText] = useState('')
  const isNavigatingRef = useRef(false)
  const isPageActiveRef = useRef(true)
  const {setCurrentSession} = useMeetingStore()
  const remainingChars = 5000 - inputText.length

  useEffect(() => {
    return () => {
      isPageActiveRef.current = false
      Taro.hideLoading()
    }
  }, [])

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

      console.log('调用 OCR Edge Function')
      console.log('图片 base64 大小:', imageBase64.length, '字节')

      // 30秒后更新提示
      setTimeout(() => {
        Taro.showLoading({title: '识别中，请稍候...', mask: false})
      }, 30000)
      setTimeout(() => {
        Taro.showLoading({title: '处理较慢，继续等待...', mask: false})
      }, 60000)

      const startTime = Date.now()
      const endTime = Date.now()
      const ocrResult = await invokePublicEdgeFunction<{text?: string; error?: string}>('ocr-recognition', {
        imageBase64
      })

      console.log('OCR function result:', {
        hasData: Boolean(ocrResult),
        hasError: Boolean(ocrResult?.error)
      })
      console.log('OCR 耗时:', (endTime - startTime) / 1000, '秒')

      Taro.hideLoading()

      if (ocrResult?.error) {
        throw new Error(ocrResult.error)
      }

      if (!ocrResult?.text) {
        throw new Error('OCR 返回数据格式错误')
      }

      setInputText(ocrResult.text)
      Taro.showToast({title: 'OCR 识别成功', icon: 'success'})
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

  const setLoadingStatus = (message: string) => {
    setParseStatusText(message)
    Taro.showLoading({title: message, mask: true})
  }

  const waitForParseResult = async (jobId: string): Promise<ParseFunctionResponse> => {
    let failureCount = 0

    while (isPageActiveRef.current) {
      let job: ParseJobResponse

      try {
        job = await invokePublicEdgeFunction<ParseJobResponse>('get-parse-job', {jobId})
        failureCount = 0
      } catch (error) {
        failureCount += 1
        if (failureCount >= maxParseStatusFailures) {
          throw error instanceof Error ? error : new Error('状态查询失败，请重试')
        }

        setLoadingStatus('状态同步中')
        await sleep(parsePollIntervalMs)
        continue
      }

      if (job.status === 'queued') {
        setLoadingStatus('排队中...')
        await sleep(parsePollIntervalMs)
        continue
      }

      if (job.status === 'processing') {
        setLoadingStatus('解析中...')
        await sleep(parsePollIntervalMs)
        continue
      }

      if (job.status === 'failed') {
        throw new Error(job.errorMessage || '解析任务失败')
      }

      if (job.status === 'succeeded') {
        if (!job.result) {
          throw new Error('解析任务已完成，但结果为空')
        }
        return job.result
      }

      throw new Error('未知的解析任务状态')
    }

    throw new Error('页面已离开，停止等待解析结果')
  }

  const persistParsedMeeting = async (parsedData: ParseFunctionResponse) => {
    if (parsedData?.error) {
      throw new Error(parsedData.error)
    }

    const {metadata, items} = parsedData
    if (!items || items.length === 0) {
      throw new Error('未能识别出会议环节')
    }

    const processedItems = items.map((item) => {
      const duration = item.durationSec || item.duration || 60
      const normalizedTitle = (item.title || '').trim()
      const isImpromptuBlock = normalizedTitle === IMPROMPTU_BLOCK_TITLE
      const businessType: MeetingItemBusinessType = isImpromptuBlock ? 'impromptu_block' : 'normal'
      return {
        id: generateId('item'),
        title: normalizedTitle || '未命名',
        speaker: item.speaker || '主持人',
        plannedDuration: duration,
        startTime: item.startTime,
        type: isImpromptuBlock ? 'other' : item.type || inferType(normalizedTitle),
        ruleId: duration > 180 ? 'long' : 'short',
        parentTitle: item.parentTitle || undefined,
        businessType,
        budgetLimitSeconds: isImpromptuBlock ? IMPROMPTU_BLOCK_DURATION_SECONDS : undefined
      }
    })
    const normalizedItems = processedItems.reduce<typeof processedItems>((acc, item, index) => {
      const nextItem = processedItems[index + 1]
      const shouldMergeIntoFollowingImpromptu =
        isImpromptuHostRoleTitle(item.title) &&
        item.plannedDuration >= 10 * 60 &&
        nextItem?.businessType === 'impromptu_block'

      if (shouldMergeIntoFollowingImpromptu) {
        if (isPlaceholderImpromptuHostName(nextItem.speaker) && item.speaker) {
          nextItem.speaker = item.speaker
        }
        return acc
      }

      acc.push(item)
      return acc
    }, [])

    const uniqueMeetingNo = await DatabaseService.generateUniqueMeetingNo(metadata?.meetingNo || null)

    const newSession: MeetingSession = {
      id: generateId('session'),
      metadata: {
        ...(metadata || {}),
        meetingNo: uniqueMeetingNo
      },
      items: normalizedItems,
      impromptuRecords: [],
      createdAt: Date.now(),
      isCompleted: false
    }

    setLoadingStatus('保存中...')
    const saveResult = await DatabaseService.saveMeeting(newSession)
    if (!saveResult.success) {
      throw new Error(saveResult.error || '保存失败')
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

    Taro.hideLoading()
    setParseStatusText('')
    Taro.showToast({title: '会议已保存', icon: 'success', duration: 1500})
    setTimeout(() => {
      void goToTimeline()
    }, 1500)
  }

  const handleParse = async () => {
    console.log('=== handleParse called ===')
    console.log('input length:', inputText.length)

    if (!inputText.trim()) {
      Taro.showToast({title: '请输入表格文本', icon: 'none'})
      return
    }

    setIsLoading(true)
    setLoadingStatus('提交中...')

    try {
      const submitResult = await invokePublicEdgeFunction<ParseJobResponse>('submit-parse-job', {
        tableText: inputText
      })

      console.log('parse job submitted:', {
        jobId: submitResult.jobId,
        status: submitResult.status
      })

      const parsedData = await waitForParseResult(submitResult.jobId)
      await persistParsedMeeting(parsedData)
    } catch (error) {
      console.error('parse error:', error)
      Taro.hideLoading()
      setParseStatusText('')

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
        {isLoading && parseStatusText ? (
          <Text className="text-center text-xs text-muted-foreground block">{parseStatusText}</Text>
        ) : null}
      </View>
    </View>
  )
}
