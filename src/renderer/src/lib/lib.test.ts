import { describe, expect, it } from 'vitest'
import { filterIdeas, matchesQuery, normalize } from './search'
import { eventToAccelerator, formatAccelerator, type KeyLike } from './accelerator'
import { basename } from './format'

describe('search', () => {
  it('normalizes accents and case', () => {
    expect(normalize('Ação Rápida')).toBe('acao rapida')
  })

  it('matches all terms across title and body', () => {
    const idea = { title: 'Cache de relatórios', body: 'usar Redis no módulo financeiro' }
    expect(matchesQuery(idea, 'relatorio redis')).toBe(true)
    expect(matchesQuery(idea, 'FINANCEIRO')).toBe(true)
    expect(matchesQuery(idea, 'relatorio kafka')).toBe(false)
    expect(matchesQuery(idea, '   ')).toBe(true)
  })

  it('filterIdeas returns everything for an empty query', () => {
    const list = [
      { title: 'a', body: '' },
      { title: 'b', body: '' }
    ]
    expect(filterIdeas(list, '')).toBe(list)
    expect(filterIdeas(list, 'b')).toEqual([{ title: 'b', body: '' }])
  })
})

const ev = (p: Partial<KeyLike>): KeyLike => ({
  key: '',
  code: '',
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...p
})

describe('accelerator', () => {
  it('builds Control+Alt+Space', () => {
    expect(eventToAccelerator(ev({ key: ' ', code: 'Space', ctrlKey: true, altKey: true }))).toBe(
      'Control+Alt+Space'
    )
  })

  it('uses the physical key (layout independent)', () => {
    expect(eventToAccelerator(ev({ key: 'Ç', code: 'KeyI', ctrlKey: true, shiftKey: true }))).toBe(
      'Control+Shift+I'
    )
  })

  it('ignores lone modifiers and unmodified keys', () => {
    expect(eventToAccelerator(ev({ key: 'Control', code: 'ControlLeft', ctrlKey: true }))).toBeNull()
    expect(eventToAccelerator(ev({ key: 'a', code: 'KeyA' }))).toBeNull()
    expect(eventToAccelerator(ev({ key: 'A', code: 'KeyA', shiftKey: true }))).toBeNull()
  })

  it('allows bare function keys', () => {
    expect(eventToAccelerator(ev({ key: 'F9', code: 'F9' }))).toBe('F9')
  })

  it('formats for display', () => {
    expect(formatAccelerator('Control+Alt+Space')).toBe('Ctrl + Alt + Espaço')
    expect(formatAccelerator('Super+Shift+N')).toBe('Win + Shift + N')
  })
})

describe('format', () => {
  it('basename handles Windows paths', () => {
    expect(basename('C:\\Projetos\\Exemplo\\Visualize\\')).toBe('Visualize')
    expect(basename('/home/x/proj')).toBe('proj')
  })
})
