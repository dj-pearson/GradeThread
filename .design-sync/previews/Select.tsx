import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem, SelectGroup, SelectLabel } from 'gradethread'

export function ConditionPicker() {
  return (
    <div style={{ width: 260 }}>
      <Select defaultValue="excellent">
        <SelectTrigger>
          <SelectValue placeholder="Select condition" />
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <SelectLabel>Condition</SelectLabel>
            <SelectItem value="nwt">New with tags</SelectItem>
            <SelectItem value="excellent">Excellent</SelectItem>
            <SelectItem value="good">Good</SelectItem>
            <SelectItem value="fair">Fair</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  )
}
