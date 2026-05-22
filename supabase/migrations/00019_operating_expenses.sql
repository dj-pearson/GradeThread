-- FlipDesk operating expenses: business overhead not tied to a single item
-- (shipping supplies, mileage, subscriptions, platform fees, etc.) so net
-- profit can reflect true cost, not just per-item P&L.

CREATE TYPE public.expense_category AS ENUM (
  'shipping_supplies',
  'mileage',
  'subscriptions',
  'platform_fees',
  'sourcing_travel',
  'equipment',
  'storage',
  'other'
);

CREATE TABLE public.flipdesk_expenses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  category      public.expense_category NOT NULL DEFAULT 'other',
  description   text,
  amount        decimal(10,2) NOT NULL,
  spent_on      date NOT NULL DEFAULT CURRENT_DATE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_flipdesk_expenses_user_id ON public.flipdesk_expenses(user_id);
CREATE INDEX idx_flipdesk_expenses_spent_on
  ON public.flipdesk_expenses(spent_on DESC);

CREATE TRIGGER set_flipdesk_expenses_updated_at
  BEFORE UPDATE ON public.flipdesk_expenses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.flipdesk_expenses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view own expenses"
  ON public.flipdesk_expenses FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Users can create expenses"
  ON public.flipdesk_expenses FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Users can update own expenses"
  ON public.flipdesk_expenses FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Users can delete own expenses"
  ON public.flipdesk_expenses FOR DELETE USING (auth.uid() = user_id);
