import { Input, Label } from 'gradethread'

const field: React.CSSProperties = { display: 'flex', flexDirection: 'column', gap: 6, width: 280 }

export function WithLabel() {
  return (
    <div style={field}>
      <Label htmlFor="brand">Brand</Label>
      <Input id="brand" placeholder="e.g. Levi's, Patagonia" defaultValue="Patagonia" />
    </div>
  )
}

export function States() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={field}><Label>SKU</Label><Input placeholder="GT-00421" /></div>
      <div style={field}><Label>Disabled</Label><Input placeholder="Locked" disabled /></div>
      <div style={field}><Label>Invalid</Label><Input aria-invalid defaultValue="—" /></div>
    </div>
  )
}
