import { describe, expect, it } from 'vitest'
import { PlanError } from '@shared/plan'
import {
  addSpecArg,
  indexArg,
  newNodeArg,
  nodeIdArg,
  orderedIdsArg,
  parentIdArg,
  patchArg,
  replaceSpecArg
} from './planPayload'

const code = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    return e instanceof PlanError ? e.code : `other:${String(e)}`
  }
  return 'none'
}

describe('plan IPC payload shape checks', () => {
  it('replaceAll needs an explicit stories list', () => {
    expect(code(() => replaceSpecArg({}))).toBe('spec_invalid')
    expect(code(() => replaceSpecArg(undefined))).toBe('spec_invalid')
    expect(code(() => replaceSpecArg({ stories: 'x' }))).toBe('spec_invalid')
    expect(code(() => replaceSpecArg({ stories: [], deps: 'x' }))).toBe('spec_invalid')
    expect(replaceSpecArg({ stories: [] })).toEqual({ stories: [] })
  })

  it('mergeAdd needs a nodes list', () => {
    expect(code(() => addSpecArg({ stories: [] }))).toBe('spec_invalid')
    expect(addSpecArg({ nodes: [] })).toEqual({ nodes: [] })
  })

  it('ids, index, lists and objects', () => {
    expect(code(() => nodeIdArg(''))).toBe('invalid_input')
    expect(code(() => nodeIdArg(5))).toBe('invalid_input')
    expect(nodeIdArg('abc')).toBe('abc')
    expect(parentIdArg(undefined)).toBeNull()
    expect(parentIdArg(null)).toBeNull()
    expect(code(() => parentIdArg(3))).toBe('invalid_input')
    expect(indexArg(null)).toBeUndefined()
    expect(indexArg(2)).toBe(2)
    expect(code(() => indexArg(-1))).toBe('invalid_input')
    expect(code(() => indexArg(1.5))).toBe('invalid_input')
    expect(code(() => orderedIdsArg('a'))).toBe('invalid_input')
    expect(code(() => orderedIdsArg(['a', 1]))).toBe('invalid_input')
    expect(orderedIdsArg(['a', 'b'])).toEqual(['a', 'b'])
    expect(code(() => newNodeArg(null))).toBe('invalid_input')
    expect(code(() => patchArg([]))).toBe('invalid_input')
  })
})
