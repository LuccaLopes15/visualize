import { describe, expect, it } from 'vitest'
import { libraryArg, MAX_LIBRARY_BYTES, storedLibrary } from './libraryPayload'

const item = (id: string): Record<string, unknown> => ({ id, status: 'unpublished', created: 1, elements: [{ id: `${id}-r`, type: 'rectangle' }] })

describe('board library payload (LKA-21)', () => {
  it('accepts a list of items, including an empty one (user removed everything)', () => {
    expect(libraryArg([item('a'), item('b')])).toEqual([item('a'), item('b')])
    expect(libraryArg([])).toEqual([])
  })

  it('rejects anything that is not a list of { id, elements }', () => {
    expect(() => libraryArg(undefined)).toThrow('Biblioteca de formas inválida.')
    expect(() => libraryArg({ items: [] })).toThrow('Biblioteca de formas inválida.')
    expect(() => libraryArg([item('a'), { id: 'b' }])).toThrow('Biblioteca de formas inválida.')
    expect(() => libraryArg([{ elements: [] }])).toThrow('Biblioteca de formas inválida.')
  })

  it('rejects a library bigger than the limit', () => {
    const big = [{ id: 'x', elements: [{ text: 'a'.repeat(MAX_LIBRARY_BYTES) }] }]
    expect(() => libraryArg(big)).toThrow('grande demais')
  })

  it('reads a missing or corrupted setting as an empty library, keeping valid items', () => {
    expect(storedLibrary(undefined)).toEqual([])
    expect(storedLibrary('texto')).toEqual([])
    expect(storedLibrary([item('a'), 42, { id: 'b' }])).toEqual([item('a')])
  })
})
