-- Keep existing handles stable: their names are already embedded in room and agent member names.
UPDATE users SET is_test = 1
WHERE handle IN ('impltest', 'impltest2', 'impltest3', 'impltestb', 'demo', 'kai', 'storagetest')
   OR handle LIKE 'qa-%';
