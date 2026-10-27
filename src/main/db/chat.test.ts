import { beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { createRepositories, type Repositories } from './index'
import { migrations, runMigrations } from './migrations'

let repos: Repositories
let clock: number

beforeEach(() => {
  clock = 1_000
  repos = createRepositories(':memory:', () => ++clock)
})

describe('migration v3 (chat)', () => {
  it('upgrades a v2 database', () => {
    const db = new Database(':memory:')
    db.pragma('foreign_keys = ON')
    runMigrations(
      db,
      migrations.filter((m) => m.version <= 2)
    )
    expect(runMigrations(db)).toEqual([3])
    expect(db.prepare('SELECT COUNT(*) c FROM chat_messages').get()).toEqual({ c: 0 })
  })
})

describe('ChatRepository', () => {
  it('stores messages with blocks and meta, oldest first, limited', () => {
    const idea = repos.ideas.create({ title: 'A' })
    repos.chat.addMessage(idea.id, 'user', [{ type: 'text', text: 'oi' }])
    const a = repos.chat.addMessage(
      idea.id,
      'assistant',
      [
        { type: 'text', text: 'olá' },
        { type: 'tool', id: 't', name: 'Read', label: 'Lendo arquivo', summary: 'a.ts', status: 'ok' }
      ],
      { durationMs: 10, interrupted: true }
    )
    expect(a.meta).toEqual({ durationMs: 10, interrupted: true })
    const list = repos.chat.listMessages(idea.id)
    expect(list.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(list[1].blocks[1]).toMatchObject({ type: 'tool', status: 'ok' })
    expect(repos.chat.listMessages(idea.id, 1).map((m) => m.role)).toEqual(['assistant'])
  })

  it('upserts the CLI session and context signature', () => {
    const idea = repos.ideas.create({ title: 'A' })
    expect(repos.chat.getSession(idea.id)).toBeNull()
    repos.chat.setSession(idea.id, 'sess-1')
    repos.chat.setContextSig(idea.id, 'sig')
    expect(repos.chat.getSession(idea.id)).toMatchObject({ cliSessionId: 'sess-1', contextSig: 'sig' })
    repos.chat.setSession(idea.id, 'sess-2')
    expect(repos.chat.getSession(idea.id)).toMatchObject({ cliSessionId: 'sess-2', contextSig: 'sig' })
  })

  it('reset clears history and session; other ideas untouched', () => {
    const a = repos.ideas.create({ title: 'A' })
    const b = repos.ideas.create({ title: 'B' })
    repos.chat.addMessage(a.id, 'user', [{ type: 'text', text: '1' }])
    repos.chat.addMessage(b.id, 'user', [{ type: 'text', text: '2' }])
    repos.chat.setSession(a.id, 's')
    repos.chat.reset(a.id)
    expect(repos.chat.listMessages(a.id)).toEqual([])
    expect(repos.chat.getSession(a.id)).toBeNull()
    expect(repos.chat.listMessages(b.id)).toHaveLength(1)
  })

  it('cascades when the idea is deleted and rejects unknown ideas', () => {
    const idea = repos.ideas.create({ title: 'A' })
    repos.chat.addMessage(idea.id, 'user', [{ type: 'text', text: 'x' }])
    repos.chat.setSession(idea.id, 's')
    repos.ideas.delete(idea.id)
    expect(repos.db.prepare('SELECT COUNT(*) c FROM chat_messages').get()).toEqual({ c: 0 })
    expect(repos.db.prepare('SELECT COUNT(*) c FROM chat_sessions').get()).toEqual({ c: 0 })
    expect(() => repos.chat.addMessage(999, 'user', [])).toThrow(/não encontrad/)
  })
})
