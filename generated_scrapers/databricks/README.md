# Databricks Generated Scraper

Typed scraper for the Databricks careers board:

https://www.databricks.com/company/careers/open-positions

- `firstRun(ctx)` reads the public Greenhouse board API and applies `ctx.maxJobs` as a hard cap.
- `secondRun(ctx)` fetches one Greenhouse posting by id, returns typed fields only, and reports missing or closed postings as `status: "removed"`.
- The worker owns all database writes.

## Validate

```bash
npm run check
```
