/** Error with a user-facing (pt-BR) message. Thrown by repositories / IPC handlers. */
export class AppError extends Error {
  constructor(
    public readonly code: 'not_found' | 'validation' | 'conflict',
    message: string
  ) {
    super(message)
    this.name = 'AppError'
  }
}

export const notFound = (what: string, id: number): AppError =>
  new AppError('not_found', `${what} #${id} não encontrado(a).`)

export const invalid = (message: string): AppError => new AppError('validation', message)
