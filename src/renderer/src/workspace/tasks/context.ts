import { createContext, useContext } from 'react'
import type { LayoutDir } from './layout'

/** What the graph nodes (custom React Flow nodes) can ask the tab to do. */
export interface TasksActions {
  dir: LayoutDir
  /** Node being renamed inline (double-click / Enter). */
  editingId: string | null
  startEdit: (id: string) => void
  stopEdit: () => void
  rename: (id: string, title: string) => void
  addChild: (id: string) => void
  remove: (id: string) => void
  toggleCollapse: (id: string) => void
}

const noop = (): void => {}
export const TasksActionsContext = createContext<TasksActions>({
  dir: 'TB',
  editingId: null,
  startEdit: noop,
  stopEdit: noop,
  rename: noop,
  addChild: noop,
  remove: noop,
  toggleCollapse: noop
})

export const useTasksActions = (): TasksActions => useContext(TasksActionsContext)
