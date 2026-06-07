-- Rollback for 0012_password_reset_tokens.
-- Dropping the table removes its dependent indexes automatically.
DROP TABLE IF EXISTS "password_reset_tokens";
