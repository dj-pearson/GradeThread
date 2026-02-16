import { Outlet } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";

export function RootLayout() {
  return (
    <>
      <Outlet />
      <Toaster position="bottom-right" richColors />
    </>
  );
}
