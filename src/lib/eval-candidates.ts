import { supabase } from "@/lib/supabase";
import { edgeApiUrl } from "@/lib/edge-api";

/**
 * Promote a corrected grade into a CANDIDATE golden eval case (US-329).
 *
 * Called best-effort after a reviewer adjusts a grade or resolves a dispute by
 * adjusting it: the corrected garment becomes a pending eval case (admin must
 * approve before it counts toward the eval gate). Never throws — the correction
 * itself has already been saved; growing the benchmark is a bonus.
 */
export async function promoteEvalCandidate(
  gradeReportId: string,
  source: "human_review" | "dispute",
): Promise<void> {
  try {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    if (!session?.access_token) return;
    await fetch(`${edgeApiUrl()}/api/admin/grading/eval/cases/promote`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ grade_report_id: gradeReportId, source }),
    });
  } catch {
    /* best-effort — never block the correction it follows */
  }
}
