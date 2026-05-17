import assert from "node:assert/strict";
import test from "node:test";
import { resolveGeneratePlan } from "../src/generate.js";
import { loadScraper, scraperExists } from "../src/runtime.js";

test("has-scraper is case-insensitive by normalized slug", async () => {
	assert.equal(await scraperExists("STRIPE"), true);
	assert.equal(await scraperExists("stripe"), true);
	assert.equal(await scraperExists("Stripe"), true);
});

test("generate-scraper chooses heal mode when scraper exists", async () => {
	const plan = await resolveGeneratePlan("STRIPE");
	assert.equal(plan.companySlug, "stripe");
	assert.equal(plan.mode, "heal");
});

test("existing Stripe scraper can be loaded", async () => {
	const { slug, scraper } = await loadScraper("Stripe");
	assert.equal(slug, "stripe");
	assert.equal(typeof scraper.firstRun, "function");
	assert.equal(typeof scraper.secondRun, "function");
});
