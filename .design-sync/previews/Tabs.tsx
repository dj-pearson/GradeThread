import { Tabs, TabsList, TabsTrigger, TabsContent } from 'gradethread'

export function GradeDetail() {
  return (
    <div style={{ width: 380 }}>
      <Tabs defaultValue="report">
        <TabsList>
          <TabsTrigger value="report">Report</TabsTrigger>
          <TabsTrigger value="photos">Photos</TabsTrigger>
          <TabsTrigger value="comps">Comps</TabsTrigger>
        </TabsList>
        <TabsContent value="report" style={{ paddingTop: 12, fontSize: 14 }}>
          Overall grade 9.5 — Excellent. Fabric 9.5, Structural 9.0, Cosmetic 10.0.
        </TabsContent>
        <TabsContent value="photos" style={{ paddingTop: 12, fontSize: 14 }}>
          4 photos uploaded: front, back, label, detail.
        </TabsContent>
      </Tabs>
    </div>
  )
}
