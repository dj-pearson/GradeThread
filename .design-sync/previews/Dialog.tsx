import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
  Button,
} from 'gradethread'

export function ConfirmPublish() {
  return (
    <Dialog open>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Publish to eBay?</DialogTitle>
          <DialogDescription>
            This lists “Levi&apos;s 501 · Vintage Denim” at $78.00 with the graded condition report attached. You can edit or end the listing anytime.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline">Cancel</Button>
          <Button>Publish listing</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
