ALTER TABLE `postings` ADD `delisted_reason` text;--> statement-breakpoint
-- Backfill. Until this migration, `linkcheck` was the ONLY writer of `delisted_at` — the
-- ghost pass existed in `lib/dedupe.ts` but nothing ran it. So every row already carrying a
-- `delisted_at` was marked by `linkcheck`, and saying so is what keeps the ghost pass from
-- clearing it on the next cycle. A row left NULL here would be delisted with no owner:
-- neither pass would ever restore it, however alive the job turned out to be.
UPDATE `postings` SET `delisted_reason` = 'linkcheck' WHERE `delisted_at` IS NOT NULL;
