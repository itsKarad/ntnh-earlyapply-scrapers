import assert from "node:assert/strict";
import test from "node:test";
import { resolveGeneratePlan } from "../src/generate.js";
import { loadScraper, scraperExists } from "../src/runtime.js";

test("has-scraper is case-insensitive by normalized slug", async () => {
	assert.equal(await scraperExists("OPENAI"), true);
	assert.equal(await scraperExists("openai"), true);
	assert.equal(await scraperExists("OpenAI"), true);
});

test("generate-scraper chooses heal mode when scraper exists", async () => {
	const plan = await resolveGeneratePlan("OPENAI");
	assert.equal(plan.companySlug, "openai");
	assert.equal(plan.mode, "heal");
});

test("existing OpenAI scraper can be loaded", async () => {
	const { slug, scraper } = await loadScraper("OpenAI");
	assert.equal(slug, "openai");
	assert.equal(typeof scraper.firstRun, "function");
	assert.equal(typeof scraper.secondRun, "function");
});
