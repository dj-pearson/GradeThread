import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableCaption,
  Badge,
} from 'gradethread'

export function InventoryTable() {
  return (
    <div style={{ width: 460 }}>
      <Table>
        <TableCaption>Recent inventory</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Item</TableHead>
            <TableHead>Grade</TableHead>
            <TableHead>Status</TableHead>
            <TableHead style={{ textAlign: 'right' }}>Price</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Levi&apos;s 501</TableCell>
            <TableCell><Badge>9.5</Badge></TableCell>
            <TableCell>Listed</TableCell>
            <TableCell style={{ textAlign: 'right' }}>$78.00</TableCell>
          </TableRow>
          <TableRow>
            <TableCell>Patagonia Fleece</TableCell>
            <TableCell><Badge variant="secondary">8.0</Badge></TableCell>
            <TableCell>Drafted</TableCell>
            <TableCell style={{ textAlign: 'right' }}>$45.00</TableCell>
          </TableRow>
          <TableRow>
            <TableCell>Nike Windbreaker</TableCell>
            <TableCell><Badge variant="destructive">Review</Badge></TableCell>
            <TableCell>Sourced</TableCell>
            <TableCell style={{ textAlign: 'right' }}>—</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  )
}
