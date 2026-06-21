import { Tag, ShoppingBag, Store, Code, type LucideIcon } from "lucide-react";
import type { UserUseCase } from "@/types/database";

// US-1122: the canonical persona options, shared by the signup form, the
// post-signup OnboardingFlow, and the app-wide activation checklist so they can
// never drift. The `value`s mirror the users.use_case CHECK constraint.
export interface UseCaseOption {
  value: UserUseCase;
  label: string;
  description: string;
  icon: LucideIcon;
}

export const USE_CASE_OPTIONS: UseCaseOption[] = [
  {
    value: "seller",
    label: "Reselling",
    description: "I sell pre-owned clothing and want condition grades.",
    icon: Tag,
  },
  {
    value: "buyer",
    label: "Buying",
    description: "I buy pre-owned clothing and want to verify condition.",
    icon: ShoppingBag,
  },
  {
    value: "consignment",
    label: "Consignment",
    description: "I run a consignment shop or grading service.",
    icon: Store,
  },
  {
    value: "developer",
    label: "Developer",
    description: "I want to integrate grading through the API.",
    icon: Code,
  },
];
