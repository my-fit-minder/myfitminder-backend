-- MyFitMinder Database Schema
-- Run this in your Supabase SQL editor

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users table (extends Supabase auth.users)
CREATE TABLE IF NOT EXISTS public.users (
    id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
    email TEXT UNIQUE NOT NULL,
    stripe_customer_id TEXT,
    default_payment_method_id TEXT,
    payout_bank_account_id TEXT,
    payout_method TEXT CHECK (payout_method IN ('bank_account', 'debit_card', NULL)),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS payout_bank_account_id TEXT; 
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS payout_method TEXT CHECK (payout_method IN ('bank_account', 'debit_card', NULL));

-- Goals table
CREATE TABLE IF NOT EXISTS public.goals (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    type TEXT NOT NULL DEFAULT 'exercise',
    frequency_per_week INTEGER NOT NULL CHECK (frequency_per_week > 0 AND frequency_per_week <= 7),
    min_duration_minutes INTEGER NOT NULL CHECK (min_duration_minutes > 0),
    stake_amount DECIMAL(10, 2) NOT NULL CHECK (stake_amount > 0),
    start_date TIMESTAMP WITH TIME ZONE NOT NULL,
    end_date TIMESTAMP WITH TIME ZONE NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'canceled')),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    CHECK (end_date > start_date)
);

-- Workout logs table
CREATE TABLE IF NOT EXISTS public.workout_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    goal_id UUID REFERENCES public.goals(id) ON DELETE SET NULL,
    date TIMESTAMP WITH TIME ZONE NOT NULL,
    duration_minutes INTEGER NOT NULL CHECK (duration_minutes >= 0),
    healthkit_id TEXT,
    source TEXT NOT NULL DEFAULT 'apple_health',
    verified BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(user_id, date, goal_id)
);

-- Commitment balance table
CREATE TABLE IF NOT EXISTS public.commitment_balances (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL UNIQUE REFERENCES public.users(id) ON DELETE CASCADE,
    total_deposit DECIMAL(10, 2) NOT NULL DEFAULT 0 CHECK (total_deposit >= 0),
    available_balance DECIMAL(10, 2) NOT NULL DEFAULT 0 CHECK (available_balance >= 0),
    pending_penalties DECIMAL(10, 2) NOT NULL DEFAULT 0 CHECK (pending_penalties >= 0),
    total_payout DECIMAL(10, 2) NOT NULL DEFAULT 0 CHECK (total_payout >= 0),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

ALTER TABLE public.commitment_balances ADD COLUMN IF NOT EXISTS total_payout DECIMAL(10, 2) NOT NULL DEFAULT 0 CHECK (total_payout >= 0);

-- Payment transactions table
CREATE TABLE IF NOT EXISTS public.payment_transactions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    stripe_payment_intent_id TEXT,
    stripe_customer_id TEXT,
    amount DECIMAL(10, 2) NOT NULL,
    currency TEXT NOT NULL DEFAULT 'usd',
    status TEXT NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded', 'payout_requested', 'payout_succeeded', 'payout_failed')),
    type TEXT NOT NULL CHECK (type IN ('deposit', 'penalty', 'refund', 'payout')),
    goal_id UUID REFERENCES public.goals(id) ON DELETE SET NULL,
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);
ALTER TABLE public.payment_transactions ADD COLUMN IF NOT EXISTS type TEXT NOT NULL CHECK (type IN ('deposit', 'penalty', 'refund', 'payout'));
ALTER TABLE public.commitment_balances ADD COLUMN IF NOT EXISTS total_payout DECIMAL(10, 2) NOT NULL DEFAULT 0 CHECK (total_payout >= 0);

-- Penalty records table
CREATE TABLE IF NOT EXISTS public.penalty_records (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    goal_id UUID NOT NULL REFERENCES public.goals(id) ON DELETE CASCADE,
    week_start_date DATE NOT NULL,
    week_end_date DATE NOT NULL,
    required_days INTEGER NOT NULL,
    completed_days INTEGER NOT NULL DEFAULT 0,
    failed_days INTEGER NOT NULL DEFAULT 0,
    penalty_amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
    paid BOOLEAN DEFAULT false,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(goal_id, week_start_date)
);

-- Audit log table (for legal compliance)
CREATE TABLE IF NOT EXISTS public.audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
    action TEXT NOT NULL,
    entity_type TEXT,
    entity_id UUID,
    details JSONB,
    ip_address TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_goals_user_id ON public.goals(user_id);
CREATE INDEX IF NOT EXISTS idx_goals_status ON public.goals(status);
CREATE INDEX IF NOT EXISTS idx_workout_logs_user_id ON public.workout_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_workout_logs_date ON public.workout_logs(date);
CREATE INDEX IF NOT EXISTS idx_workout_logs_goal_id ON public.workout_logs(goal_id);
CREATE INDEX IF NOT EXISTS idx_payment_transactions_user_id ON public.payment_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_penalty_records_goal_id ON public.penalty_records(goal_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_id ON public.audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON public.audit_logs(created_at);

-- Function to update updated_at timestamp
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Triggers for updated_at
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON public.users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_goals_updated_at BEFORE UPDATE ON public.goals
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_workout_logs_updated_at BEFORE UPDATE ON public.workout_logs
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_commitment_balances_updated_at BEFORE UPDATE ON public.commitment_balances
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_payment_transactions_updated_at BEFORE UPDATE ON public.payment_transactions
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_penalty_records_updated_at BEFORE UPDATE ON public.penalty_records
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Row Level Security (RLS) policies
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.goals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workout_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commitment_balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.penalty_records ENABLE ROW LEVEL SECURITY;

-- Users can read their own data
CREATE POLICY "Users can read own data" ON public.users
    FOR SELECT USING (auth.uid() = id);

CREATE POLICY "Users can read own goals" ON public.goals
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can read own workout logs" ON public.workout_logs
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can read own balance" ON public.commitment_balances
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can read own transactions" ON public.payment_transactions
    FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can read own penalties" ON public.penalty_records
    FOR SELECT USING (auth.uid() IN (SELECT user_id FROM public.goals WHERE id = penalty_records.goal_id));

-- Users can insert their own goals
CREATE POLICY "Users can insert own goals" ON public.goals
    FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Users can update their own goals
CREATE POLICY "Users can update own goals" ON public.goals
    FOR UPDATE USING (auth.uid() = user_id);

-- Users can delete their own goals (soft delete via status update)
CREATE POLICY "Users can delete own goals" ON public.goals
    FOR DELETE USING (auth.uid() = user_id);

-- Users can insert their own workout logs
CREATE POLICY "Users can insert own workout logs" ON public.workout_logs
    FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Users can update their own workout logs
CREATE POLICY "Users can update own workout logs" ON public.workout_logs
    FOR UPDATE USING (auth.uid() = user_id);

-- Users can delete their own workout logs
CREATE POLICY "Users can delete own workout logs" ON public.workout_logs
    FOR DELETE USING (auth.uid() = user_id);

-- Users can update their own balance (typically done by backend service role)
-- Note: Balance updates are usually done server-side, but we allow users to read
CREATE POLICY "Users can update own balance" ON public.commitment_balances
    FOR UPDATE USING (auth.uid() = user_id);

-- Users can insert their own payment transactions
CREATE POLICY "Users can insert own transactions" ON public.payment_transactions
    FOR INSERT WITH CHECK (auth.uid() = user_id);

-- Users can update their own payment transactions
CREATE POLICY "Users can update own transactions" ON public.payment_transactions
    FOR UPDATE USING (auth.uid() = user_id);

-- Migration: Update workout_logs unique constraint for aggregated daily totals
-- Run this if you're updating an existing database:
-- ALTER TABLE public.workout_logs DROP CONSTRAINT IF EXISTS workout_logs_user_id_date_healthkit_id_key;
-- ALTER TABLE public.workout_logs ADD CONSTRAINT workout_logs_user_id_date_goal_id_key UNIQUE(user_id, date, goal_id);
--
-- Note: This changes from tracking individual workouts to aggregated daily totals per goal

-- Migration: Convert workout_logs date from DATE to TIMESTAMP WITH TIME ZONE
-- Run this if you're updating an existing database:
-- ALTER TABLE public.workout_logs 
--   ALTER COLUMN date TYPE TIMESTAMP WITH TIME ZONE USING date::timestamp with time zone;
--
-- Note: This converts existing DATE values to TIMESTAMP at midnight UTC

-- Migration: Convert goal dates from DATE to TIMESTAMP WITH TIME ZONE
-- Run this if you're updating an existing database:
-- ALTER TABLE public.goals 
--   ALTER COLUMN start_date TYPE TIMESTAMP WITH TIME ZONE USING start_date::timestamp with time zone,
--   ALTER COLUMN end_date TYPE TIMESTAMP WITH TIME ZONE USING end_date::timestamp with time zone;
--
-- Note: This converts existing DATE values to TIMESTAMP at midnight UTC
-- If you have existing goals, you may want to adjust them manually to reflect
-- the correct start/end of day in the user's timezone

-- Migration: Add default_payment_method_id column if not exists
-- Run this if you're updating an existing database:
-- ALTER TABLE public.users ADD COLUMN IF NOT EXISTS default_payment_method_id TEXT;

-- Migration: Update payment_transactions constraints to include payout
-- Run this if you're updating an existing database:
-- 
-- Update type constraint to include 'payout'
-- ALTER TABLE public.payment_transactions DROP CONSTRAINT IF EXISTS payment_transactions_type_check;
-- ALTER TABLE public.payment_transactions ADD CONSTRAINT payment_transactions_type_check CHECK (type IN ('deposit', 'penalty', 'refund', 'payout'));
--
-- Update status constraint to include payout statuses
-- ALTER TABLE public.payment_transactions DROP CONSTRAINT IF EXISTS payment_transactions_status_check;
-- ALTER TABLE public.payment_transactions ADD CONSTRAINT payment_transactions_status_check CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded', 'payout_requested', 'payout_succeeded', 'payout_failed'));

