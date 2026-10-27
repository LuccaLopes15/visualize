import Database from 'better-sqlite3'
import { runMigrations } from './migrations'

/**
 * Opens (or creates) the SQLite database and applies pending migrations.
 * Pass ':memory:' for tests.
 */
export function openDatabase(filename: string): Database.Database {
  const db = new Database(filename)
  if (filename !== ':memory:') db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 3000')
  runMigrations(db)
  return db
}
