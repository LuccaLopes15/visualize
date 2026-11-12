// Fase 5: errors from the Azure DevOps REST client. `kind` is stable (the UI and
// the ticket engine branch on it); `message` is pt-BR and safe to show — it never
// contains the PAT or the Authorization header.

export type DevOpsErrorKind =
  | 'invalid_url' // org URL in neither accepted format
  | 'auth' // 401: PAT invalid or expired
  | 'forbidden' // 403: PAT lacks a scope
  | 'not_found' // 404
  | 'rate_limited' // 429 after the retries
  | 'unavailable' // 503 after the retries
  | 'field' // 400 naming an invalid / required field (see `field`)
  | 'bad_request' // other 400
  | 'network' // fetch itself failed (offline, DNS, TLS)
  | 'unexpected' // any other status or an unreadable body

export class DevOpsError extends Error {
  constructor(
    public readonly kind: DevOpsErrorKind,
    message: string,
    /** HTTP status, when there was a response. */
    public readonly status: number | null = null,
    /** Field reference/name extracted from a 400 (`kind === 'field'`). */
    public readonly field: string | null = null
  ) {
    super(message)
    this.name = 'DevOpsError'
  }
}

/** Patterns Azure DevOps uses to name the offending field in a 400 message. */
const FIELD_PATTERNS = [
  /Rule Error for field (.+?)\. Error code/i, // TF401320: Rule Error for field Severity. Error code: Required, ...
  /Cannot find field (\w+(?:\.\w+)*)/i, // TF51535: Cannot find field System.Foo.
  /field '([^']+)'/i, // The field 'Custom.X' contains a value that is not in the list of supported values
  /field "([^"]+)"/i
]

/** Extracts the field name from an Azure DevOps 400 message, or null. Pure. */
export function extractFieldName(message: string): string | null {
  for (const re of FIELD_PATTERNS) {
    const m = re.exec(message)
    if (m) return m[1].trim()
  }
  return null
}

/** Builds the error for a non-2xx response. `serverMessage` comes from the body (`message`), if any. */
export function errorForStatus(status: number, serverMessage: string | null): DevOpsError {
  const detail = serverMessage ? ` Detalhe: ${serverMessage}` : ''
  switch (status) {
    case 401:
      return new DevOpsError(
        'auth',
        'O Azure DevOps recusou o PAT (inválido ou expirado). Gere um novo PAT e salve em Configurações.',
        status
      )
    case 403:
      return new DevOpsError(
        'forbidden',
        'O PAT não tem permissão para esta ação. Confira os escopos: Work Items (Read & Write) e Project and Team (Read).' +
          detail,
        status
      )
    case 404:
      return new DevOpsError(
        'not_found',
        'Não encontrado no Azure DevOps (organização, projeto, tipo ou work item).' + detail,
        status
      )
    case 429:
      return new DevOpsError(
        'rate_limited',
        'O Azure DevOps limitou as requisições (429). Espere um pouco e tente de novo.',
        status
      )
    case 503:
      return new DevOpsError('unavailable', 'O Azure DevOps está indisponível no momento (503). Tente de novo mais tarde.', status)
    case 400: {
      const field = serverMessage ? extractFieldName(serverMessage) : null
      if (field) {
        return new DevOpsError('field', `O campo "${field}" é obrigatório ou tem valor inválido.${detail}`, status, field)
      }
      return new DevOpsError('bad_request', 'O Azure DevOps rejeitou a requisição (400).' + detail, status)
    }
    default:
      return new DevOpsError('unexpected', `Resposta inesperada do Azure DevOps (${status}).` + detail, status)
  }
}
