import type {
	FirstRunJob,
	FirstRunResult,
	ScraperCompanyContext,
	SecondRunContext,
	SecondRunResult,
} from "@/app/service/scraper-types";

const OFFICIAL_BOARD_URL = "https://careers.withwaymo.com/jobs/search";
const WAYMO_ORIGIN = "https://careers.withwaymo.com";
const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 15_000;
const FETCH_ATTEMPTS = 3;
const MAX_UNBOUNDED_SEARCH_PAGES = 100;
const SEARCH_PAGE_SIZE = 30;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type FetchTextResult = {
	status: number | null;
	html: string | null;
	error: string | null;
};

type SearchPageJob = {
	url: string;
	title: string | null;
	location: string | null;
	raw: Record<string, unknown>;
};

type ParsedJobPosting = {
	title: string | null;
	description: string | null;
	locations: string[];
	employmentType: string | null;
	workplaceType: string | null;
	salaryMin: number | null;
	salaryMax: number | null;
	salaryCurrency: string | null;
	salaryInterval: string | null;
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
		.replace(/&ndash;/gi, "-")
		.replace(/&mdash;/gi, "-")
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
		.replace(/<\s*\/(h1|h2|h3|h4|h5|h6|section|article|div|header|main|tr)\s*>/gi, "\n")
		.replace(/<\s*\/(td|th)\s*>/gi, " ")
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

function normalizeUrl(value: string | null | undefined, base = WAYMO_ORIGIN): string | null {
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

function normalizeWaymoJobUrl(value: string | null | undefined): string | null {
	const url = normalizeUrl(value);
	if (!url) {
		return null;
	}

	const parsed = new URL(url);
	if (!/(^|\.)careers\.withwaymo\.com$/i.test(parsed.hostname)) {
		return null;
	}
	const isSlugJob = /^\/jobs\/(?!search\/?$).+/i.test(parsed.pathname);
	const isLegacyJob =
		/^\/jobs\/?$/i.test(parsed.pathname) &&
		["gh_jid", "job_id", "jobId", "id"].some((key) => Boolean(parsed.searchParams.get(key)));
	if (!isSlugJob && !isLegacyJob) {
		return null;
	}

	return parsed.toString();
}

function requestHeaders(accept: string): HeadersInit {
	return {
		accept,
		"accept-language": "en-US,en;q=0.9",
		"cache-control": "no-cache",
		pragma: "no-cache",
		referer: `${WAYMO_ORIGIN}/`,
		"sec-fetch-dest": "document",
		"sec-fetch-mode": "navigate",
		"sec-fetch-site": "same-origin",
		"upgrade-insecure-requests": "1",
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

function shouldRetryStatus(status: number): boolean {
	return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function delay(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchText(url: string): Promise<FetchTextResult> {
	let lastResult: FetchTextResult = { status: null, html: null, error: "request was not attempted" };

	for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
		try {
			const response = await fetchWithTimeout(url, "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8");
			if (response.status === 404 || response.status === 410) {
				return { status: response.status, html: null, error: null };
			}
			if (!response.ok) {
				lastResult = { status: response.status, html: null, error: `HTTP ${response.status}` };
				if (attempt < FETCH_ATTEMPTS && shouldRetryStatus(response.status)) {
					await delay(250 * attempt);
					continue;
				}

				return lastResult;
			}

			const html = await response.text();
			if (!html.trim()) {
				lastResult = { status: response.status, html: null, error: "empty response body" };
				if (attempt < FETCH_ATTEMPTS) {
					await delay(250 * attempt);
					continue;
				}

				return lastResult;
			}

			return { status: response.status, html, error: null };
		} catch (error) {
			lastResult = { status: null, html: null, error: errorMessage(error) };
			if (attempt < FETCH_ATTEMPTS) {
				await delay(250 * attempt);
			}
		}
	}

	return lastResult;
}

function extractAttribute(tag: string, name: string): string | null {
	const pattern = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i");
	const match = tag.match(pattern);
	return decodeHtmlEntities(match?.[2] ?? match?.[3] ?? match?.[4] ?? "").trim() || null;
}

function looksLikeGenericLinkText(value: string | null): boolean {
	if (!value) {
		return true;
	}

	return /^(apply|apply now|view job|view details|learn more|read more|job details|details)$/i.test(value);
}

function nearbyLocationText(html: string, anchorStart: number, anchorEnd: number): string | null {
	const nextAnchor = html.slice(anchorEnd).search(/<a\b[^>]*href=["'][^"']*\/jobs\//i);
	const end = nextAnchor >= 0 ? anchorEnd + nextAnchor : Math.min(html.length, anchorEnd + 1_800);
	const cardHtml = html.slice(Math.max(0, anchorStart - 400), end);
	const text = htmlToText(cardHtml);
	if (!text) {
		return null;
	}

	const lines = text
		.split("\n")
		.map((line) => compactText(line))
		.filter((line): line is string => Boolean(line));
	const locationLine = lines.find(
		(line) =>
			/,/.test(line) &&
			!/apply|view|details|read more|full[-\s]?time|part[-\s]?time|contract|intern/i.test(line),
	);

	return locationLine ?? null;
}

function parseSearchJobs(html: string): SearchPageJob[] {
	const jobs = new Map<string, SearchPageJob>();
	const anchorPattern = /<a\b([^>]*)href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))([^>]*)>([\s\S]*?)<\/a>/gi;

	for (const match of html.matchAll(anchorPattern)) {
		const href = match[3] ?? match[4] ?? match[5] ?? "";
		const url = normalizeWaymoJobUrl(href);
		if (!url) {
			continue;
		}

		const tag = `${match[1] ?? ""} ${match[6] ?? ""}`;
		const anchorText = htmlToText(match[7] ?? "");
		const label = compactText(extractAttribute(tag, "aria-label") ?? extractAttribute(tag, "title"));
		const title = looksLikeGenericLinkText(anchorText) ? label : anchorText;
		const existing = jobs.get(url);
		if (existing && (existing.title || !title)) {
			continue;
		}

		const anchorStart = match.index ?? 0;
		const anchorEnd = anchorStart + match[0].length;
		jobs.set(url, {
			url,
			title: compactText(title),
			location: nearbyLocationText(html, anchorStart, anchorEnd),
			raw: {
				source: "waymo-official-html",
				href,
			},
		});
	}

	return [...jobs.values()];
}

function hasNextPage(html: string, page: number): boolean {
	const nextPage = String(page + 1);
	return new RegExp(`(?:page=|/page/)${nextPage}(?:["'&<\\s/]|$)`, "i").test(html) || /\bNext\b/i.test(html);
}

function searchPageUrl(page: number): string {
	if (page <= 1) {
		return OFFICIAL_BOARD_URL;
	}

	const url = new URL(OFFICIAL_BOARD_URL);
	url.searchParams.set("page", String(page));
	return url.toString();
}

async function fetchSearchJobs(ctx: ScraperCompanyContext): Promise<SearchPageJob[]> {
	const limit = maxJobsLimit(ctx);
	if (limit === 0) {
		return [];
	}

	const jobs = new Map<string, SearchPageJob>();
	const maxPages = limit === null ? MAX_UNBOUNDED_SEARCH_PAGES : Math.max(1, Math.ceil(limit / SEARCH_PAGE_SIZE) + 2);

	for (let page = 1; page <= maxPages; page += 1) {
		const url = searchPageUrl(page);
		await ctx.logger.info("Fetching Waymo jobs search page", {
			url,
			page,
			maxJobs: ctx.maxJobs ?? null,
		});

		const result = await fetchText(url);
		if (!result.html) {
			if (page === 1) {
				throw new Error(`Waymo jobs search request failed: ${result.error ?? `HTTP ${result.status ?? "unknown"}`}`);
			}
			await ctx.logger.warn("Stopping Waymo pagination after failed page fetch", {
				page,
				status: result.status,
				error: result.error,
			});
			break;
		}

		const pageJobs = parseSearchJobs(result.html);
		const beforeCount = jobs.size;
		for (const job of pageJobs) {
			if (!jobs.has(job.url)) {
				jobs.set(job.url, job);
				if (limit !== null && jobs.size >= limit) {
					return [...jobs.values()];
				}
			}
		}

		if (pageJobs.length === 0 || (jobs.size === beforeCount && page > 1) || !hasNextPage(result.html, page)) {
			break;
		}
	}

	return [...jobs.values()];
}

function parseJsonValue(scriptText: string): JsonValue | null {
	try {
		return JSON.parse(decodeHtmlEntities(scriptText)) as JsonValue;
	} catch {
		return null;
	}
}

function flattenJsonObjects(value: JsonValue): JsonObject[] {
	if (Array.isArray(value)) {
		return value.flatMap((entry) => flattenJsonObjects(entry));
	}
	if (value && typeof value === "object") {
		const object = value as JsonObject;
		return [object, ...Object.values(object).flatMap((entry) => flattenJsonObjects(entry))];
	}

	return [];
}

function jsonTypeMatches(value: JsonValue | undefined, typeName: string): boolean {
	if (typeof value === "string") {
		return value.toLowerCase() === typeName.toLowerCase();
	}
	if (Array.isArray(value)) {
		return value.some((entry) => jsonTypeMatches(entry, typeName));
	}

	return false;
}

function extractJsonLdJobPosting(html: string): JsonObject | null {
	const scriptPattern = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
	for (const match of html.matchAll(scriptPattern)) {
		const parsed = parseJsonValue(match[1] ?? "");
		if (!parsed) {
			continue;
		}

		const posting = flattenJsonObjects(parsed).find((object) => jsonTypeMatches(object["@type"], "JobPosting"));
		if (posting) {
			return posting;
		}
	}

	return null;
}

function titleFromHtml(html: string): string | null {
	const h1Titles = [...html.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)]
		.map((match) => htmlToText(match[1]))
		.filter((title): title is string => Boolean(title))
		.filter((title) => !/^(working at waymo|teams|jobs|careers)$/i.test(title));
	if (h1Titles.length > 0) {
		return h1Titles.sort((a, b) => b.length - a.length)[0] ?? null;
	}

	const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
	const title = htmlToText(titleMatch?.[1]);
	return title?.replace(/\s*\|\s*Waymo.*$/i, "").replace(/\s*-\s*Waymo.*$/i, "").trim() || null;
}

function stringArrayFromJson(value: JsonValue | undefined): string[] {
	if (Array.isArray(value)) {
		return value
			.flatMap((entry) => stringArrayFromJson(entry))
			.map((entry) => compactText(entry))
			.filter((entry): entry is string => Boolean(entry));
	}
	if (value && typeof value === "object") {
		const object = value as JsonObject;
		const candidates = [
			object.name,
			object.addressLocality,
			object.addressRegion,
			object.addressCountry,
			object.streetAddress,
		]
			.map((entry) => compactText(entry))
			.filter((entry): entry is string => Boolean(entry));
		return candidates.length > 0 ? [candidates.join(", ")] : [];
	}

	const text = compactText(value);
	return text ? [text] : [];
}

function numericJsonValue(value: JsonValue | undefined): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	const text = compactText(value);
	if (!text) {
		return null;
	}

	const parsed = Number(text.replace(/[$,]/g, ""));
	return Number.isFinite(parsed) ? parsed : null;
}

function parseSalaryFromJson(jobPosting: JsonObject | null): {
	salaryMin: number | null;
	salaryMax: number | null;
	salaryCurrency: string | null;
	salaryInterval: string | null;
} {
	const baseSalary = jobPosting?.baseSalary;
	if (!baseSalary || typeof baseSalary !== "object" || Array.isArray(baseSalary)) {
		return { salaryMin: null, salaryMax: null, salaryCurrency: null, salaryInterval: null };
	}

	const salary = baseSalary as JsonObject;
	const value = salary.value;
	const valueObject = value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : null;
	const min = numericJsonValue(valueObject?.minValue ?? salary.minValue);
	const max = numericJsonValue(valueObject?.maxValue ?? salary.maxValue);

	return {
		salaryMin: min,
		salaryMax: max,
		salaryCurrency: compactText(salary.currency ?? valueObject?.currency) ?? null,
		salaryInterval: compactText(valueObject?.unitText ?? salary.unitText) ?? null,
	};
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
			.find((line) => /\$\s?\d[\d,]*(?:\.\d+)?\s*(?:-|\u2013|\u2014|to)\s*\$?\s?\d[\d,]*/i.test(line)) ??
		null;
	const rangeMatch = salaryLine?.match(
		/\$\s?(\d[\d,]*(?:\.\d+)?)\s*(?:-|\u2013|\u2014|to)\s*\$?\s?(\d[\d,]*(?:\.\d+)?)/i,
	);
	const salaryMin = rangeMatch?.[1] ? Number(rangeMatch[1].replace(/,/g, "")) : null;
	const salaryMax = rangeMatch?.[2] ? Number(rangeMatch[2].replace(/,/g, "")) : null;

	return {
		salaryMin: Number.isFinite(salaryMin) ? salaryMin : null,
		salaryMax: Number.isFinite(salaryMax) ? salaryMax : null,
		salaryCurrency: rangeMatch ? "USD" : null,
		salaryInterval: /hour|hourly/i.test(salaryLine ?? "") ? "hour" : rangeMatch ? "year" : null,
	};
}

function likelyDetailStart(lines: string[]): number {
	const waymoIntro = lines.findIndex((line) => /^Waymo is an autonomous/i.test(line));
	if (waymoIntro >= 0) {
		return waymoIntro;
	}

	const addToFavorites = lines.findIndex((line) => /^Add to favorites$/i.test(line));
	if (addToFavorites >= 0 && addToFavorites + 1 < lines.length) {
		return addToFavorites + 1;
	}

	const applyNow = lines.findIndex((line) => /^Apply now$/i.test(line));
	return applyNow >= 0 && applyNow + 1 < lines.length ? applyNow + 1 : 0;
}

function likelyDetailEnd(lines: string[], start: number): number {
	const end = lines.findIndex(
		(line, index) =>
			index > start &&
			/^(Related Job Openings|Quick Links|Some of our Benefits|Benefits|Equal Opportunity|Ready to Apply\?|Cookie|Privacy Policy)$/i.test(
				line,
			),
	);

	return end >= 0 ? end : lines.length;
}

function descriptionFromHtml(html: string): string | null {
	const text = htmlToText(html);
	if (!text) {
		return null;
	}

	const lines = text
		.split("\n")
		.map((line) => compactText(line))
		.filter((line): line is string => Boolean(line));
	const start = likelyDetailStart(lines);
	const end = likelyDetailEnd(lines, start);
	const description = lines.slice(start, end).join("\n").replace(/\n{3,}/g, "\n\n").trim();

	return description || text;
}

function locationPartsFromLine(line: string): string[] {
	const withoutJobMetadata = line
		.replace(
			/\b(?:Full[-\s]?Time|Part[-\s]?Time|Contract|Internship|Temporary|On Site|On-site|Remote|Hybrid)\b.*$/i,
			"",
		)
		.trim();
	const parts = withoutJobMetadata
		.split(/\s*(?:;|\||\/|\.\s+(?=[A-Z])|,?\s+and\s+)\s*/i)
		.map((part) => compactText(part))
		.filter((part): part is string => Boolean(part))
		.filter((part) => !/^\d{3,}$/.test(part));

	return parts.length > 0 ? parts : [line];
}

function looksLikeLocation(value: string): boolean {
	return /(?:^|\b)(United States|India|Japan|Poland|Taiwan|United Kingdom|Remote|California|Arizona|New York|Washington|District of Columbia|Georgia|Illinois|Karnataka|Masovian|Mazowieckie|Michigan|Pennsylvania|Taipei|Telangana|Tokyo|England|Mountain View|San Francisco|Los Angeles|Tempe|London|Warsaw|New York City|Pittsburgh|Hsinchu|Hyderabad|Bengaluru|Chicago|Atlanta|Novi)\b/i.test(
		value,
	);
}

function parseLocationsFromLines(lines: string[]): string[] {
	const headerLines = lines.slice(0, Math.min(lines.length, 80));
	const values: string[] = [];

	for (const line of headerLines) {
		if (/^(Apply now|Add to favorites|Share|View|Search|Jobs|Careers)$/i.test(line)) {
			continue;
		}
		if (/^(Full[-\s]?Time|Part[-\s]?Time|Contract|Internship|Temporary|On Site|On-site|Remote|Hybrid|Mid Career|Early Career)$/i.test(line)) {
			continue;
		}
		if (/^\d{3,}$/.test(line)) {
			continue;
		}
		for (const part of locationPartsFromLine(line)) {
			if (looksLikeLocation(part)) {
				values.push(part);
			}
		}
	}

	return [...new Set(values)].slice(0, 10);
}

function inferEmploymentType(lines: string[], description: string | null, jsonEmploymentType: string | null): string | null {
	if (jsonEmploymentType) {
		return jsonEmploymentType;
	}

	const text = `${lines.slice(0, 80).join("\n")}\n${description ?? ""}`;
	if (/\bfull[-\s]?time\b/i.test(text)) {
		return "Full-time";
	}
	if (/\bpart[-\s]?time\b/i.test(text)) {
		return "Part-time";
	}
	if (/\bintern(ship)?\b/i.test(text)) {
		return "Internship";
	}
	if (/\bcontract(or)?\b/i.test(text)) {
		return "Contract";
	}
	if (/\btemporary\b/i.test(text)) {
		return "Temporary";
	}

	return null;
}

function inferWorkplaceType(lines: string[], locations: string[], description: string | null): string | null {
	const text = `${lines.slice(0, 80).join("\n")}\n${locations.join("\n")}\n${description ?? ""}`;
	if (/\bremote\b/i.test(text)) {
		return "Remote";
	}
	if (/\bhybrid\b/i.test(text)) {
		return "Hybrid";
	}
	if (/\bon[-\s]?site\b/i.test(text)) {
		return "On-site";
	}
	if (locations.length > 0) {
		return "On-site";
	}

	return null;
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

function buildTags(lines: string[], locations: string[], employmentType: string | null, workplaceType: string | null): string[] {
	const header = lines.slice(0, Math.min(lines.length, 80));
	const tagCandidates = [
		employmentType ? `employment:${employmentType}` : null,
		workplaceType ? `workplace:${workplaceType}` : null,
		...locations.map((location) => `location:${location}`),
		...header.filter((line) =>
			/^(Engineering|Operations|Product|Program Management|Finance|Legal|Marketing|Sales|People|Recruiting|Policy|Strategy|Mid Career|Early Career)$/i.test(
				line,
			),
		),
	]
		.map((value) => compactText(value))
		.filter((value): value is string => Boolean(value));

	return [...new Set(tagCandidates)].slice(0, 50);
}

function parseJobPosting(html: string): ParsedJobPosting {
	const jsonPosting = extractJsonLdJobPosting(html);
	const jsonSalary = parseSalaryFromJson(jsonPosting);
	const jsonDescription = htmlToText(compactText(jsonPosting?.description));
	const description = jsonDescription ?? descriptionFromHtml(html);
	const fullText = htmlToText(html) ?? "";
	const lines = fullText
		.split("\n")
		.map((line) => compactText(line))
		.filter((line): line is string => Boolean(line));
	const jsonLocations = stringArrayFromJson(jsonPosting?.jobLocation);
	const locations = [...new Set([...jsonLocations, ...parseLocationsFromLines(lines)])].slice(0, 10);
	const jsonEmploymentType = compactText(jsonPosting?.employmentType);
	const textSalary = parseSalary(description);

	return {
		title: compactText(jsonPosting?.title) ?? titleFromHtml(html),
		description,
		locations,
		employmentType: inferEmploymentType(lines, description, jsonEmploymentType),
		workplaceType: inferWorkplaceType(lines, locations, description),
		salaryMin: jsonSalary.salaryMin ?? textSalary.salaryMin,
		salaryMax: jsonSalary.salaryMax ?? textSalary.salaryMax,
		salaryCurrency: jsonSalary.salaryCurrency ?? textSalary.salaryCurrency,
		salaryInterval: jsonSalary.salaryInterval ?? textSalary.salaryInterval,
	};
}

function isRemovedPage(status: number | null, html: string | null): boolean {
	if (status === 404 || status === 410) {
		return true;
	}
	const text = htmlToText(html);
	if (!text) {
		return false;
	}

	return /job (?:is )?no longer available|position has been filled|posting has expired|page not found|404/i.test(text);
}

function toFirstRunJob(job: SearchPageJob): FirstRunJob {
	return {
		url: job.url,
		title: job.title,
		location: job.location,
		raw: job.raw,
	};
}

export async function firstRun(ctx: ScraperCompanyContext): Promise<FirstRunResult> {
	const jobs = await fetchSearchJobs(ctx);
	const mappedJobs = jobs.map(toFirstRunJob);

	await ctx.logger.info("Fetched Waymo jobs", {
		count: mappedJobs.length,
		maxJobs: ctx.maxJobs ?? null,
		boardUrl: OFFICIAL_BOARD_URL,
	});

	return {
		jobs: mappedJobs,
		sortApplied: "official Waymo careers search order",
		raw: {
			source: "waymo-official-html",
			boardUrl: OFFICIAL_BOARD_URL,
			jobCount: mappedJobs.length,
		},
	};
}

export async function secondRun(ctx: SecondRunContext): Promise<SecondRunResult> {
	const jobUrl = normalizeWaymoJobUrl(ctx.jobUrl);
	if (!jobUrl) {
		return {
			status: "removed",
			message: "Waymo job URL is not an active official Waymo job posting URL",
			raw: {
				jobUrl: ctx.jobUrl,
				source: "waymo-official-html",
			},
		};
	}

	await ctx.logger.info("Fetching Waymo job detail", {
		jobUrl,
	});

	const result = await fetchText(jobUrl);
	if (isRemovedPage(result.status, result.html)) {
		return {
			status: "removed",
			message: `Waymo job posting is no longer available (${result.status ?? "unknown status"})`,
			raw: {
				jobUrl,
				source: "waymo-official-html",
				status: result.status,
			},
		};
	}
	if (!result.html) {
		throw new Error(`Waymo job detail request failed: ${result.error ?? `HTTP ${result.status ?? "unknown"}`}`);
	}

	const parsed = parseJobPosting(result.html);
	const title = parsed.title ?? "Waymo role";
	const sponsorship = extractSponsorship(parsed.description);
	const lines =
		htmlToText(result.html)
			?.split("\n")
			.map((line) => compactText(line))
			.filter((line): line is string => Boolean(line)) ?? [];

	return {
		status: "ok",
		url: jobUrl,
		title,
		roleName: title,
		description: parsed.description,
		locations: parsed.locations,
		tags: buildTags(lines, parsed.locations, parsed.employmentType, parsed.workplaceType),
		employmentType: parsed.employmentType,
		workplaceType: parsed.workplaceType,
		salaryMin: parsed.salaryMin,
		salaryMax: parsed.salaryMax,
		salaryCurrency: parsed.salaryCurrency,
		salaryInterval: parsed.salaryInterval,
		sponsorshipText: sponsorship.sponsorshipText,
		sponsorshipAvailable: sponsorship.sponsorshipAvailable,
		raw: {
			source: "waymo-official-html",
			jobUrl,
		},
	};
}
