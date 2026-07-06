import { StatusBadge } from 'gradethread'

export function PipelineStatuses() {
  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <StatusBadge status="sourced" />
      <StatusBadge status="graded" />
      <StatusBadge status="drafted" />
      <StatusBadge status="listed" />
      <StatusBadge status="sold" />
      <StatusBadge status="archived" />
    </div>
  )
}
