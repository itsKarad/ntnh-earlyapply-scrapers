import type {
	FirstRunJob,
	FirstRunResult,
	ScraperCompanyContext,
	SecondRunContext,
	SecondRunResult,
} from "@/app/service/scraper-types";

const OFFICIAL_BOARD_URL = "https://www.amazon.jobs/en/";
const AMAZON_ORIGIN = "https://www.amazon.jobs";
const SEARCH_API_URL = "https://www.amazon.jobs/en/search.json";
const DEFAULT_FIRST_RUN_LIMIT = 50;
const DEFAULT_PAGE_SIZE = 50;
const REQUEST_TIMEOUT_MS = 15_000;
const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 EarlyApply";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type AmazonSearchJob = {
	id?: string | number | null;
	job_id?: string | number | null;
	title?: string | null;
	job_path?: string | null;
	location?: string | null;
	normalized_location?: string | null;
	normalized_city_name?: string | null;
	normalized_state_name?: string | null;
	normalized_country_code?: string | null;
	city?: string | null;
	state?: string | null;
	country?: string | null;
	company_name?: string | null;
	business_category?: string | null;
	category?: string | null;
	team?: string | null;
	schedule_type_id?: string | null;
	employee_class?: string | null;
	posted_date?: string | null;
	updated_time?: string | null;
};

type AmazonSearchResponse = {
	jobs?: AmazonSearchJob[] | null;
	hits?: number | null;
};

type FetchDetailResult =
	| {
			status: "ok";
			url: string;
			html: string;
	  }
	| {
			status: "removed";
			message: string;
	  };

function maxJobsLimit(ctx: ScraperCompanyContext): number | null {
	if (ctx.maxJobs === undefined) {
		return DEFAULT_FIRST_RUN_LIMIT;
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

function normalizeDate(value: unknown): string | null {
	const text = compactText(value);
	if (!text) {
		return null;
	}

	const timestamp = Date.parse(text);
	return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function requestHeaders(accept: string, referer = OFFICIAL_BOARD_URL): HeadersInit {
	return {
		accept,
		"accept-language": "en-US,en;q=0.9",
		"cache-control": "no-cache",
		pragma: "no-cache",
		referer,
		"user-agent": USER_AGENT,
	};
}

async function fetchWithTimeout(url: string | URL, accept: string, referer?: string): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		return await fetch(url, {
			headers: requestHeaders(accept, referer),
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timeout);
	}
}

function normalizeUrl(value: string | null | undefined, base = OFFICIAL_BOARD_URL): string | null {
	const text = compactText(value);
	if (!text) {
		return null;
	}

	try {
		const parsed = new URL(decodeHtmlEntities(text), base);
		if (!/^https?:$/i.test(parsed.protocol) || !/(^|\.)amazon\.jobs$/i.test(parsed.hostname)) {
			return null;
		}
		parsed.hash = "";
		return parsed.toString();
	} catch {
		return null;
	}
}

function canonicalJobUrl(job: AmazonSearchJob): string | null {
	const pathUrl = normalizeUrl(job.job_path, AMAZON_ORIGIN);
	if (pathUrl) {
		return pathUrl;
	}

	const id = compactText(job.id) ?? compactText(job.job_id);
	if (id) {
		return `${AMAZON_ORIGIN}/en/jobs/${encodeURIComponent(id)}`;
	}

	return null;
}

function extractJobId(jobUrl: string): string | null {
	try {
		const parsed = new URL(jobUrl, OFFICIAL_BOARD_URL);
		const queryId = parsed.searchParams.get("job_id") ?? parsed.searchParams.get("jobId");
		if (queryId && /^\d+$/.test(queryId)) {
			return queryId;
		}

		const segments = parsed.pathname.split("/").filter(Boolean);
		const jobsIndex = segments.findIndex((segment) => segment.toLowerCase() === "jobs");
		const pathId = jobsIndex >= 0 ? segments[jobsIndex + 1] : null;
		const match = pathId?.match(/\d+/);
		return match?.[0] ?? null;
	} catch {
		return null;
	}
}

function normalizeLocations(...values: unknown[]): string[] {
	const flattened = values.flatMap((value): string[] => {
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			return String(value).split(/\s*(?:;|\||\/\s+|\band\b)\s*/i);
		}
		if (Array.isArray(value)) {
			return value.flatMap((item) => normalizeLocations(item));
		}
		if (value && typeof value === "object") {
			const object = value as JsonObject;
			return [
				compactText(object.normalized_location),
				compactText(object.location),
				[object.normalized_country_code, object.normalized_state_name, object.normalized_city_name]
					.map((part) => compactText(part))
					.filter(Boolean)
					.reverse()
					.join(", "),
				[object.city, object.state, object.country].map((part) => compactText(part)).filter(Boolean).join(", "),
			].filter((item): item is string => Boolean(item));
		}
		return [];
	});

	return [
		...new Set(
			flattened
				.map((value) => compactText(decodeHtmlEntities(value)))
				.filter((value): value is string => Boolean(value))
				.filter((value) => !/^job details$/i.test(value))
				.filter((value) => !/^share this job$/i.test(value)),
		),
	].slice(0, 40);
}

function buildSearchUrl(offset: number, limit: number): URL {
	const url = new URL(SEARCH_API_URL);
	url.searchParams.set("base_query", "");
	url.searchParams.set("city", "");
	url.searchParams.set("country", "");
	url.searchParams.set("county", "");
	url.searchParams.set("distanceType", "Mi");
	url.searchParams.set("latitude", "");
	url.searchParams.set("loc_group_id", "");
	url.searchParams.set("loc_query", "");
	url.searchParams.set("longitude", "");
	url.searchParams.set("offset", String(offset));
	url.searchParams.set("query_options", "");
	url.searchParams.set("radius", "24km");
	url.searchParams.set("region", "");
	url.searchParams.set("result_limit", String(limit));
	url.searchParams.set("sort", "recent");
	for (const facet of [
		"location",
		"business_category",
		"category",
		"schedule_type_id",
		"employee_class",
		"normalized_location",
		"job_function_id",
	]) {
		url.searchParams.append("facets[]", facet);
	}
	return url;
}

async function fetchSearchPage(
	ctx: ScraperCompanyContext,
	offset: number,
	limit: number,
): Promise<AmazonSearchResponse> {
	const url = buildSearchUrl(offset, limit);

	await ctx.logger.info("Fetching Amazon jobs page", {
		url: url.toString(),
		offset,
		limit,
		maxJobs: ctx.maxJobs ?? null,
	});

	const response = await fetchWithTimeout(url, "application/json, text/javascript, */*; q=0.01", `${AMAZON_ORIGIN}/en/search`);
	if (!response.ok) {
		throw new Error(`Amazon jobs request failed with HTTP ${response.status}`);
	}

	return (await response.json()) as AmazonSearchResponse;
}

async function fetchAmazonJobs(ctx: ScraperCompanyContext): Promise<AmazonSearchJob[]> {
	const maxJobs = maxJobsLimit(ctx);
	if (maxJobs === 0) {
		return [];
	}

	const jobs: AmazonSearchJob[] = [];
	let offset = 0;
	let total: number | null = null;

	while (maxJobs === null || jobs.length < maxJobs) {
		const pageLimit = Math.min(DEFAULT_PAGE_SIZE, maxJobs === null ? DEFAULT_PAGE_SIZE : maxJobs - jobs.length);
		const page = await fetchSearchPage(ctx, offset, pageLimit);
		const pageJobs = Array.isArray(page.jobs) ? page.jobs : [];
		total = typeof page.hits === "number" && Number.isFinite(page.hits) ? page.hits : total;

		if (!pageJobs.length) {
			break;
		}

		jobs.push(...pageJobs.slice(0, maxJobs === null ? undefined : maxJobs - jobs.length));
		offset += pageJobs.length;

		if ((total === null && pageJobs.length < pageLimit) || (total !== null && offset >= total)) {
			break;
		}
	}

	return jobs;
}

function firstRunLocation(job: AmazonSearchJob): string | null {
	return normalizeLocations(job.normalized_location, job.location, job).join(", ") || null;
}

function toFirstRunJob(job: AmazonSearchJob): FirstRunJob | null {
	const url = canonicalJobUrl(job);
	if (!url) {
		return null;
	}

	return {
		url,
		title: compactText(job.title) ?? compactText(job.id) ?? compactText(job.job_id),
		postedAt: normalizeDate(job.posted_date ?? job.updated_time),
		location: firstRunLocation(job),
		raw: {
			source: "amazon-search-json",
			id: job.id ?? job.job_id ?? extractJobId(url),
			companyName: job.company_name ?? null,
			businessCategory: job.business_category ?? null,
			category: job.category ?? null,
			scheduleType: job.schedule_type_id ?? null,
			employeeClass: job.employee_class ?? null,
			jobPath: job.job_path ?? null,
		},
	};
}

async function fetchJobDetail(jobUrl: string): Promise<FetchDetailResult> {
	const normalizedUrl = normalizeUrl(jobUrl);
	const jobId = extractJobId(jobUrl);
	const url = normalizedUrl ?? (jobId ? `${AMAZON_ORIGIN}/en/jobs/${encodeURIComponent(jobId)}` : null);
	if (!url) {
		return {
			status: "removed",
			message: "Amazon job URL is not a valid amazon.jobs posting",
		};
	}

	const response = await fetchWithTimeout(url, "text/html,application/xhtml+xml", `${AMAZON_ORIGIN}/en/search`);
	if (response.status === 404 || response.status === 410) {
		return { status: "removed", message: `Amazon job returned HTTP ${response.status}` };
	}
	if (!response.ok) {
		if (response.status >= 400 && response.status < 500) {
			return { status: "removed", message: `Amazon job returned HTTP ${response.status}` };
		}
		throw new Error(`Amazon job detail request failed with HTTP ${response.status}`);
	}

	const html = await response.text();
	if (!extractTitle(html) || (jobId && !html.includes(jobId))) {
		return { status: "removed", message: "Amazon job is no longer available" };
	}

	return { status: "ok", url, html };
}

function textBetween(html: string, startPattern: RegExp, endPattern: RegExp): string | null {
	const startMatch = startPattern.exec(html);
	if (!startMatch) {
		return null;
	}

	const startIndex = startMatch.index + startMatch[0].length;
	const rest = html.slice(startIndex);
	const endMatch = endPattern.exec(rest);
	const section = endMatch ? rest.slice(0, endMatch.index) : rest;
	return section.trim() || null;
}

function extractTitle(html: string): string | null {
	const heading = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
	const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
	const text = htmlToText(heading) ?? htmlToText(title);
	return text?.replace(/\s*-\s*Job ID:\s*\d+.*$/i, "").trim() || null;
}

function extractJobIdFromHtml(html: string, fallbackUrl: string): string | null {
	const detailText = htmlToText(textBetween(html, />\s*Job ID:\s*/i, /<h2[^>]*>|<section[^>]*>|<div[^>]*class=["'][^"']*job-detail/i) ?? "");
	const textId = detailText?.match(/\b(\d{5,})\b/)?.[1] ?? null;
	return textId ?? extractJobId(fallbackUrl);
}

function extractCompanyName(html: string): string | null {
	const text = htmlToText(textBetween(html, />\s*Job ID:\s*/i, /<a\b[^>]*>\s*Apply now\s*<\/a>|<h2[^>]*>/i) ?? "");
	const pipeParts = text?.split("|").map((part) => compactText(part));
	return pipeParts?.[1] ?? null;
}

function extractDescription(html: string): string | null {
	const descriptionHtml =
		textBetween(
			html,
			/<h2[^>]*>\s*(?:Description|DESCRIPTION)\s*<\/h2>/i,
			/<h2[^>]*>\s*(?:Job details|Share this job)\s*<\/h2>|<div[^>]*class=["'][^"']*job-detail/i,
		) ??
		textBetween(
			html,
			/<h2[^>]*>\s*(?:Description|DESCRIPTION)\s*<\/h2>/i,
			/<footer\b|<div[^>]*class=["'][^"']*footer/i,
		);

	return htmlToText(descriptionHtml);
}

function extractJobDetailsText(html: string): string | null {
	return htmlToText(
		textBetween(
			html,
			/<h2[^>]*>\s*Job details\s*<\/h2>/i,
			/<h2[^>]*>\s*Share this job\s*<\/h2>|<footer\b|<div[^>]*class=["'][^"']*footer/i,
		),
	);
}

function extractLocationsFromDetails(detailsText: string | null): string[] {
	if (!detailsText) {
		return [];
	}

	const lines = detailsText
		.split("\n")
		.map((line) => compactText(line))
		.filter((line): line is string => Boolean(line));
	const locationLines = lines.filter((line) => /(?:^[A-Z]{2,3},\s)|(?:,\s[A-Z]{2},\s)|(?:United States|Canada|Germany|India|United Kingdom|Japan|Australia|France|Spain|Ireland|Singapore)/i.test(line));
	return normalizeLocations(locationLines);
}

function extractCategoryFromDetails(detailsText: string | null): string | null {
	if (!detailsText) {
		return null;
	}

	const lines = detailsText
		.split("\n")
		.map((line) => compactText(line))
		.filter((line): line is string => Boolean(line));
	return lines.find((line) => !extractLocationsFromDetails(line).includes(line) && !/^job details$/i.test(line)) ?? null;
}

function normalizeEmploymentType(description: string | null, detailsText: string | null): string | null {
	const text = `${detailsText ?? ""}\n${description ?? ""}`.toLowerCase();
	if (/\bintern(ship)?\b/.test(text)) {
		return "Internship";
	}
	if (/\bpart[-\s]?time\b/.test(text)) {
		return "Part-time";
	}
	if (/\bcontract(or)?\b/.test(text)) {
		return "Contract";
	}
	if (/\bfull[-\s]?time\b/.test(text)) {
		return "Full-time";
	}

	return null;
}

function inferWorkplaceType(locations: string[], description: string | null): string | null {
	const text = `${locations.join(" ")}\n${description ?? ""}`.toLowerCase();
	if (/\bremote\b|virtual location/i.test(text)) {
		return "Remote";
	}
	if (/\bhybrid\b/.test(text)) {
		return "Hybrid";
	}
	if (locations.length > 0) {
		return "On-site";
	}

	return null;
}

function buildTags(category: string | null, locations: string[], workplaceType: string | null, employmentType: string | null): string[] {
	const values = [
		category,
		employmentType,
		workplaceType ? `workplace:${workplaceType}` : null,
		...locations.map((location) => `location:${location}`),
	]
		.filter((value): value is string => Boolean(value))
		.map((value) => value.trim())
		.filter(Boolean);

	return [...new Set(values)].slice(0, 50);
}

function parseSalary(description: string | null): {
	salaryMin: number | null;
	salaryMax: number | null;
	salaryCurrency: string | null;
	salaryInterval: string | null;
} {
	if (!description) {
		return { salaryMin: null, salaryMax: null, salaryCurrency: null, salaryInterval: null };
	}

	const salaryLine =
		description
			.split("\n")
			.find((line) =>
				/(?:\$|USD\b|US\$)\s?\d[\d,]*(?:\.\d+)?\s*\/?\s*(?:year|yr|hour|hr)?\s*(?:-|to|–|—)\s*(?:\$|USD\b|US\$)?\s?\d[\d,]*(?:\.\d+)?/i.test(
					line,
				),
			) ?? null;
	const rangeMatch = salaryLine?.match(
		/(?:\$|USD\b|US\$)?\s?(\d[\d,]*(?:\.\d+)?)\s*\/?\s*(?:year|yr|hour|hr)?\s*(?:-|to|–|—)\s*(?:\$|USD\b|US\$)?\s?(\d[\d,]*(?:\.\d+)?)/i,
	);

	const salaryMin = rangeMatch?.[1] ? Number(rangeMatch[1].replace(/,/g, "")) : null;
	const salaryMax = rangeMatch?.[2] ? Number(rangeMatch[2].replace(/,/g, "")) : null;

	return {
		salaryMin: Number.isFinite(salaryMin) ? salaryMin : null,
		salaryMax: Number.isFinite(salaryMax) ? salaryMax : null,
		salaryCurrency: rangeMatch ? "USD" : null,
		salaryInterval: /hour|hourly|\/hr/i.test(salaryLine ?? "") ? "hour" : rangeMatch ? "year" : null,
	};
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
	if (/without sponsorship|cannot sponsor|no visa sponsorship|do not sponsor|unable to sponsor|will not sponsor/i.test(sponsorshipText)) {
		return { sponsorshipText, sponsorshipAvailable: false };
	}
	if (/sponsor|sponsorship|visa/i.test(sponsorshipText)) {
		return { sponsorshipText, sponsorshipAvailable: true };
	}

	return { sponsorshipText, sponsorshipAvailable: null };
}

export async function firstRun(ctx: ScraperCompanyContext): Promise<FirstRunResult> {
	const jobs = (await fetchAmazonJobs(ctx)).map(toFirstRunJob).filter((job): job is FirstRunJob => Boolean(job));

	await ctx.logger.info("Fetched Amazon jobs", {
		count: jobs.length,
		maxJobs: ctx.maxJobs ?? null,
		boardUrl: OFFICIAL_BOARD_URL,
	});

	return {
		jobs,
		sortApplied: "amazon recent search order",
		raw: {
			source: "amazon-search-json",
			boardUrl: OFFICIAL_BOARD_URL,
			apiUrl: SEARCH_API_URL,
			jobCount: jobs.length,
		},
	};
}

export async function secondRun(ctx: SecondRunContext): Promise<SecondRunResult> {
	const jobId = extractJobId(ctx.jobUrl);

	await ctx.logger.info("Fetching Amazon job detail", {
		jobId,
		jobUrl: ctx.jobUrl,
	});

	const result = await fetchJobDetail(ctx.jobUrl);
	if (result.status === "removed") {
		return {
			status: "removed",
			message: result.message,
			raw: {
				source: "amazon-job-page",
				jobId,
				jobUrl: ctx.jobUrl,
			},
		};
	}

	const description = extractDescription(result.html);
	const detailsText = extractJobDetailsText(result.html);
	const locations = extractLocationsFromDetails(detailsText);
	const category = extractCategoryFromDetails(detailsText);
	const employmentType = normalizeEmploymentType(description, detailsText);
	const workplaceType = inferWorkplaceType(locations, description);
	const salary = parseSalary(description);
	const sponsorship = extractSponsorship(description);
	const title = extractTitle(result.html) ?? "Amazon role";

	return {
		status: "ok",
		url: result.url,
		title,
		roleName: title,
		description,
		locations,
		tags: buildTags(category, locations, workplaceType, employmentType),
		employmentType,
		workplaceType,
		salaryMin: salary.salaryMin,
		salaryMax: salary.salaryMax,
		salaryCurrency: salary.salaryCurrency,
		salaryInterval: salary.salaryInterval,
		sponsorshipText: sponsorship.sponsorshipText,
		sponsorshipAvailable: sponsorship.sponsorshipAvailable,
		raw: {
			source: "amazon-job-page",
			id: extractJobIdFromHtml(result.html, result.url) ?? jobId,
			jobUrl: ctx.jobUrl,
			companyName: extractCompanyName(result.html),
			category,
			detailsText,
		},
	};
}
