-- Which AI tools have reported through each device key (comma-separated source names), so the setup page can show
-- "connected" the moment an agent finishes configuring itself.
ALTER TABLE devices ADD COLUMN sources TEXT NOT NULL DEFAULT '';
-- Keys that already reported get the tools seen on their farm so far (exact from the next event on).
UPDATE devices SET sources = COALESCE((SELECT group_concat(source) FROM (SELECT DISTINCT source FROM tasks WHERE tasks.farm_key = devices.farm_key)), '') WHERE last_seen IS NOT NULL;
