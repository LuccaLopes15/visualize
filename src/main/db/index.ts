import type Database from 'better-sqlite3'
import { openDatabase } from './connection'
import { BoardsRepository } from './repositories/boards'
import { IdeasRepository } from './repositories/ideas'
import { MacroPlansRepository } from './repositories/macroPlans'
import { ProjectsRepository } from './repositories/projects'
import { SettingsRepository } from './repositories/settings'

export interface Repositories {
  db: Database.Database
  ideas: IdeasRepository
  projects: ProjectsRepository
  settings: SettingsRepository
  boards: BoardsRepository
  macroPlans: MacroPlansRepository
}

export function createRepositories(filename: string, now: () => number = Date.now): Repositories {
  const db = openDatabase(filename)
  return {
    db,
    ideas: new IdeasRepository(db, now),
    projects: new ProjectsRepository(db, now),
    settings: new SettingsRepository(db),
    boards: new BoardsRepository(db, now),
    macroPlans: new MacroPlansRepository(db, now)
  }
}

export { openDatabase }
