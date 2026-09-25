import { useEffect, useRef, useState } from "react";
import { Download, FileText, Link2, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { toastError } from "@/lib/toast-error";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useFetchGoogleSheet } from "@/hooks/use-sheet-import";
import { decodeTextFile } from "@/lib/decode-text-file";
import { cn } from "@/lib/utils";

// IMP-13: step 1, where the seller's data comes in. File first, because it is
// what most sellers have and what the copy has always recommended.
//
// The old control was a display:none input behind a label with no tabIndex, so
// a keyboard could not reach it; the copy said "drop it in" and nothing took a
// drop, so a dropped file navigated the tab away and lost the page; and picking
// the same file twice did nothing because the input's value never changed.

export type ImportSource = "csv" | "sheet" | "paste";

export interface LoadedSource {
  from: ImportSource;
  /** File name, or a short description of where the text came from. */
  name: string;
  rows: number;
}

interface Props {
  disabled: boolean;
  loaded: LoadedSource | null;
  /** Hands the raw text over; returns the data-row count, or null if unreadable. */
  onLoad: (raw: string, from: ImportSource, name: string) => number | null;
  onDownloadTemplate: () => void;
}

export function ImportSourcePicker({ disabled, loaded, onLoad, onDownloadTemplate }: Props) {
  const [tab, setTab] = useState<ImportSource>("csv");
  const [sheetUrl, setSheetUrl] = useState("");
  const [pasted, setPasted] = useState("");
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const fetchSheet = useFetchGoogleSheet();

  // A file dropped anywhere else on the page must not replace the page with
  // the file. Only the drop zone below takes it.
  useEffect(() => {
    const stop = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    window.addEventListener("dragover", stop);
    window.addEventListener("drop", stop);
    return () => {
      window.removeEventListener("dragover", stop);
      window.removeEventListener("drop", stop);
    };
  }, []);

  async function readFile(file: File | null | undefined) {
    if (!file || disabled) return;
    try {
      const raw = decodeTextFile(await file.arrayBuffer());
      onLoad(raw, "csv", file.name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to read file: ${msg}`);
    }
  }

  async function handleFetchSheet() {
    if (!sheetUrl.trim()) return;
    // US-3262: the Fetch button is disabled while a read is in flight; the
    // Enter key on the input was not, so a second press started a second read
    // of the same sheet. Both land in onLoad, so the slower reply overwrites
    // the faster one's headers and mapping. Guarded here rather than on the
    // keydown, so the next caller inherits it.
    if (fetchSheet.isPending) return;
    try {
      const { csv } = await fetchSheet.mutateAsync({ url: sheetUrl.trim() });
      onLoad(csv, "sheet", "Google Sheet");
    } catch (err) {
      toastError(err, "Could not read that file.", { duration: 12_000 });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>1. Load your data</CardTitle>
        <CardDescription>
          Upload a CSV file, pull a Google Sheet, or paste rows copied from a
          spreadsheet. Nothing is saved until step 4.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p role="status" aria-live="polite" className={cn("text-sm", !loaded && "sr-only")}>
          {loaded ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              <FileText className="h-4 w-4" aria-hidden />
              <span className="font-medium">{loaded.name}</span>
              <span className="text-muted-foreground">
                {loaded.rows} row{loaded.rows === 1 ? "" : "s"}
              </span>
              <Button
                variant="link"
                size="sm"
                className="h-auto p-0"
                disabled={disabled}
                onClick={() => {
                  setTab(loaded.from);
                  if (loaded.from === "csv") inputRef.current?.click();
                }}
              >
                Replace
              </Button>
            </span>
          ) : (
            "No data loaded yet."
          )}
        </p>

        <Tabs value={tab} onValueChange={(v) => setTab(v as ImportSource)}>
          <TabsList>
            <TabsTrigger value="csv">File</TabsTrigger>
            <TabsTrigger value="sheet">Google Sheet</TabsTrigger>
            <TabsTrigger value="paste">Paste</TabsTrigger>
          </TabsList>

          <TabsContent value="csv" className="pt-2">
            <div
              role="group"
              aria-label="Drop a CSV file here"
              onDragOver={(e) => {
                e.preventDefault();
                if (!disabled) setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                void readFile(e.dataTransfer.files?.[0]);
              }}
              className={cn(
                "rounded-md border-2 border-dashed p-4 text-center",
                dragging ? "border-primary bg-primary/5" : "border-muted-foreground/30",
              )}
            >
              <input
                ref={inputRef}
                type="file"
                accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
                className="hidden"
                tabIndex={-1}
                aria-hidden
                disabled={disabled}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  // Cleared so picking the same file again still fires onChange.
                  e.target.value = "";
                  void readFile(file);
                }}
              />
              <Button onClick={() => inputRef.current?.click()} disabled={disabled}>
                <Upload className="mr-2 h-4 w-4" />
                Choose CSV file
              </Button>
              <p className="mt-2 text-xs text-muted-foreground">
                Or drop a .csv or .tsv file here. In Google Sheets: File, then
                Download, then Comma-separated values (.csv).
              </p>
              {/* US-2518: these headers are the ones guessField() recognises, so
                  a file built on the template maps itself. */}
              <Button variant="ghost" size="sm" className="mt-2" onClick={onDownloadTemplate}>
                <Download className="mr-2 h-4 w-4" />
                Download the CSV template
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="sheet" className="pt-2">
            <p className="text-xs text-muted-foreground">
              Paste a share link. The sheet must be shared with{" "}
              <strong>Anyone with the link</strong> (Viewer). We pull the first
              tab; add <code>#gid=...</code> to pick another. You can set it
              back to Restricted once the import is done.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              <Input
                aria-label="Google Sheet share link"
                value={sheetUrl}
                onChange={(e) => setSheetUrl(e.target.value)}
                placeholder="https://docs.google.com/spreadsheets/d/..."
                className="w-full flex-1 text-xs sm:min-w-[260px]"
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleFetchSheet();
                }}
              />
              <Button
                variant="outline"
                onClick={handleFetchSheet}
                disabled={!sheetUrl.trim() || fetchSheet.isPending || disabled}
              >
                {fetchSheet.isPending ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Link2 className="mr-2 h-4 w-4" />
                )}
                Fetch sheet
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="paste" className="space-y-2 pt-2">
            {/* US-2335: named, because the placeholder stops being announced
                on the first keystroke. */}
            <Textarea
              aria-label="Paste rows to import"
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              rows={6}
              placeholder={"Container\tItem #\tItem Title\t...\nA1\tGT-0001\tLululemon Align Pant\t..."}
              className="font-mono text-xs"
            />
            <div className="flex justify-end">
              <Button
                onClick={() => onLoad(pasted, "paste", "Pasted rows")}
                disabled={!pasted.trim() || disabled}
              >
                Detect columns
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
