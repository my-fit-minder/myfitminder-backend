-- Add UPDATE policy for users table
-- This allows users to update their own profile data
CREATE POLICY "Users can update own data" ON public.users
    FOR UPDATE USING (auth.uid() = id);

