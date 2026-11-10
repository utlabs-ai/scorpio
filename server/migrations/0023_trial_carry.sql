-- A purchase during the Pro trial keeps what was left of the trial: carry_ms is that time, added after
-- every paid end of the subscription that replaced the trial. NULL or 0: nothing carried. Another subscription starts
-- without it.
ALTER TABLE entitlements ADD COLUMN carry_ms INTEGER;
