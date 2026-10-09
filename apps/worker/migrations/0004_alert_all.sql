-- "Email me about every site I can see", including sites added later.
ALTER TABLE users ADD COLUMN alert_all INTEGER NOT NULL DEFAULT 0;
