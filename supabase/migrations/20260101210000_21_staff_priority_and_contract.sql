-- Add shift_priority and contract_type to staff table
ALTER TABLE public.staff 
ADD COLUMN IF NOT EXISTS shift_priority text DEFAULT 'medium' CHECK (shift_priority IN ('high', 'medium', 'low')),
ADD COLUMN IF NOT EXISTS contract_type text DEFAULT 'general' CHECK (contract_type IN ('regular', 'general', 'spot'));

-- Update existing rows
UPDATE public.staff SET shift_priority = 'medium' WHERE shift_priority IS NULL;
UPDATE public.staff SET contract_type = 'general' WHERE contract_type IS NULL;

-- Refresh schema cache for PostgREST
NOTIFY pgrst, 'reload schema';
