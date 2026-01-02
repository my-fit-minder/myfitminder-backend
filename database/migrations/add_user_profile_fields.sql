-- Add name, date_of_birth, and currency fields to users table
-- USD (United States) and CAD (Canada) only
ALTER TABLE public.users 
ADD COLUMN IF NOT EXISTS name TEXT,
ADD COLUMN IF NOT EXISTS date_of_birth DATE,
ADD COLUMN IF NOT EXISTS currency TEXT NOT NULL DEFAULT 'usd' CHECK (currency IN ('usd', 'cad'));

-- Update existing users to have default currency
UPDATE public.users SET currency = 'usd' WHERE currency IS NULL;

