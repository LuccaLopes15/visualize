import type { Idea } from '@shared/types'
import { ConfirmDialog } from './Modal'

/** "Excluir ideia?" confirmation shared by the side panel and the list rows. */
export function DeleteIdeaDialog({
  idea,
  onCancel,
  onConfirm
}: {
  idea: Pick<Idea, 'title'>
  onCancel: () => void
  onConfirm: () => void
}): React.JSX.Element {
  return (
    <ConfirmDialog
      title="Excluir ideia?"
      message={
        <>
          <strong>{idea.title}</strong> será excluída permanentemente. Se quiser só tirar da frente, use{' '}
          <em>Arquivar</em>.
        </>
      }
      confirmLabel="Excluir"
      danger
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  )
}
