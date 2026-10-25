ALTER TABLE attempts ADD COLUMN max_score REAL CHECK (max_score IS NULL OR max_score > 0);
