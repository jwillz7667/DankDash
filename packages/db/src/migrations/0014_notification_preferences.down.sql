-- Rollback for 0014_notification_preferences.
-- Dropping the table removes its UNIQUE constraint and FK automatically. No
-- data restoration is needed: a missing row already means "all defaults", so
-- the dispatcher reverts to deliver-everything for every user.
DROP TABLE IF EXISTS "notification_preferences";
