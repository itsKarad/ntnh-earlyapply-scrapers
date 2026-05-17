import type {
	FirstRunJob,
	FirstRunResult,
	ScraperCompanyContext,
	SecondRunContext,
	SecondRunResult,
} from "@/app/service/scraper-types";

const OFFICIAL_BOARD_URL = "https://openai.com/careers/search/";
const OPENAI_ORIGIN = "https://openai.com";
const ASHBY_BOARD_NAME = "openai";
const ASHBY_BOARD_API = `https://api.ashbyhq.com/posting-api/job-board/${ASHBY_BOARD_NAME}`;
const ASHBY_JOB_BASE_URL = `https://jobs.ashbyhq.com/${ASHBY_BOARD_NAME}`;
const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 15_000;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type AshbyAddress = {
	postalAddress?: {
		addressLocality?: string | null;
		addressRegion?: string | null;
		addressCountry?: string | null;
	} | null;
};

type AshbySecondaryLocation = {
	location?: string | null;
	address?: {
		addressLocality?: string | null;
		addressRegion?: string | null;
		addressCountry?: string | null;
	} | null;
};

type AshbyCompensationComponent = {
	compensationType?: string | null;
	interval?: string | null;
	currencyCode?: string | null;
	minValue?: number | null;
	maxValue?: number | null;
};

type AshbyCompensation = {
	compensationTierSummary?: string | null;
	scrapeableCompensationSalarySummary?: string | null;
	summaryComponents?: AshbyCompensationComponent[] | null;
	compensationTiers?: Array<{
		components?: AshbyCompensationComponent[] | null;
	}> | null;
};

type AshbyJob = {
	id?: string | null;
	title?: string | null;
	location?: string | null;
	secondaryLocations?: AshbySecondaryLocation[] | null;
	department?: string | null;
	team?: string | null;
	isListed?: boolean | null;
	isRemote?: boolean | null;
	workplaceType?: "OnSite" | "Remote" | "Hybrid" | string | null;
	descriptionHtml?: string | null;
	descriptionPlain?: string | null;
	publishedAt?: string | null;
	employmentType?: "FullTime" | "PartTime" | "Intern" | "Contract" | "Temporary" | string | null;
	address?: AshbyAddress | null;
	jobUrl?: string | null;
	applyUrl?: string | null;
	compensation?: AshbyCompensation | null;
};

type AshbyJobsResponse = {
	jobs?: AshbyJob[];
};

type FetchTextResult = {
	status: number | null;
	html: string | null;
	error: string | null;
};

type ParsedOfficialJob = {
	url: string;
	title: string;
	description: string | null;
	locations: string[];
	tags: string[];
	employmentType: string | null;
	workplaceType: string | null;
	postedAt: string | null;
	salaryMin: number | null;
	salaryMax: number | null;
	salaryCurrency: string | null;
	salaryInterval: string | null;
	applyUrl: string | null;
	raw: Record<string, unknown>;
};

function maxJobsLimit(ctx: ScraperCompanyContext): number | null {
	if (ctx.maxJobs === undefined) {
		return null;
	}
	if (!Number.isFinite(ctx.maxJobs)) {
		return 0;
	}

	return Math.max(0, Math.floor(ctx.maxJobs));
}

function compactText(value: unknown): string | null {
	if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
		return null;
	}

	const normalized = String(value)
		.replace(/\u00a0/g, " ")
		.replace(/[ \t\r\f\v]+/g, " ")
		.replace(/\n[ \t]+/g, "\n")
		.trim();

	return normalized || null;
}

function decodeHtmlEntities(value: string): string {
	return value
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;|&apos;/gi, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&#(\d+);/g, (_, codePoint: string) => String.fromCodePoint(Number(codePoint)))
		.replace(/&#x([0-9a-f]+);/gi, (_, codePoint: string) => String.fromCodePoint(Number.parseInt(codePoint, 16)));
}

function htmlToText(html: string | null | undefined): string | null {
	if (!html) {
		return null;
	}

	const withBreaks = html
		.replace(/<script[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<\s*br\s*\/?>/gi, "\n")
		.replace(/<\s*\/p\s*>/gi, "\n\n")
		.replace(/<\s*\/li\s*>/gi, "\n")
		.replace(/<\s*li[^>]*>/gi, "- ")
		.replace(/<\s*\/(h1|h2|h3|h4|h5|h6|section|article|div|header|main)\s*>/gi, "\n")
		.replace(/<[^>]+>/g, " ");

	const text = decodeHtmlEntities(withBreaks)
		.split("\n")
		.map((line) => compactText(line))
		.filter((line): line is string => Boolean(line))
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	return text || null;
}

function normalizeUrl(value: string | null | undefined, base = OFFICIAL_BOARD_URL): string | null {
	const text = compactText(value);
	if (!text) {
		return null;
	}

	try {
		const parsed = new URL(decodeHtmlEntities(text), base);
		if (!/^https?:$/i.test(parsed.protocol)) {
			return null;
		}
		parsed.hash = "";
		return parsed.toString();
	} catch {
		return null;
	}
}

function normalizeOpenAiUrl(value: string | null | undefined): string | null {
	const url = normalizeUrl(value, OPENAI_ORIGIN);
	if (!url) {
		return null;
	}

	const parsed = new URL(url);
	if (!/(^|\.)openai\.com$/i.test(parsed.hostname)) {
		return null;
	}
	if (!/^\/careers\/(?!search\/?$).+\/?$/i.test(parsed.pathname)) {
		return null;
	}

	return parsed.toString();
}

function normalizeDate(value: unknown): string | null {
	const text = compactText(value);
	if (!text) {
		return null;
	}

	const timestamp = Date.parse(text);
	return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function requestHeaders(accept: string): HeadersInit {
	return {
		accept,
		"accept-language": "en-US,en;q=0.9",
		"cache-control": "no-cache",
		pragma: "no-cache",
		referer: OPENAI_ORIGIN,
		"user-agent": USER_AGENT,
	};
}

async function fetchWithTimeout(url: string | URL, accept: string): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		return await fetch(url, {
			headers: requestHeaders(accept),
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timeout);
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function fetchText(url: string): Promise<FetchTextResult> {
	try {
		const response = await fetchWithTimeout(url, "text/html,application/xhtml+xml");
		if (response.status === 404 || response.status === 410) {
			return { status: response.status, html: null, error: null };
		}
		if (!response.ok) {
			return {
				status: response.status,
				html: null,
				error: `OpenAI careers request failed with HTTP ${response.status}`,
			};
		}

		return { status: response.status, html: await response.text(), error: null };
	} catch (error) {
		return {
			status: null,
			html: null,
			error: errorMessage(error),
		};
	}
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(object: JsonObject | null | undefined, keys: string[]): string | null {
	if (!object) {
		return null;
	}

	for (const key of keys) {
		const value = object[key];
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			const text = compactText(value);
			if (text) {
				return decodeHtmlEntities(text);
			}
		}
	}

	return null;
}

function toLines(text: string | null): string[] {
	return (text ?? "")
		.split("\n")
		.map((line) => compactText(line))
		.filter((line): line is string => Boolean(line));
}

function titleFromAnchorHtml(innerHtml: string): string | null {
	const headingMatch = innerHtml.match(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/i);
	const heading = htmlToText(headingMatch?.[1]);
	if (heading && !/^apply now$/i.test(heading)) {
		return heading;
	}

	return (
		toLines(htmlToText(innerHtml)).find(
			(line) =>
				!/^(apply now|careers|all teams|all locations|\d+\s+jobs?)$/i.test(line) &&
				!/^opens in a new window$/i.test(line),
		) ?? null
	);
}

function parseOfficialSearchJobs(html: string, limit: number | null): FirstRunJob[] {
	const jobs: FirstRunJob[] = [];
	const seen = new Set<string>();
	const anchorPattern = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
	let match: RegExpExecArray | null;

	while ((match = anchorPattern.exec(html))) {
		const url = normalizeOpenAiUrl(match[1]);
		if (!url || seen.has(url)) {
			continue;
		}

		const title = titleFromAnchorHtml(match[2]);
		if (!title) {
			continue;
		}

		const cardLines = toLines(htmlToText(match[2]));
		const location = cardLines
			.filter((line) => line !== title && !/^apply now$/i.test(line))
			.at(-1) ?? null;

		seen.add(url);
		jobs.push({
			url,
			title,
			location,
			raw: {
				source: "openai-careers-html",
			},
		});

		if (limit !== null && jobs.length >= limit) {
			break;
		}
	}

	return jobs;
}

function extractJsonLdObjects(html: string): JsonObject[] {
	const objects: JsonObject[] = [];
	const scriptPattern = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
	let match: RegExpExecArray | null;

	while ((match = scriptPattern.exec(html))) {
		try {
			const parsed = JSON.parse(decodeHtmlEntities(match[1].trim())) as JsonValue;
			const items = Array.isArray(parsed) ? parsed : [parsed];
			for (const item of items) {
				if (isJsonObject(item)) {
					objects.push(item);
					const graph = item["@graph"];
					if (Array.isArray(graph)) {
						for (const graphItem of graph) {
							if (isJsonObject(graphItem)) {
								objects.push(graphItem);
							}
						}
					}
				}
			}
		} catch {
			// OpenAI pages are usable without structured data.
		}
	}

	return objects;
}

function jsonTypeMatches(object: JsonObject, expected: string): boolean {
	const value = object["@type"];
	if (typeof value === "string") {
		return value.toLowerCase() === expected.toLowerCase();
	}
	if (Array.isArray(value)) {
		return value.some((item) => typeof item === "string" && item.toLowerCase() === expected.toLowerCase());
	}

	return false;
}

function extractHtmlTitle(html: string): string | null {
	const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
	const h2 = html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
	const pageTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

	return [h1?.[1], h2?.[1], pageTitle?.[1]]
		.map((value) => htmlToText(value))
		.map((value) => value?.replace(/\s+\|\s+OpenAI$/i, "").trim() ?? null)
		.find((value) => value && !/^careers(?: at openai)?$/i.test(value)) ?? null;
}

function extractApplyUrl(html: string): string | null {
	const ashbyMatch = html.match(/href=["']([^"']*jobs\.ashbyhq\.com\/openai\/[^"']+)["']/i);
	return normalizeUrl(ashbyMatch?.[1] ?? null);
}

function extractJobIdFromUrl(jobUrl: string): string | null {
	try {
		const parsed = new URL(jobUrl);
		if (parsed.hostname === "jobs.ashbyhq.com") {
			const segments = parsed.pathname.split("/").filter(Boolean);
			return segments[0]?.toLowerCase() === ASHBY_BOARD_NAME && segments[1] ? decodeURIComponent(segments[1]) : null;
		}

		return parsed.searchParams.get("ashby_jid") ?? parsed.searchParams.get("jobId") ?? parsed.searchParams.get("job_id");
	} catch {
		return null;
	}
}

function pathSlugTokens(value: string): string[] {
	try {
		const parsed = new URL(value);
		const slug = parsed.pathname.split("/").filter(Boolean).at(-1) ?? "";
		return textTokens(slug.replace(/-/g, " "));
	} catch {
		return [];
	}
}

function textTokens(value: string | null | undefined): string[] {
	const text = compactText(value);
	if (!text) {
		return [];
	}

	return text
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.split(/[^a-z0-9]+/)
		.filter((token) => token.length > 0);
}

function locationFromAddress(address: AshbyAddress["postalAddress"] | AshbySecondaryLocation["address"]): string | null {
	if (!address) {
		return null;
	}

	return [address.addressLocality, address.addressRegion, address.addressCountry]
		.map((part) => compactText(part))
		.filter((part): part is string => Boolean(part))
		.join(", ") || null;
}

function normalizeLocationText(value: string): string[] {
	return value
		.replace(/\b(?:and|or)\b/gi, "|")
		.split(/\s*(?:;|\||\/\s+)\s*/)
		.map((part) => compactText(part))
		.filter((part): part is string => Boolean(part))
		.filter((part) => !/^\d+\s+locations?$/i.test(part));
}

function normalizeLocations(...values: unknown[]): string[] {
	const flattened = values.flatMap((value): string[] => {
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			return normalizeLocationText(String(value));
		}
		if (Array.isArray(value)) {
			return value.flatMap((item) => normalizeLocations(item));
		}
		if (isJsonObject(value as JsonValue)) {
			const object = value as JsonObject;
			const address = isJsonObject(object.address) ? object.address : object;
			return [
				readString(object, ["name"]),
				[readString(address, ["addressLocality"]), readString(address, ["addressRegion"]), readString(address, ["addressCountry"])]
					.filter(Boolean)
					.join(", "),
			].filter((item): item is string => Boolean(item));
		}
		return [];
	});

	return [...new Set(flattened.map((value) => compactText(decodeHtmlEntities(value))).filter((value): value is string => Boolean(value)))].slice(0, 30);
}

function normalizeAshbyLocations(job: AshbyJob): string[] {
	return normalizeLocations(
		job.location,
		locationFromAddress(job.address?.postalAddress ?? null),
		...(job.secondaryLocations ?? []).flatMap((secondaryLocation) => [
			secondaryLocation.location,
			locationFromAddress(secondaryLocation.address ?? null),
		]),
	);
}

function normalizeEmploymentType(value: AshbyJob["employmentType"] | string | null | undefined): string | null {
	switch (value) {
		case "FullTime":
		case "FULL_TIME":
			return "Full-time";
		case "PartTime":
		case "PART_TIME":
			return "Part-time";
		case "Intern":
		case "INTERN":
			return "Internship";
		case "Contract":
		case "CONTRACTOR":
			return "Contract";
		case "Temporary":
		case "TEMPORARY":
			return "Temporary";
		default:
			return compactText(value);
	}
}

function normalizeWorkplaceType(value: AshbyJob["workplaceType"], isRemote: boolean | null | undefined): string | null {
	switch (value) {
		case "OnSite":
			return "On-site";
		case "Remote":
			return "Remote";
		case "Hybrid":
			return "Hybrid";
		default:
			return isRemote ? "Remote" : compactText(value);
	}
}

function inferEmploymentType(title: string, description: string | null, explicit: string | null): string | null {
	if (explicit) {
		return explicit;
	}

	const text = `${title}\n${description ?? ""}`;
	if (/\bintern(ship)?\b/i.test(text)) {
		return "Internship";
	}
	if (/\bcontract(or)?\b/i.test(text)) {
		return "Contract";
	}
	if (/\bpart[- ]time\b/i.test(text)) {
		return "Part-time";
	}
	if (/\bfull[- ]time\b/i.test(text)) {
		return "Full-time";
	}

	return null;
}

function inferWorkplaceType(locations: string[], description: string | null, explicit: string | null): string | null {
	if (explicit) {
		return explicit;
	}

	const text = `${locations.join(" ")} ${description ?? ""}`;
	if (/\bremote\b/i.test(text)) {
		return "Remote";
	}
	if (/\bhybrid\b|\b\d+\s+days?\s+in\s+the\s+office\b/i.test(text)) {
		return "Hybrid";
	}
	if (/\bon[- ]?site\b|\bin office\b/i.test(text)) {
		return "On-site";
	}

	return null;
}

function salaryInterval(value: string | null | undefined): string | null {
	switch (value) {
		case "1 YEAR":
			return "year";
		case "1 MONTH":
			return "month";
		case "1 WEEK":
			return "week";
		case "1 DAY":
			return "day";
		case "1 HOUR":
			return "hour";
		default:
			return null;
	}
}

function parseSalaryText(value: string | null): {
	salaryMin: number | null;
	salaryMax: number | null;
	salaryCurrency: string | null;
	salaryInterval: string | null;
} {
	const text = compactText(value);
	const rangeMatch = text?.match(
		/([A-Z]{3}|\$)?\s?(\d[\d,]*(?:\.\d+)?)(K|M)?\s*(?:-|to|–|—)\s*(?:[A-Z]{3}|\$)?\s?(\d[\d,]*(?:\.\d+)?)(K|M)?/i,
	);
	if (!rangeMatch) {
		return {
			salaryMin: null,
			salaryMax: null,
			salaryCurrency: null,
			salaryInterval: null,
		};
	}

	const scale = (suffix: string | undefined): number => {
		if (/^m$/i.test(suffix ?? "")) {
			return 1_000_000;
		}
		if (/^k$/i.test(suffix ?? "")) {
			return 1_000;
		}
		return 1;
	};
	const salaryMin = Number(rangeMatch[2].replace(/,/g, "")) * scale(rangeMatch[3]);
	const salaryMax = Number(rangeMatch[4].replace(/,/g, "")) * scale(rangeMatch[5]);

	return {
		salaryMin: Number.isFinite(salaryMin) ? salaryMin : null,
		salaryMax: Number.isFinite(salaryMax) ? salaryMax : null,
		salaryCurrency: rangeMatch[1] === "$" ? "USD" : (rangeMatch[1] ?? null),
		salaryInterval: "year",
	};
}

function compensationComponents(job: AshbyJob): AshbyCompensationComponent[] {
	const direct = job.compensation?.summaryComponents ?? [];
	const tiered = (job.compensation?.compensationTiers ?? []).flatMap((tier) => tier.components ?? []);
	return [...direct, ...tiered];
}

function parseAshbySalary(job: AshbyJob): ReturnType<typeof parseSalaryText> {
	const salaryComponent = compensationComponents(job).find(
		(component) => component.compensationType === "Salary" && (component.minValue || component.maxValue),
	);
	if (salaryComponent) {
		return {
			salaryMin: salaryComponent.minValue ?? null,
			salaryMax: salaryComponent.maxValue ?? null,
			salaryCurrency: compactText(salaryComponent.currencyCode),
			salaryInterval: salaryInterval(salaryComponent.interval),
		};
	}

	return parseSalaryText(
		compactText(job.compensation?.scrapeableCompensationSalarySummary) ??
			compactText(job.compensation?.compensationTierSummary),
	);
}

function extractSponsorship(description: string | null): {
	sponsorshipText: string | null;
	sponsorshipAvailable: boolean | null;
} {
	const sponsorshipText =
		description
			?.split("\n")
			.map((line) => compactText(line))
			.find((line) => line && /sponsor|visa|work authorization/i.test(line)) ?? null;

	if (!sponsorshipText) {
		return { sponsorshipText: null, sponsorshipAvailable: null };
	}
	if (/without sponsorship|cannot sponsor|no visa sponsorship|do not sponsor/i.test(sponsorshipText)) {
		return { sponsorshipText, sponsorshipAvailable: false };
	}
	if (/sponsor|sponsorship|visa/i.test(sponsorshipText)) {
		return { sponsorshipText, sponsorshipAvailable: true };
	}

	return { sponsorshipText, sponsorshipAvailable: null };
}

function buildTags(values: Array<string | null | undefined>, locations: string[], workplaceType: string | null): string[] {
	return [
		...new Set(
			[
				...values,
				workplaceType ? `workplace:${workplaceType}` : null,
				...locations.map((location) => `location:${location}`),
			]
				.map((value) => compactText(value))
				.filter((value): value is string => Boolean(value)),
		),
	].slice(0, 50);
}

function canonicalAshbyJobUrl(job: AshbyJob): string {
	const jobUrl = normalizeUrl(job.jobUrl ?? null);
	if (jobUrl) {
		return jobUrl;
	}

	const id = compactText(job.id);
	if (id) {
		return `${ASHBY_JOB_BASE_URL}/${encodeURIComponent(id)}`;
	}

	return OFFICIAL_BOARD_URL;
}

function toFirstRunAshbyJob(job: AshbyJob): FirstRunJob {
	const locations = normalizeAshbyLocations(job);

	return {
		url: canonicalAshbyJobUrl(job),
		title: compactText(job.title),
		postedAt: normalizeDate(job.publishedAt),
		location: locations.join(", ") || null,
		raw: {
			source: "ashby-posting-api",
			id: job.id ?? null,
			boardName: ASHBY_BOARD_NAME,
			applyUrl: job.applyUrl ?? null,
			department: job.department ?? null,
			team: job.team ?? null,
		},
	};
}

async function fetchAshbyJobs(
	ctx: ScraperCompanyContext,
	includeCompensation: boolean,
	limit: number | null,
): Promise<AshbyJob[]> {
	if (limit === 0) {
		return [];
	}

	const url = new URL(ASHBY_BOARD_API);
	url.searchParams.set("includeCompensation", includeCompensation ? "true" : "false");

	await ctx.logger.info("Fetching OpenAI Ashby jobs", {
		url: url.toString(),
		maxJobs: ctx.maxJobs ?? null,
		includeCompensation,
		limit,
	});

	const response = await fetchWithTimeout(url, "application/json");
	if (!response.ok) {
		throw new Error(`OpenAI Ashby jobs request failed with HTTP ${response.status}`);
	}

	const data = (await response.json()) as AshbyJobsResponse;
	const jobs = (Array.isArray(data.jobs) ? data.jobs : []).filter((job) => job.isListed !== false);
	return limit === null ? jobs : jobs.slice(0, limit);
}

function matchesAshbyJob(job: AshbyJob, requestedUrl: string, requestedId: string | null): boolean {
	const canonicalUrl = canonicalAshbyJobUrl(job);
	if (canonicalUrl === requestedUrl || job.applyUrl === requestedUrl) {
		return true;
	}

	const jobId = compactText(job.id) ?? extractJobIdFromUrl(canonicalUrl);
	return Boolean(requestedId && jobId && requestedId === jobId);
}

function ashbyOfficialSlugScore(job: AshbyJob, requestedUrl: string): number {
	const slugTokens = pathSlugTokens(requestedUrl);
	const titleTokens = textTokens(job.title);
	if (slugTokens.length === 0 || titleTokens.length === 0) {
		return 0;
	}

	const slugSet = new Set(slugTokens);
	const matchedTitleTokens = titleTokens.filter((token) => slugSet.has(token)).length;
	const requiredTitleMatches = Math.max(1, Math.ceil(titleTokens.length * 0.75));
	if (matchedTitleTokens < requiredTitleMatches) {
		return 0;
	}

	const slugText = slugTokens.join(" ");
	const titleText = titleTokens.join(" ");
	const locationTokens = normalizeAshbyLocations(job).flatMap(textTokens);
	const locationMatches = locationTokens.filter((token) => slugSet.has(token)).length;
	const teamMatches = textTokens(job.team).filter((token) => slugSet.has(token)).length;
	const departmentMatches = textTokens(job.department).filter((token) => slugSet.has(token)).length;

	return (
		matchedTitleTokens * 10 +
		(slugText.startsWith(titleText) ? 20 : 0) +
		Math.min(locationMatches, 3) * 3 +
		Math.min(teamMatches + departmentMatches, 4)
	);
}

function findAshbyJob(jobs: AshbyJob[], requestedUrl: string, requestedId: string | null): AshbyJob | null {
	const directMatch = jobs.find((candidate) => matchesAshbyJob(candidate, requestedUrl, requestedId));
	if (directMatch) {
		return directMatch;
	}

	const scored = jobs
		.map((job) => ({ job, score: ashbyOfficialSlugScore(job, requestedUrl) }))
		.filter(({ score }) => score > 0)
		.sort((left, right) => right.score - left.score);

	if (scored.length === 0 || scored[0].score === scored[1]?.score) {
		return null;
	}

	return scored[0].job;
}

function ashbyJobToSecondRun(job: AshbyJob, requestedUrl: string, requestedId: string | null): SecondRunResult {
	const description = compactText(job.descriptionPlain) ?? htmlToText(job.descriptionHtml);
	const locations = normalizeAshbyLocations(job);
	const workplaceType = normalizeWorkplaceType(job.workplaceType, job.isRemote);
	const employmentType = normalizeEmploymentType(job.employmentType);
	const salary = parseAshbySalary(job);
	const sponsorship = extractSponsorship(description);
	const title = compactText(job.title) ?? "OpenAI role";

	return {
		status: "ok",
		url: canonicalAshbyJobUrl(job),
		title,
		roleName: title,
		description,
		locations,
		tags: buildTags([job.department, job.team, employmentType], locations, workplaceType),
		employmentType,
		workplaceType,
		postedAt: normalizeDate(job.publishedAt),
		salaryMin: salary.salaryMin,
		salaryMax: salary.salaryMax,
		salaryCurrency: salary.salaryCurrency,
		salaryInterval: salary.salaryInterval,
		sponsorshipText: sponsorship.sponsorshipText,
		sponsorshipAvailable: sponsorship.sponsorshipAvailable,
		raw: {
			source: "ashby-posting-api",
			id: job.id ?? requestedId,
			boardName: ASHBY_BOARD_NAME,
			jobUrl: requestedUrl,
			applyUrl: job.applyUrl ?? null,
			department: job.department ?? null,
			team: job.team ?? null,
		},
	};
}

function subtitleAfterTitle(lines: string[], title: string): string | null {
	const titleIndex = lines.findIndex((line) => line === title);
	if (titleIndex === -1) {
		return null;
	}

	return (
		lines
			.slice(titleIndex + 1)
			.find((line) => !/^apply now/i.test(line) && !/^opens in a new window$/i.test(line)) ?? null
	);
}

function descriptionFromOfficialPage(lines: string[]): string | null {
	const startIndex = lines.findIndex((line) =>
		/^(about the team|about the role|about openai|key responsibilities|responsibilities|qualifications|what you'll do)$/i.test(
			line,
		),
	);
	if (startIndex === -1) {
		return null;
	}

	const endIndex = lines.findIndex((line, index) => index > startIndex && /^(compensation|apply now|our research)$/i.test(line));
	const slice = lines.slice(startIndex, endIndex === -1 ? undefined : endIndex);
	return slice.join("\n").trim() || null;
}

function compensationTextFromLines(lines: string[]): string | null {
	const compensationIndex = lines.findIndex((line) => /^compensation$/i.test(line));
	if (compensationIndex === -1) {
		return null;
	}

	return lines.slice(compensationIndex + 1, compensationIndex + 4).find((line) => /\d/.test(line)) ?? null;
}

function officialStructuredJob(html: string): JsonObject | null {
	return extractJsonLdObjects(html).find((object) => jsonTypeMatches(object, "JobPosting")) ?? null;
}

function parseOfficialJob(html: string, jobUrl: string): ParsedOfficialJob | null {
	const structured = officialStructuredJob(html);
	const pageText = htmlToText(html);
	const lines = toLines(pageText);
	const structuredTitle = readString(structured, ["title", "name"]);
	const title = structuredTitle ?? extractHtmlTitle(html);
	if (!title) {
		return null;
	}

	const subtitle = subtitleAfterTitle(lines, title);
	const subtitleParts = subtitle?.split(/\s+-\s+/) ?? [];
	const team = subtitleParts.length > 1 ? compactText(subtitleParts.slice(0, -1).join(" - ")) : null;
	const subtitleLocation = subtitleParts.length > 1 ? subtitleParts.at(-1) ?? null : subtitle;
	const description =
		htmlToText(readString(structured, ["description"])) ??
		descriptionFromOfficialPage(lines) ??
		pageText;
	const locations = normalizeLocations(structured?.jobLocation, subtitleLocation);
	const explicitEmploymentType = normalizeEmploymentType(readString(structured, ["employmentType"]));
	const employmentType = inferEmploymentType(title, description, explicitEmploymentType);
	const workplaceType = inferWorkplaceType(locations, description, null);
	const salaryText = compensationTextFromLines(lines);
	const salary = parseSalaryText(salaryText);
	const applyUrl = extractApplyUrl(html);

	return {
		url: normalizeOpenAiUrl(jobUrl) ?? jobUrl,
		title,
		description,
		locations,
		tags: buildTags([team, employmentType], locations, workplaceType),
		employmentType,
		workplaceType,
		postedAt: normalizeDate(readString(structured, ["datePosted", "validFrom"])),
		salaryMin: salary.salaryMin,
		salaryMax: salary.salaryMax,
		salaryCurrency: salary.salaryCurrency,
		salaryInterval: salary.salaryInterval,
		applyUrl,
		raw: {
			source: "openai-careers-html",
			team,
			subtitle,
			applyUrl,
			ashbyJobId: applyUrl ? extractJobIdFromUrl(applyUrl) : null,
		},
	};
}

async function fetchAshbySecondRun(ctx: SecondRunContext, requestedId: string | null): Promise<SecondRunResult> {
	const jobs = await fetchAshbyJobs(ctx, true, null);
	const job = findAshbyJob(jobs, ctx.jobUrl, requestedId);

	if (!job) {
		return {
			status: "removed",
			message: "OpenAI job is no longer available",
			raw: {
				source: "ashby-posting-api",
				jobUrl: ctx.jobUrl,
				jobId: requestedId,
			},
		};
	}

	return ashbyJobToSecondRun(job, ctx.jobUrl, requestedId);
}

export async function firstRun(ctx: ScraperCompanyContext): Promise<FirstRunResult> {
	const limit = maxJobsLimit(ctx);
	if (limit === 0) {
		return {
			jobs: [],
			sortApplied: "openai careers board order",
			raw: {
				source: "openai-careers-html",
				boardUrl: OFFICIAL_BOARD_URL,
				jobCount: 0,
			},
		};
	}

	await ctx.logger.info("Fetching OpenAI careers listing", {
		url: OFFICIAL_BOARD_URL,
		maxJobs: ctx.maxJobs ?? null,
	});

	const listing = await fetchText(OFFICIAL_BOARD_URL);
	const officialJobs = listing.html ? parseOfficialSearchJobs(listing.html, limit) : [];
	if (officialJobs.length > 0) {
		await ctx.logger.info("Fetched OpenAI jobs from official listing", {
			count: officialJobs.length,
			maxJobs: ctx.maxJobs ?? null,
			boardUrl: OFFICIAL_BOARD_URL,
		});

		return {
			jobs: officialJobs,
			sortApplied: "openai careers board order",
			raw: {
				source: "openai-careers-html",
				boardUrl: OFFICIAL_BOARD_URL,
				jobCount: officialJobs.length,
			},
		};
	}

	await ctx.logger.warn("OpenAI official listing unavailable or yielded no parsed jobs; using Ashby fallback", {
		boardUrl: OFFICIAL_BOARD_URL,
		status: listing.status,
		error: listing.error,
	});

	const ashbyJobs = (await fetchAshbyJobs(ctx, false, limit)).map(toFirstRunAshbyJob);
	return {
		jobs: ashbyJobs,
		sortApplied: "ashby board order",
		raw: {
			source: "ashby-posting-api",
			boardName: ASHBY_BOARD_NAME,
			boardUrl: OFFICIAL_BOARD_URL,
			apiUrl: ASHBY_BOARD_API,
			jobCount: ashbyJobs.length,
		},
	};
}

export async function secondRun(ctx: SecondRunContext): Promise<SecondRunResult> {
	const requestedId = extractJobIdFromUrl(ctx.jobUrl);

	await ctx.logger.info("Fetching OpenAI job detail", {
		jobUrl: ctx.jobUrl,
		jobId: requestedId,
	});

	const normalizedOfficialUrl = normalizeOpenAiUrl(ctx.jobUrl);
	if (!normalizedOfficialUrl) {
		return fetchAshbySecondRun(ctx, requestedId);
	}

	const detail = await fetchText(normalizedOfficialUrl);
	if (detail.status === 404 || detail.status === 410 || !detail.html) {
		if (detail.status !== 404 && detail.status !== 410) {
			await ctx.logger.warn("OpenAI official job detail unavailable; using Ashby fallback", {
				jobUrl: ctx.jobUrl,
				status: detail.status,
				error: detail.error,
			});
			return fetchAshbySecondRun(ctx, requestedId);
		}

		return {
			status: "removed",
			message: "OpenAI job is no longer available",
			raw: {
				source: "openai-careers-html",
				jobUrl: ctx.jobUrl,
				status: detail.status,
			},
		};
	}

	const parsed = parseOfficialJob(detail.html, normalizedOfficialUrl);
	if (!parsed) {
		return {
			status: "removed",
			message: "OpenAI job page no longer contains an active posting",
			raw: {
				source: "openai-careers-html",
				jobUrl: ctx.jobUrl,
			},
		};
	}

	const sponsorship = extractSponsorship(parsed.description);
	return {
		status: "ok",
		url: parsed.url,
		title: parsed.title,
		roleName: parsed.title,
		description: parsed.description,
		locations: parsed.locations,
		tags: parsed.tags,
		employmentType: parsed.employmentType,
		workplaceType: parsed.workplaceType,
		postedAt: parsed.postedAt,
		salaryMin: parsed.salaryMin,
		salaryMax: parsed.salaryMax,
		salaryCurrency: parsed.salaryCurrency,
		salaryInterval: parsed.salaryInterval,
		sponsorshipText: sponsorship.sponsorshipText,
		sponsorshipAvailable: sponsorship.sponsorshipAvailable,
		raw: parsed.raw,
	};
}
