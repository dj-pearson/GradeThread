import { Button } from 'gradethread'

const row: React.CSSProperties = { display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center' }

export function Variants() {
  return (
    <div style={row}>
      <Button>Grade item</Button>
      <Button variant="secondary">Save draft</Button>
      <Button variant="outline">Add photos</Button>
      <Button variant="ghost">Skip</Button>
      <Button variant="destructive">Delete listing</Button>
      <Button variant="link">View certificate</Button>
    </div>
  )
}

export function Sizes() {
  return (
    <div style={row}>
      <Button size="xs">xs</Button>
      <Button size="sm">Small</Button>
      <Button size="default">Publish to eBay</Button>
      <Button size="lg">Get a grade</Button>
    </div>
  )
}

export function States() {
  return (
    <div style={row}>
      <Button>Enabled</Button>
      <Button disabled>Grading…</Button>
      <Button variant="outline" disabled>Unavailable</Button>
    </div>
  )
}
