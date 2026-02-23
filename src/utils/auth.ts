import type {MeetingSession} from '../types/meeting'

/**
 * 鑾峰彇浠婃棩瀵嗙爜锛堟牸寮忥細MMDD锛? */
export function getTodayPassword(): string {
  const today = new Date()
  const month = String(today.getMonth() + 1).padStart(2, '0')
  const day = String(today.getDate()).padStart(2, '0')
  return `${month}${day}`
}

/**
 * 楠岃瘉杈撳叆鐨勫瘑鐮佹槸鍚︽纭? * @param input 鐢ㄦ埛杈撳叆鐨勫瘑鐮? * @returns true 琛ㄧず瀵嗙爜姝ｇ‘锛宖alse 琛ㄧず瀵嗙爜閿欒
 */
export function verifyPassword(input: string): boolean {
  return input === getTodayPassword()
}

/**
 * 妫€鏌ヤ細璁槸鍚﹀凡璁℃椂
 */
export function isSessionTimed(session: MeetingSession): boolean {
  if (session.isCompleted) {
    return true
  }
  return session.items.some((item) => item.actualDuration !== undefined && item.actualDuration > 0)
}
