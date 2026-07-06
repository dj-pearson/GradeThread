import { Switch, Label } from 'gradethread'

const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 10 }

export function Toggles() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div style={row}><Switch id="s1" defaultChecked /><Label htmlFor="s1">Auto-publish to eBay</Label></div>
      <div style={row}><Switch id="s2" /><Label htmlFor="s2">Include measurements on certificate</Label></div>
      <div style={row}><Switch id="s3" disabled /><Label htmlFor="s3">Human review (Pro plan)</Label></div>
    </div>
  )
}
