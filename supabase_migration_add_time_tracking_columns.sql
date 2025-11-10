-- Migration to add new columns to time_tracking table for pause/resume and location tracking
-- Run this SQL in your Supabase SQL Editor

-- Add first_start_time column (stores initial job start time)
ALTER TABLE time_tracking 
ADD COLUMN IF NOT EXISTS first_start_time timestamptz;

-- Add final_end_time column (stores final job completion time)
ALTER TABLE time_tracking 
ADD COLUMN IF NOT EXISTS final_end_time timestamptz;

-- Add actual_working_seconds column (total work time excluding pauses)
ALTER TABLE time_tracking 
ADD COLUMN IF NOT EXISTS actual_working_seconds integer DEFAULT 0;

-- Add paused_duration_seconds column (total paused time in seconds)
ALTER TABLE time_tracking 
ADD COLUMN IF NOT EXISTS paused_duration_seconds integer DEFAULT 0;

-- Add start_latitude column (engineer location at job start)
ALTER TABLE time_tracking 
ADD COLUMN IF NOT EXISTS start_latitude double precision;

-- Add start_longitude column (engineer location at job start)
ALTER TABLE time_tracking 
ADD COLUMN IF NOT EXISTS start_longitude double precision;

-- Add is_paused column (current pause state: true/false)
ALTER TABLE time_tracking 
ADD COLUMN IF NOT EXISTS is_paused boolean DEFAULT false;

-- Add pause_start_time column (when current pause began)
ALTER TABLE time_tracking 
ADD COLUMN IF NOT EXISTS pause_start_time timestamptz;

-- Update existing records to set first_start_time from start_time
UPDATE time_tracking 
SET first_start_time = start_time 
WHERE first_start_time IS NULL AND start_time IS NOT NULL;

-- Update existing records to set final_end_time from end_time
UPDATE time_tracking 
SET final_end_time = end_time 
WHERE final_end_time IS NULL AND end_time IS NOT NULL;

-- Update existing records to calculate actual_working_seconds from duration_minutes
UPDATE time_tracking 
SET actual_working_seconds = duration_minutes * 60 
WHERE actual_working_seconds IS NULL OR actual_working_seconds = 0;

-- Verification query to check columns were added
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'time_tracking'
ORDER BY ordinal_position;
