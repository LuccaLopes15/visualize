// Fase 5: Azure DevOps settings as the renderer sees them. The PAT itself never
// crosses IPC back to the renderer: only whether one is saved.

/** Scopes the PAT needs, shown in Configurações. */
export const DEVOPS_PAT_SCOPES = [
  { name: 'Work Items (Read & Write)', why: 'criar e atualizar tickets; cobre também áreas, iterações e tipos' },
  { name: 'Project and Team (Read)', why: 'listar os projetos da organização' }
] as const

export interface DevOpsStatus {
  /** Canonical org URL (`https://dev.azure.com/<org>` or `https://<org>.visualstudio.com`); '' = not set. */
  orgUrl: string
  /** A PAT is saved (encrypted). Its value is never sent to the renderer. */
  patConfigured: boolean
  /** OS encryption (DPAPI on Windows) is available; without it the PAT cannot be saved. */
  encryptionAvailable: boolean
}

/** Result of "Testar conexão": the org's projects, or a pt-BR message safe to show. */
export type DevOpsTestResult = { ok: true; projects: string[] } | { ok: false; message: string }
