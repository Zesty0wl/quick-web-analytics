-- Per-site daily event limit (a brake on costs). NULL = the default (DEFAULT_DAILY_CAP, 3,000,000); 0 = no limit.
ALTER TABLE sites ADD COLUMN daily_cap INTEGER;
