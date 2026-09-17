import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import Database from 'better-sqlite3'

export type AppDatabase = {
  sql: Database.Database
  close(): void
}

export function openDatabase(dataDir: string): AppDatabase {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const filename = join(dataDir, 'database.sqlite')
  const sql = new Database(filename)
  try {
    chmodSync(filename, 0o600)
    sql.pragma('journal_mode = WAL')
    sql.pragma('synchronous = FULL')
    sql.pragma('foreign_keys = ON')
    sql.pragma('busy_timeout = 5000')
    sql.exec('CREATE TABLE IF NOT EXISTS __migrations (name TEXT PRIMARY KEY)')
    return { sql, close: () => sql.close() }
  } catch (error) {
    sql.close()
    throw error
  }
}
