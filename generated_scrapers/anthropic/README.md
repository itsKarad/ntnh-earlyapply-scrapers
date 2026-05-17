# Anthropic Generated Scraper

- Official board: `https://www.anthropic.com/jobs`
- `firstRun(ctx)` reads the public Greenhouse board API and applies `ctx.maxJobs` as a hard cap.
- `secondRun(ctx)` fetches one Greenhouse posting by id, returns typed fields only, and reports missing or closed postings as `status: "removed"`.
- The scraper logs through `ctx.logger` and does not write to any database.
