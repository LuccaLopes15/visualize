import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Autosaver, flushAll, registerFlusher, type SaveStatus } from './autosave'
import { continueList, indentLines, type Edit } from './mdEditing'
import {
  buildBoardSave,
  pickPersistedAppState,
  referencedFileIds,
  sceneSignature
} from '../workspace/boardScene'

describe('Autosaver', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('debounces and saves only the latest value', async () => {
    const saved: string[] = []
    const statuses: SaveStatus[] = []
    const a = new Autosaver<string>(async (v) => void saved.push(v), 800, (s) => statuses.push(s))
    a.schedule('a')
    a.schedule('ab')
    await vi.advanceTimersByTimeAsync(799)
    expect(saved).toEqual([])
    a.schedule('abc')
    await vi.advanceTimersByTimeAsync(800)
    expect(saved).toEqual(['abc'])
    expect(a.status).toBe('saved')
    expect(statuses).toEqual(['pending', 'pending', 'pending', 'saving', 'saved'])
  })

  it('flush saves immediately and is a no-op when clean', async () => {
    const save = vi.fn(async () => {})
    const a = new Autosaver<number>(save)
    await a.flush()
    expect(save).not.toHaveBeenCalled()
    a.schedule(1)
    await a.flush()
    expect(save).toHaveBeenCalledWith(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(save).toHaveBeenCalledTimes(1)
  })

  it('never overlaps saves; a change during a save is written after it', async () => {
    let release!: () => void
    const order: string[] = []
    const a = new Autosaver<string>(async (v) => {
      order.push(`start ${v}`)
      if (v === 'one') await new Promise<void>((r) => (release = r))
      order.push(`end ${v}`)
    })
    a.schedule('one')
    const f1 = a.flush()
    a.schedule('two')
    const f2 = a.flush()
    expect(a.dirty).toBe(true)
    release()
    await Promise.all([f1, f2])
    expect(order).toEqual(['start one', 'end one', 'start two', 'end two'])
    expect(a.dirty).toBe(false)
  })

  it('keeps the value after a failure so the next flush retries', async () => {
    let fail = true
    const saved: string[] = []
    const a = new Autosaver<string>(async (v) => {
      if (fail) throw new Error('disco cheio')
      saved.push(v)
    })
    a.schedule('x')
    await a.flush()
    expect(a.status).toBe('error')
    expect(a.dirty).toBe(true)
    fail = false
    await a.flush()
    expect(saved).toEqual(['x'])
    expect(a.status).toBe('saved')
  })

  it('flushAll flushes every registered autosaver', async () => {
    const saved: number[] = []
    const a = new Autosaver<number>(async (v) => void saved.push(v))
    const b = new Autosaver<number>(async (v) => void saved.push(v * 10))
    const ua = registerFlusher(() => a.flush())
    const ub = registerFlusher(() => b.flush())
    a.schedule(1)
    b.schedule(2)
    await flushAll()
    expect(saved.sort()).toEqual([1, 20])
    ua()
    ub()
    a.schedule(3)
    await flushAll()
    expect(saved).toHaveLength(2)
  })
})

function apply(value: string, e: Edit): string {
  return value.slice(0, e.from) + e.text + value.slice(e.to)
}

describe('markdown editing helpers', () => {
  it('continues bullet, numbered and task lists', () => {
    let v = '- item'
    let e = continueList(v, v.length, v.length)!
    expect(apply(v, e)).toBe('- item\n- ')
    v = '  3. passo'
    e = continueList(v, v.length, v.length)!
    expect(apply(v, e)).toBe('  3. passo\n  4. ')
    v = '- [x] feito'
    e = continueList(v, v.length, v.length)!
    expect(apply(v, e)).toBe('- [x] feito\n- [ ] ')
    expect(e.selStart).toBe(apply(v, e).length)
  })

  it('ends the list on an empty item and ignores plain lines', () => {
    const v = 'texto\n- '
    const e = continueList(v, v.length, v.length)!
    expect(apply(v, e)).toBe('texto\n')
    expect(continueList('parágrafo', 9, 9)).toBeNull()
  })

  it('indents and outdents the selected lines', () => {
    const v = 'a\nb\nc'
    const e = indentLines(v, 0, 3, false)
    expect(apply(v, e)).toBe('  a\n  b\nc')
    const back = apply(v, e)
    const o = indentLines(back, 0, back.indexOf('\nc'), true)
    expect(apply(back, o)).toBe('a\nb\nc')
  })
})

describe('board scene helpers', () => {
  const els = [
    { id: 'a', type: 'rectangle', version: 3 },
    { id: 'b', type: 'image', version: 2, fileId: 'f1' },
    { id: 'c', type: 'image', version: 5, fileId: 'f2', isDeleted: true },
    { id: 'd', type: 'image', version: 1, fileId: 'f3' }
  ]
  const file = (id: string) => ({ id, mimeType: 'image/png', dataURL: 'data:image/png;base64,AA', created: 1 })

  it('keeps only durable appState keys', () => {
    expect(
      pickPersistedAppState({
        scrollX: 1,
        zoom: { value: 2 },
        selectedElementIds: { a: true },
        collaborators: new Map(),
        openMenu: 'canvas',
        currentItemStrokeColor: '#f00'
      })
    ).toEqual({ scrollX: 1, zoom: { value: 2 }, currentItemStrokeColor: '#f00' })
  })

  it('lists files referenced by live image elements', () => {
    expect(referencedFileIds(els).sort()).toEqual(['f1', 'f3'])
  })

  it('signature changes with element versions and viewport, not with selection', () => {
    const s1 = sceneSignature(els, { scrollX: 0, selectedElementIds: {} }, {})
    expect(sceneSignature(els, { scrollX: 0, selectedElementIds: { a: true } }, {})).toBe(s1)
    expect(sceneSignature([{ ...els[0], version: 4 }, ...els.slice(1)], { scrollX: 0 }, {})).not.toBe(s1)
    expect(sceneSignature(els, { scrollX: 10 }, {})).not.toBe(s1)
    expect(sceneSignature(els, { scrollX: 0 }, { f1: {} })).not.toBe(s1)
  })

  it('sends only new, available files and drops deleted elements', () => {
    const { input, persistedAfter } = buildBoardSave(
      els,
      { scrollX: 5, openMenu: 'x' },
      { f1: file('f1'), f2: file('f2') }, // f3 still loading
      new Set(['f1'])
    )
    expect(input.elements.map((e) => (e as { id: string }).id)).toEqual(['a', 'b', 'd'])
    expect(input.appState).toEqual({ scrollX: 5 })
    expect(input.newFiles).toEqual([]) // f1 already stored, f2 deleted, f3 not loaded
    expect(input.referencedFileIds).toEqual(['f1'])
    expect([...persistedAfter]).toEqual(['f1'])

    const next = buildBoardSave(els, {}, { f1: file('f1'), f3: file('f3') }, persistedAfter)
    expect(next.input.newFiles.map((f) => f.id)).toEqual(['f3'])
    expect(next.input.referencedFileIds.sort()).toEqual(['f1', 'f3'])
  })
})
