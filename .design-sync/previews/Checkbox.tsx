import { Checkbox, Label } from 'gradethread'

const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 8 }

export function Options() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={row}><Checkbox id="a" defaultChecked /><Label htmlFor="a">Share outcome to community comps</Label></div>
      <div style={row}><Checkbox id="b" /><Label htmlFor="b">List automatically after grading</Label></div>
      <div style={row}><Checkbox id="c" disabled /><Label htmlFor="c">Requires eBay connection</Label></div>
    </div>
  )
}
