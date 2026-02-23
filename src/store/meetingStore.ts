import {create} from 'zustand'
import {StorageService} from '../services/storage'
import type {AppSettings, MeetingSession} from '../types/meeting'

interface MeetingState {
  currentSession: MeetingSession | null
  settings: AppSettings
  setCurrentSession: (session: MeetingSession | null) => void
  updateSettings: (settings: AppSettings) => void
  loadSettings: () => void
}

export const useMeetingStore = create<MeetingState>((set) => ({
  currentSession: null,
  settings: StorageService.getSettings(),
  setCurrentSession: (session) => set({currentSession: session}),
  updateSettings: (settings) => {
    StorageService.saveSettings(settings)
    set({settings})
  },
  loadSettings: () => set({settings: StorageService.getSettings()})
}))
