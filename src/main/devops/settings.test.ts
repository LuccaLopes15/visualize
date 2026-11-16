import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createRepositories, type Repositories } from '../db'
import { DevOpsSettings, ORG_URL_KEY, PAT_KEY, type SecretCipher } from './settings'

const PAT = 'segredo-pat-123'

/** Reversible stand-in for safeStorage: XOR, so the stored bytes never contain the PAT. */
function fakeCipher(available = true): SecretCipher {
  const xor = (b: Buffer): Buffer => Buffer.from(b.map((x) => x ^ 0x5a))
  return {
    isEncryptionAvailable: () => available,
    encryptString: (plain) => xor(Buffer.from(plain, 'utf8')),
    decryptString: (enc) => xor(enc).toString('utf8')
  }
}

let repos: Repositories

beforeEach(() => {
  repos = createRepositories(':memory:')
})

/** Every value in `settings`, as stored. */
function storedValues(): string[] {
  return (repos.db.prepare('SELECT value FROM settings').all() as { value: string }[]).map((r) => r.value)
}

describe('DevOpsSettings: URL da organização', () => {
  it('saves both accepted formats in canonical form', () => {
    const s = new DevOpsSettings(repos.settings, fakeCipher())
    expect(s.setOrgUrl('  https://Minha-Org.visualstudio.com/DefaultCollection/ ').orgUrl).toBe(
      'https://minha-org.visualstudio.com'
    )
    expect(s.setOrgUrl('https://dev.azure.com/minha-org/').orgUrl).toBe('https://dev.azure.com/minha-org')
    expect(repos.settings.getRaw(ORG_URL_KEY)).toBe('https://dev.azure.com/minha-org')
  })

  it('rejects an invalid URL with a clear message and keeps the previous one', () => {
    const s = new DevOpsSettings(repos.settings, fakeCipher())
    s.setOrgUrl('https://dev.azure.com/minha-org')
    expect(() => s.setOrgUrl('http://dev.azure.com/minha-org')).toThrow(/URL da organização inválida/)
    expect(() => s.setOrgUrl('minha-org')).toThrow(/URL da organização inválida/)
    expect(s.status().orgUrl).toBe('https://dev.azure.com/minha-org')
  })

  it('an empty URL removes it', () => {
    const s = new DevOpsSettings(repos.settings, fakeCipher())
    s.setOrgUrl('https://dev.azure.com/minha-org')
    expect(s.setOrgUrl('  ').orgUrl).toBe('')
    expect(repos.settings.getRaw(ORG_URL_KEY)).toBeUndefined()
  })
})

describe('DevOpsSettings: PAT', () => {
  it('stores the PAT only encrypted and never returns it', () => {
    const s = new DevOpsSettings(repos.settings, fakeCipher())
    const status = s.setPat(`  ${PAT}\n`)
    expect(status).toEqual({ orgUrl: '', patConfigured: true, encryptionAvailable: true })
    expect(JSON.stringify(status)).not.toContain(PAT)
    expect(JSON.stringify(s.status())).not.toContain(PAT)
    // Not in plain text, nor base64 of it, anywhere in the settings table or in getAll().
    const b64 = Buffer.from(PAT).toString('base64')
    for (const v of storedValues()) {
      expect(v).not.toContain(PAT)
      expect(v).not.toContain(b64)
    }
    expect(JSON.stringify(repos.settings.getAll())).not.toContain(PAT)
    expect(typeof repos.settings.getRaw(PAT_KEY)).toBe('string')
  })

  it('Trocar replaces the PAT and Remover clears devops_pat_enc', () => {
    const s = new DevOpsSettings(repos.settings, fakeCipher())
    s.setPat(PAT)
    const first = repos.settings.getRaw(PAT_KEY)
    s.setPat('outro-pat')
    expect(repos.settings.getRaw(PAT_KEY)).not.toBe(first)
    expect(s.clearPat().patConfigured).toBe(false)
    expect(repos.settings.getRaw(PAT_KEY)).toBeUndefined()
  })

  it('without OS encryption refuses to save (never plain text)', () => {
    const s = new DevOpsSettings(repos.settings, fakeCipher(false))
    expect(s.status().encryptionAvailable).toBe(false)
    expect(() => s.setPat(PAT)).toThrow(/criptografia/)
    expect(repos.settings.getRaw(PAT_KEY)).toBeUndefined()
    expect(storedValues().join()).not.toContain(PAT)
  })

  it('rejects an empty PAT or one with spaces', () => {
    const s = new DevOpsSettings(repos.settings, fakeCipher())
    expect(() => s.setPat('   ')).toThrow(/Cole o PAT/)
    expect(() => s.setPat('abc def')).toThrow(/espaços/)
    expect(s.status().patConfigured).toBe(false)
  })
})

describe('DevOpsSettings: testar conexão', () => {
  function withFetch(...replies: { status?: number; body?: unknown }[]) {
    const calls: { url: string; auth: string | undefined }[] = []
    const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), auth: (init?.headers as Record<string, string>)?.Authorization })
      const r = replies.shift()
      if (!r) throw new Error('chamada inesperada')
      return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200 })
    })
    const s = new DevOpsSettings(repos.settings, fakeCipher(), { fetch: fetch as unknown as typeof globalThis.fetch })
    return { s, calls }
  }

  it('lists the projects of the org, sorted, with the decrypted PAT', async () => {
    const { s, calls } = withFetch({ body: { value: [{ id: '2', name: 'Visualize' }, { id: '1', name: 'Api' }] } })
    s.setOrgUrl('https://minha-org.visualstudio.com')
    s.setPat(PAT)
    expect(await s.testConnection()).toEqual({ ok: true, projects: ['Api', 'Visualize'] })
    expect(calls[0].url).toMatch(/^https:\/\/minha-org\.visualstudio\.com\/_apis\/projects\?/)
    expect(calls[0].auth).toBe('Basic ' + Buffer.from(`:${PAT}`).toString('base64'))
  })

  it('reports a readable error without throwing (401, org not found, missing config)', async () => {
    const { s } = withFetch({ status: 401 }, { status: 404 })
    expect(await s.testConnection()).toEqual({ ok: false, message: expect.stringMatching(/Configure a URL/) })
    s.setOrgUrl('https://dev.azure.com/minha-org')
    s.setPat(PAT)
    const auth = await s.testConnection()
    expect(auth).toEqual({ ok: false, message: expect.stringMatching(/recusou o PAT/) })
    expect(await s.testConnection()).toEqual({ ok: false, message: expect.stringMatching(/Organização não encontrada/) })
    expect(JSON.stringify(auth)).not.toContain(PAT)
  })

  it('a PAT that cannot be decrypted asks to save it again', async () => {
    const { s } = withFetch()
    s.setOrgUrl('https://dev.azure.com/minha-org')
    s.setPat(PAT)
    const broken = new DevOpsSettings(repos.settings, {
      ...fakeCipher(),
      decryptString: () => {
        throw new Error('decrypt failed')
      }
    })
    expect(await broken.testConnection()).toEqual({ ok: false, message: expect.stringMatching(/Salve o PAT de novo/) })
  })
})
