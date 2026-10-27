import { IDEA_STATUS_LABELS, type IdeaStatus } from '@shared/types'

export function StatusBadge({ status }: { status: IdeaStatus }): React.JSX.Element {
  return (
    <span className={`badge badge-${status}`}>
      <span className="badge-dot" />
      {IDEA_STATUS_LABELS[status]}
    </span>
  )
}
