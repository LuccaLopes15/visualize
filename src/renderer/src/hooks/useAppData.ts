import { useCallback, useEffect, useState } from 'react'
import type { AppInfo, AppSettings, Idea, Project } from '@shared/types'

const api = window.api

export interface AppData {
  ideas: Idea[]
  projects: Project[]
  settings: AppSettings | null
  info: AppInfo | null
  loaded: boolean
}

/**
 * Loads hub data and keeps it fresh: main emits `dataChanged` after every
 * mutation (including ideas captured from the hotkey window), and we refetch
 * the affected entity.
 */
export function useAppData(): AppData {
  const [ideas, setIdeas] = useState<Idea[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [loaded, setLoaded] = useState(false)

  const loadIdeas = useCallback(() => api.ideas.list().then(setIdeas), [])
  const loadProjects = useCallback(() => api.projects.list().then(setProjects), [])
  const loadSettings = useCallback(
    () => Promise.all([api.settings.get().then(setSettings), api.app.info().then(setInfo)]),
    []
  )

  useEffect(() => {
    void Promise.all([loadIdeas(), loadProjects(), loadSettings()]).then(() => setLoaded(true))
    return api.onDataChanged(({ entity }) => {
      if (entity === 'ideas') void loadIdeas()
      else if (entity === 'projects') void loadProjects()
      else if (entity === 'settings') void loadSettings()
    })
  }, [loadIdeas, loadProjects, loadSettings])

  return { ideas, projects, settings, info, loaded }
}
