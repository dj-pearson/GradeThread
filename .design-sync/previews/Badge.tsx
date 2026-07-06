import { Badge } from 'gradethread'

const row: React.CSSProperties = { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }

export function Variants() {
  return (
    <div style={row}>
      <Badge>Default</Badge>
      <Badge variant="secondary">Secondary</Badge>
      <Badge variant="outline">Outline</Badge>
      <Badge variant="destructive">Destructive</Badge>
      <Badge variant="ghost">Ghost</Badge>
    </div>
  )
}

export function ConditionTiers() {
  return (
    <div style={row}>
      <Badge>NWT · 10.0</Badge>
      <Badge variant="secondary">Excellent · 9.5</Badge>
      <Badge variant="outline">Good · 7.0</Badge>
      <Badge variant="destructive">Needs review</Badge>
    </div>
  )
}
