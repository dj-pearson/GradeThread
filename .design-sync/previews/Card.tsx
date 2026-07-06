import {
  Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, CardAction,
  Badge, Button,
} from 'gradethread'

export function GradeReport() {
  return (
    <Card style={{ width: 340 }}>
      <CardHeader>
        <CardTitle>Levi&apos;s 501 · Vintage Denim</CardTitle>
        <CardDescription>Certificate #GT-4821 · graded 2 days ago</CardDescription>
        <CardAction>
          <Badge>9.5</Badge>
        </CardAction>
      </CardHeader>
      <CardContent style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
          <span style={{ color: 'var(--muted-foreground)' }}>Fabric</span>
          <span>9.5</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
          <span style={{ color: 'var(--muted-foreground)' }}>Structural</span>
          <span>9.0</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 14 }}>
          <span style={{ color: 'var(--muted-foreground)' }}>Cosmetic</span>
          <span>10.0</span>
        </div>
      </CardContent>
      <CardFooter style={{ gap: 8 }}>
        <Button size="sm">View certificate</Button>
        <Button size="sm" variant="outline">Share</Button>
      </CardFooter>
    </Card>
  )
}

export function EmptyContent() {
  return (
    <Card style={{ width: 340 }}>
      <CardHeader>
        <CardTitle>New submission</CardTitle>
        <CardDescription>Upload front, back, label, and one detail photo to begin grading.</CardDescription>
      </CardHeader>
      <CardFooter>
        <Button>Start grading</Button>
      </CardFooter>
    </Card>
  )
}
