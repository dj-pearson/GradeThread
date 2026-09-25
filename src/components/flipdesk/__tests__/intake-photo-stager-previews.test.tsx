// Preview object URLs are revoked when their photo leaves the list. The old
// effect captured only the first render, so every later batch leaked.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  IntakePhotoStager,
  type StagedPhoto,
} from "@/components/flipdesk/intake-photo-stager";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;
let revoke: ReturnType<typeof vi.fn>;
const originalRevoke = URL.revokeObjectURL;

const photo = (n: number): StagedPhoto => ({
  id: `s${n}`,
  file: new File(["x"], `p${n}.jpg`, { type: "image/jpeg" }),
  previewUrl: `blob:test/${n}`,
  photoType: n === 1 ? "front" : "back",
  photoRole: null,
});

function render(photos: StagedPhoto[]) {
  act(() =>
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <IntakePhotoStager photos={photos} onChange={() => {}} />
      </QueryClientProvider>,
    ),
  );
}

beforeEach(() => {
  revoke = vi.fn();
  URL.revokeObjectURL = revoke as unknown as typeof URL.revokeObjectURL;
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  URL.revokeObjectURL = originalRevoke;
});

describe("IntakePhotoStager previews", () => {
  it("revokes a batch cleared after the first render", () => {
    render([]);
    render([photo(1), photo(2)]);
    expect(revoke).not.toHaveBeenCalled();
    render([photo(2)]);
    expect(revoke).toHaveBeenCalledWith("blob:test/1");
    render([]);
    expect(revoke).toHaveBeenCalledWith("blob:test/2");
  });
});
