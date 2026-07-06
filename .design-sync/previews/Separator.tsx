import { Separator } from 'gradethread'

export function Horizontal() {
  return (
    <div style={{ width: 300, fontSize: 14 }}>
      <div style={{ fontWeight: 600 }}>Grade summary</div>
      <div style={{ color: 'var(--muted-foreground)' }}>Certificate #GT-4821</div>
      <Separator style={{ margin: '12px 0' }} />
      <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        <span>Fabric 9.5</span>
        <Separator orientation="vertical" style={{ height: 16 }} />
        <span>Cosmetic 10.0</span>
      </div>
    </div>
  )
}
