import {ScrollView, Text, View} from '@tarojs/components'
import Taro, {useDidShow, useRouter} from '@tarojs/taro'
import {useCallback, useEffect, useState} from 'react'
import PasswordModal from '../../components/PasswordModal'
import {DatabaseService} from '../../db/database'
import {VotingDatabaseService} from '../../db/votingDatabase'
import type {VotingResult} from '../../types/voting'
import {verifyPassword} from '../../utils/auth'
import {safeSwitchTab} from '../../utils/safeNavigation'

export default function VoteResultPage() {
  const router = useRouter()
  const {id: sessionId} = router.params

  const [result, setResult] = useState<VotingResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [showPasswordModal, setShowPasswordModal] = useState(false)
  const [passwordAction, setPasswordAction] = useState<'close' | 'delete' | null>(null)
  const [meetingNo, setMeetingNo] = useState<string | number | null>(null) // 会议号
  const [autoRefresh, setAutoRefresh] = useState(true) // 自动刷新开关

  // 加载投票结果
  const loadResult = useCallback(async () => {
    if (!sessionId) {
      Taro.showToast({title: '投票ID无效', icon: 'none'})
      return
    }

    setLoading(true)
    const data = await VotingDatabaseService.getVotingResult(sessionId)
    setLoading(false)

    if (!data) {
      Taro.showToast({title: '获取结果失败', icon: 'none'})
      return
    }

    console.log('投票结果数据:', JSON.stringify(data, null, 2))
    console.log('总投票人数:', data.totalVoters)
    console.log('分组数量:', data.groups.length)
    data.groups.forEach((group, index) => {
      console.log(`分组${index + 1}: ${group.group.groupName}, 总票数: ${group.totalVotes}`)
      console.log(`候选人数量: ${group.candidates.length}`)
      group.candidates.forEach((candidate, cIndex) => {
        console.log(`  候选人${cIndex + 1}: ${candidate.candidate.name}, 得票: ${candidate.voteCount}`)
      })
    })

    setResult(data)

    // 加载会议号
    if (data.session.meetingId) {
      const no = await DatabaseService.getMeetingNo(data.session.meetingId)
      setMeetingNo(no)
    }

    setAutoRefresh(data.session.status === 'active')
  }, [sessionId])

  // 自动刷新投票结果（每5秒）
  useEffect(() => {
    if (!autoRefresh || !sessionId) return

    const timer = setInterval(() => {
      console.log('自动刷新投票结果...')
      loadResult()
    }, 5000) // 5秒刷新一次

    return () => clearInterval(timer)
  }, [autoRefresh, sessionId, loadResult])

  useDidShow(() => {
    loadResult()
  })

  // 导出结果
  const handleExport = () => {
    if (!result) return

    let text = '━━━━━━━━━━━━━━━━━━━━\n'
    text += '📊 投票结果\n'
    text += '━━━━━━━━━━━━━━━━━━━━\n\n'

    text += `📋 ${result.session.title}\n`
    if (result.session.description) {
      text += `${result.session.description}\n`
    }
    text += `👥 总投票人数：${result.totalVoters} 人\n\n`

    result.groups.forEach((groupResult) => {
      text += `━━━━━━━━━━━━━━━━━━━━\n`
      text += `🏆 ${groupResult.group.groupName}\n`
      text += `━━━━━━━━━━━━━━━━━━━━\n\n`

      groupResult.candidates.forEach((candidateResult, index) => {
        const rank = index + 1
        const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}.`
        text += `${medal} ${candidateResult.candidate.name}\n`
        text += `   得票：${candidateResult.voteCount} 票\n`
        if (candidateResult.candidate.description) {
          text += `   环节：${candidateResult.candidate.description}\n`
        }
        text += '\n'
      })
    })

    text += '━━━━━━━━━━━━━━━━━━━━\n'
    text += '© 启航AACTP 时间官'

    Taro.setClipboardData({
      data: text,
      success: () => {
        Taro.showToast({
          title: '结果已复制',
          icon: 'success'
        })
      }
    })
  }

  // 关闭投票
  const handleCloseVoting = () => {
    setPasswordAction('close')
    setShowPasswordModal(true)
  }

  // 删除投票
  const handleDelete = () => {
    setPasswordAction('delete')
    setShowPasswordModal(true)
  }

  // 密码验证成功后执行管理操作
  const handlePasswordConfirm = async (password: string) => {
    setShowPasswordModal(false)

    if (!verifyPassword(password)) {
      Taro.showToast({title: '密码错误', icon: 'error'})
      return
    }

    if (!sessionId || !passwordAction) return

    if (passwordAction === 'close') {
      const decision = await Taro.showModal({
        title: '关闭投票',
        content: '关闭后将不再允许任何人投票或修改投票，但仍可查看结果。是否继续？',
        confirmText: '确认关闭',
        cancelText: '取消'
      })

      if (!decision.confirm) {
        setPasswordAction(null)
        return
      }

      Taro.showLoading({title: '关闭中...'})
      const closeResult = await VotingDatabaseService.closeVotingSession(sessionId)
      Taro.hideLoading()

      if (closeResult.success) {
        await loadResult()
        Taro.showToast({
          title: '投票已关闭',
          icon: 'success',
          duration: 2000
        })
      } else {
        Taro.showToast({
          title: closeResult.error || '关闭失败',
          icon: 'error'
        })
      }
    } else if (passwordAction === 'delete') {
      Taro.showLoading({title: '删除中...'})
      const deleteResult = await VotingDatabaseService.deleteVotingSession(sessionId)
      Taro.hideLoading()

      if (deleteResult.success) {
        Taro.showToast({
          title: '删除成功',
          icon: 'success',
          duration: 2000
        })
        setTimeout(() => {
          Taro.navigateBack()
        }, 2000)
      } else {
        Taro.showToast({
          title: deleteResult.error || '删除失败',
          icon: 'error'
        })
      }
    }

    setPasswordAction(null)
  }

  const handlePasswordCancel = () => {
    setShowPasswordModal(false)
    setPasswordAction(null)
  }

  if (loading) {
    return (
      <View className="h-screen bg-gradient-page flex items-center justify-center">
        <Text className="text-muted-foreground">加载中...</Text>
      </View>
    )
  }

  if (!result) {
    return (
      <View className="h-screen bg-gradient-page flex items-center justify-center p-4">
        <View className="text-center">
          <View className="i-mdi-alert-circle text-6xl text-muted-foreground mb-4" />
          <Text className="text-foreground text-lg">获取结果失败</Text>
        </View>
      </View>
    )
  }

  return (
    <View className="h-screen bg-gradient-page flex flex-col">
      {/* 头部 */}
      <View className="p-4 pt-8 bg-transparent border-b border-border flex-shrink-0">
        <View className="flex justify-between items-start flex-wrap gap-2 mb-2">
          <View className="flex-1">
            <View className="ui-row-wrap mb-1">
              <View
                className="ui-icon-btn mr-2"
                hoverClass="opacity-70"
                onClick={(e) => {
                  e.stopPropagation()
                  void safeSwitchTab('/pages/history/index')
                }}>
                <View className="i-mdi-arrow-left text-base text-foreground" />
              </View>
              <Text className="text-xl font-bold text-foreground flex-1 min-w-0 truncate">{result.session.title}</Text>
              {meetingNo && (
                <View className="ui-pill shrink-0">
                  <Text className="text-xs font-medium text-foreground">#{meetingNo}</Text>
                </View>
              )}
            </View>
            {result.session.description && (
              <Text className="text-xs text-muted-foreground mt-1">{result.session.description}</Text>
            )}

            {/* 投票状态提示 */}
            {result.session.status === 'closed' && (
              <View className="mt-2 bg-muted/50 p-2 rounded-lg border border-border">
                <Text className="text-xs text-muted-foreground">
                  {result.session.expiresAt && Date.now() > result.session.expiresAt
                    ? `投票已过期（${new Date(result.session.expiresAt).toLocaleString('zh-CN')}）`
                    : '投票已关闭'}
                </Text>
              </View>
            )}

            {/* 自动刷新提示 */}
            {autoRefresh && result.session.status === 'active' && (
              <View className="mt-2 flex items-center">
                <View className="i-mdi-refresh animate-spin text-sm text-primary mr-2" />
                <Text className="text-xs text-muted-foreground">每5秒自动刷新结果</Text>
              </View>
            )}
          </View>
          <View className="flex flex-wrap gap-2">
            {/* 手动刷新按钮 */}
            <View
              className="ui-btn-secondary w-10 h-10 p-0 rounded-lg"
              onClick={() => {
                console.log('手动刷新投票结果')
                loadResult()
              }}>
              <View className="i-mdi-refresh text-sm text-foreground" />
            </View>
            <View className="ui-btn-secondary w-10 h-10 p-0 rounded-lg" onClick={handleExport}>
              <View className="i-mdi-export text-sm text-foreground" />
            </View>
            {result.session.status === 'active' && (
              <View className="ui-btn-secondary w-10 h-10 p-0 rounded-lg" onClick={handleCloseVoting}>
                <View className="i-mdi-lock text-sm text-foreground" />
              </View>
            )}
            <View className="ui-btn-secondary w-10 h-10 p-0 rounded-lg" onClick={handleDelete}>
              <View className="i-mdi-delete text-sm text-foreground" />
            </View>
          </View>
        </View>

        {/* 统计信息 */}
        <View className="ui-stat-grid mt-3">
          <View className="ui-stat-card">
            <Text className="text-xs text-muted-foreground">总投票人数</Text>
            <Text className="ui-stat-value">{result.totalVoters}</Text>
          </View>
          <View className="ui-stat-card">
            <Text className="text-xs text-muted-foreground">投票分组</Text>
            <Text className="ui-stat-value">{result.groups.length}</Text>
          </View>
        </View>
      </View>

      {/* 结果列表 */}
      <ScrollView scrollY className="flex-1 min-h-0 p-4 pb-6" enableBackToTop>
        {result.groups.map((groupResult) => (
          <View key={groupResult.group.id} className="mb-4 ui-card">
            <View className="flex justify-between items-center flex-wrap gap-2 mb-3">
              <Text className="text-base font-bold text-foreground">{groupResult.group.groupName}</Text>
              <Text className="text-xs text-muted-foreground">{groupResult.totalVotes} 票</Text>
            </View>

            <View className="space-y-2">
              {groupResult.candidates.map((candidateResult, index) => {
                const rank = index + 1
                const isTop3 = rank <= 3
                const percentage =
                  groupResult.totalVotes > 0
                    ? Math.round((candidateResult.voteCount / groupResult.totalVotes) * 100)
                    : 0

                return (
                  <View
                    key={candidateResult.candidate.id}
                    className={`p-3 rounded-lg border ${
                      rank === 1
                        ? 'bg-amber-500/10 border-amber-500/50'
                        : rank === 2
                          ? 'bg-gray-400/10 border-gray-400/50'
                          : rank === 3
                            ? 'bg-orange-600/10 border-orange-600/50'
                            : 'bg-secondary/15 border-border'
                    }`}>
                    <View className="flex justify-between items-start gap-2 mb-2">
                      <View className="flex items-center gap-2 flex-1 min-w-0">
                        <Text
                          className={`text-2xl ${
                            rank === 1
                              ? 'text-amber-500'
                              : rank === 2
                                ? 'text-gray-400'
                                : rank === 3
                                  ? 'text-orange-600'
                                  : 'text-muted-foreground'
                          }`}>
                          {rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}`}
                        </Text>
                        <View className="min-w-0 flex-1">
                          <Text className={`text-base font-medium ${isTop3 ? 'text-foreground' : 'text-foreground'}`}>
                            {candidateResult.candidate.name}
                          </Text>
                          {candidateResult.candidate.description && (
                            <Text className="text-xs text-muted-foreground mt-0.5">
                              {candidateResult.candidate.description}
                            </Text>
                          )}
                        </View>
                      </View>
                      <View className="text-right shrink-0">
                        <Text className="text-lg font-bold text-foreground">{candidateResult.voteCount}</Text>
                        <Text className="text-xs text-cyan-300">{percentage}%</Text>
                      </View>
                    </View>

                    {/* 进度条 */}
                    <View className="w-full h-1.5 bg-secondary/30 rounded-full overflow-hidden">
                      <View
                        className={`h-full rounded-full ${
                          rank === 1
                            ? 'bg-amber-500'
                            : rank === 2
                              ? 'bg-gray-400'
                              : rank === 3
                                ? 'bg-orange-600'
                                : 'bg-primary'
                        }`}
                        style={{width: `${percentage}%`}}
                      />
                    </View>
                  </View>
                )
              })}
            </View>
          </View>
        ))}
      </ScrollView>

      {/* 密码验证弹窗 */}
      <PasswordModal visible={showPasswordModal} onConfirm={handlePasswordConfirm} onCancel={handlePasswordCancel} />
    </View>
  )
}
