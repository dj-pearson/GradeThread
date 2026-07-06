import { Progress } from 'gradethread'

const wrap: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 16, width: 300 }
const cap: React.CSSProperties = { fontSize: 12, color: 'var(--muted-foreground)', marginBottom: 6 }

export function Levels() {
  return (
    <div style={wrap}>
      <div><div style={cap}>Monthly grades used — 30%</div><Progress value={30} /></div>
      <div><div style={cap}>70%</div><Progress value={70} /></div>
      <div><div style={cap}>Plan limit reached — 100%</div><Progress value={100} /></div>
    </div>
  )
}
