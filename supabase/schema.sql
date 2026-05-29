-- Voer dit eenmalig uit in de Supabase SQL Editor
-- Dashboard > SQL Editor > New Query > plak dit > Run

CREATE TABLE IF NOT EXISTS dashboard_data (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    UUID REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE NOT NULL,
  data       JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE dashboard_data ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users own their data"
  ON dashboard_data FOR ALL TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
