// Fase 5: Azure DevOps configuration (org URL + PAT) kept in `settings`. The PAT is
// stored only encrypted (`devops_pat_enc`, base64 of the OS-encrypted bytes) and is
// decrypted only to build a `DevOpsClient` here in the main process: nothing this
// class returns contains it. Encryption is injected (Electron's `safeStorage` in the
// app, a fake in tests), so this file does not import electron.
import type { DevOpsStatus, DevOpsTestResult } from '@shared/devops'
import type { SettingsRepository } from '../db/repositories/settings'
import { DevOpsClient, normalizeOrgUrl, type DevOpsClientOptions } from './client'
import { DevOpsError } from './errors'

export const ORG_URL_KEY = 'devops_org_url'
export const PAT_KEY = 'devops_pat_enc'

/** The subset of Electron's `safeStorage` used here. */
export interface SecretCipher {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
}

const NO_ENCRYPTION =
  'A criptografia do sistema não está disponível neste PC, então o PAT não pode ser salvo com segurança.'

export class DevOpsSettings {
  constructor(
    private readonly settings: SettingsRepository,
    private readonly cipher: SecretCipher,
    /** Extra client options (tests inject `fetch`). */
    private readonly clientOptions: Partial<DevOpsClientOptions> = {}
  ) {}

  status(): DevOpsStatus {
    const org = this.settings.getRaw(ORG_URL_KEY)
    return {
      orgUrl: typeof org === 'string' ? org : '',
      patConfigured: typeof this.settings.getRaw(PAT_KEY) === 'string',
      encryptionAvailable: this.cipher.isEncryptionAvailable()
    }
  }

  /** Saves the org URL in canonical form ('' removes it). Throws a pt-BR error for an invalid URL. */
  setOrgUrl(raw: string): DevOpsStatus {
    if (!raw.trim()) this.settings.delete(ORG_URL_KEY)
    else this.settings.setRaw(ORG_URL_KEY, normalizeOrgUrl(raw))
    return this.status()
  }

  /** Encrypts and saves the PAT, replacing any previous one. Never stores it in plain text. */
  setPat(pat: string): DevOpsStatus {
    const value = pat.trim()
    if (!value) throw new Error('Cole o PAT antes de salvar.')
    if (/\s/.test(value)) throw new Error('O PAT não pode ter espaços. Confira se colou só o token.')
    if (!this.cipher.isEncryptionAvailable()) throw new Error(NO_ENCRYPTION)
    this.settings.setRaw(PAT_KEY, this.cipher.encryptString(value).toString('base64'))
    return this.status()
  }

  clearPat(): DevOpsStatus {
    this.settings.delete(PAT_KEY)
    return this.status()
  }

  /** A client for the saved org and PAT. Throws a pt-BR error if something is missing. */
  client(): DevOpsClient {
    const { orgUrl } = this.status()
    const enc = this.settings.getRaw(PAT_KEY)
    if (!orgUrl || typeof enc !== 'string') {
      throw new Error('Configure a URL da organização e o PAT do Azure DevOps em Configurações.')
    }
    if (!this.cipher.isEncryptionAvailable()) throw new Error(NO_ENCRYPTION)
    let pat: string
    try {
      pat = this.cipher.decryptString(Buffer.from(enc, 'base64'))
    } catch {
      throw new Error('Não foi possível ler o PAT salvo (talvez de outro usuário do Windows). Salve o PAT de novo.')
    }
    return new DevOpsClient({ ...this.clientOptions, orgUrl, pat })
  }

  /** "Testar conexão": lists the org's projects. Errors come back as a message, never thrown. */
  async testConnection(): Promise<DevOpsTestResult> {
    try {
      const projects = await this.client().listProjects()
      return { ok: true, projects: projects.map((p) => p.name).sort((a, b) => a.localeCompare(b, 'pt-BR')) }
    } catch (err) {
      if (err instanceof DevOpsError && err.kind === 'not_found') {
        return { ok: false, message: 'Organização não encontrada no Azure DevOps. Confira a URL.' }
      }
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  }
}
