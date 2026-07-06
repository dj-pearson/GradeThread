import { Textarea, Label } from 'gradethread'

export function WithLabel() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, width: 340 }}>
      <Label htmlFor="notes">Condition notes</Label>
      <Textarea
        id="notes"
        rows={4}
        defaultValue={"Light fading at the hems. Small pindot near the left cuff. No holes, stains, or odor. All hardware intact."}
      />
    </div>
  )
}
