// Tests for the chat safety net that hides the idea's internal ids (LKA-20).
import { describe, expect, it } from 'vitest'
import type { ElementLike } from '../board/geometry'
import { boardIds, hideKnownIds, planIds, type KnownId } from './hideIds'

const LOGIN = '95ec0c83-1f2a-4b3c-8d4e-5f6a7b8c9d0e'
const TOKEN = 'a4bcd585-0000-4000-8000-000000000001'
const known: KnownId[] = [
  ...planIds([
    { id: LOGIN, title: 'Criar endpoint de login' },
    { id: TOKEN, title: 'Validar token' }
  ]),
  { id: 'r-k2m9x0qa', title: 'API' },
  { id: 'a-zz11yy22', title: '' }
]

const el = (e: Partial<ElementLike> & { id: string; type: string }): ElementLike => ({ x: 0, y: 0, width: 10, height: 10, ...e })

describe('hideKnownIds', () => {
  it('drops an id in parentheses right after the title', () => {
    expect(hideKnownIds('Atualizei Criar endpoint de login (95ec0c83).', known)).toBe('Atualizei Criar endpoint de login.')
    expect(hideKnownIds('Criei a caixa API [r-k2m9x0qa] no board.', known)).toBe('Criei a caixa API no board.')
  })

  it('drops a group made only of ids, with or without backticks', () => {
    expect(hideKnownIds('Duas tarefas (`95ec0c83`, a4bcd585) mudaram.', known)).toBe('Duas tarefas mudaram.')
    expect(hideKnownIds('Duas tarefas (95ec0c83 e a4bcd585) mudaram.', known)).toBe('Duas tarefas mudaram.')
  })

  it('replaces a bare or backticked id with the quoted title', () => {
    expect(hideKnownIds('Validar token depende de 95ec0c83.', known)).toBe('Validar token depende de "Criar endpoint de login".')
    expect(hideKnownIds('Mexi em `a4bcd585`.', known)).toBe('Mexi em "Validar token".')
    expect(hideKnownIds('Liguei a seta a-zz11yy22.', known)).toBe('Liguei a seta elemento sem texto.')
  })

  it('accepts longer prefixes and the full UUID', () => {
    expect(hideKnownIds('Tarefa 95ec0c83-1f2.', known)).toBe('Tarefa "Criar endpoint de login".')
    expect(hideKnownIds(`Tarefa ${LOGIN}.`, known)).toBe('Tarefa "Criar endpoint de login".')
  })

  it('never touches unknown tokens, short prefixes or ids inside paths', () => {
    const text = 'Commit 1a2b3c4d, versão 2.1.0, prefixo 95ec0c, arquivo src/95ec0c83.ts e (deadbeef).'
    expect(hideKnownIds(text, known)).toBe(text)
  })

  it('keeps a parenthesis that mixes ids and other text (only the id is replaced)', () => {
    expect(hideKnownIds('Pronto (veja 95ec0c83).', known)).toBe('Pronto (veja "Criar endpoint de login").')
  })

  it('leaves the text alone when nothing is known', () => {
    expect(hideKnownIds('Tarefa 95ec0c83.', [])).toBe('Tarefa 95ec0c83.')
  })
})

describe('boardIds', () => {
  it('titles elements by bound label, own text or frame name; skips deleted ones', () => {
    const ids = boardIds([
      el({ id: 'r-1', type: 'rectangle' }),
      el({ id: 't-1', type: 'text', text: 'API\n', originalText: 'API', containerId: 'r-1' }),
      el({ id: 't-2', type: 'text', text: 'Nota solta' }),
      el({ id: 'f-1', type: 'frame', name: 'Backend' }),
      el({ id: 'a-1', type: 'arrow' }),
      el({ id: 'r-2', type: 'rectangle', isDeleted: true })
    ])
    expect(ids).toEqual([
      { id: 'r-1', title: 'API' },
      { id: 't-1', title: 'API' },
      { id: 't-2', title: 'Nota solta' },
      { id: 'f-1', title: 'Backend' },
      { id: 'a-1', title: '' }
    ])
  })
})
