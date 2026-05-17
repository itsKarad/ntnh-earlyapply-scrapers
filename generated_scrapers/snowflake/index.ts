import type {
	FirstRunJob,
	FirstRunResult,
	ScraperCompanyContext,
	SecondRunContext,
	SecondRunResult,
} from "@/app/service/scraper-types";

const OFFICIAL_BOARD_URL = "https://careers.snowflake.com/us/en";
const SEARCH_URL = "https://careers.snowflake.com/us/en/search-results";
const REF_NUM = "SNCOUS";
const DEFAULT_PAGE_SIZE = 50;
const MAX_SEARCH_PAGES = 40;
const USER_AGENT = "EarlyApply generated Snowflake scraper";

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type ParsedJob = {
	id: string | null;
	url: string;
	title: string | null;
	description: string | null;
	locations: string[];
	tags: string[];
	employmentType: string | null;
	workplaceType: string | null;
	postedAt: string | null;
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
		.replace(/&gt;/gi, ">");
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
		.replace(/<\s*\/(h1|h2|h3|h4|h5|h6|section|article|div)\s*>/gi, "\n")
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

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readString(object: JsonObject, keys: string[]): string | null {
	for (const key of keys) {
		const value = object[key];
		const text = compactText(typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : null);
		if (text) {
			return decodeHtmlEntities(text);
		}
	}

	return null;
}

function collectObjects(value: JsonValue, output: JsonObject[]): void {
	if (Array.isArray(value)) {
		for (const item of value) {
			collectObjects(item, output);
		}
		return;
	}
	if (!isJsonObject(value)) {
		return;
	}

	output.push(value);
	for (const item of Object.values(value)) {
		collectObjects(item, output);
	}
}

function extractJobId(value: string | null | undefined): string | null {
	const text = compactText(value);
	if (!text) {
		return null;
	}

	try {
		const parsed = new URL(text, OFFICIAL_BOARD_URL);
		const queryId = parsed.searchParams.get("jobSeqNo") ?? parsed.searchParams.get("jobId") ?? parsed.searchParams.get("reqId");
		if (queryId) {
			return queryId;
		}

		const segments = parsed.pathname.split("/").filter(Boolean);
		const jobIndex = segments.findIndex((segment) => segment.toLowerCase() === "job");
		if (jobIndex >= 0 && segments[jobIndex + 1]) {
			return decodeURIComponent(segments[jobIndex + 1]);
		}
	} catch {
		// Fall through to regex extraction.
	}

	return text.match(/\bSNCOUS[A-Z0-9]+EXTERNALENUS\b/i)?.[0] ?? text.match(/\bREQ\d+\b/i)?.[0] ?? null;
}

function slugify(value: string | null): string {
	return (
		(value ?? "job")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "") || "job"
	);
}

function normalizeSnowflakeUrl(rawUrl: string | null, id: string | null, title: string | null): string | null {
	if (rawUrl) {
		try {
			const parsed = new URL(decodeHtmlEntities(rawUrl), OFFICIAL_BOARD_URL);
			if (/^https?:$/i.test(parsed.protocol) && /(^|\.)careers\.snowflake\.com$/i.test(parsed.hostname)) {
				parsed.hash = "";
				return parsed.toString();
			}
		} catch {
			// Build from the id below.
		}
	}

	return id ? `https://careers.snowflake.com/us/en/job/${encodeURIComponent(id)}/${slugify(title)}` : null;
}

function normalizeLocations(...values: unknown[]): string[] {
	const flattened = values.flatMap((value): string[] => {
		if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
			return String(value).split(/\s*(?:;|\||\/\s+|\band\b)\s*/i);
		}
		if (Array.isArray(value)) {
			return value.flatMap((item) => normalizeLocations(item));
		}
		if (isJsonObject(value as JsonValue)) {
			const object = value as JsonObject;
			return [
				readString(object, ["cityStateCountry", "formattedAddress", "location", "name"]),
				[readString(object, ["city"]), readString(object, ["state"]), readString(object, ["country"])]
					.filter(Boolean)
					.join(", "),
			].filter((item): item is string => Boolean(item));
		}
		return [];
	});

	return [
		...new Set(
			flattened
				.map((value) => compactText(decodeHtmlEntities(value)))
				.filter((value): value is string => Boolean(value))
				.filter((value) => !/^n\/?a$/i.test(value)),
		),
	].slice(0, 30);
}

function inferWorkplaceType(locations: string[], description: string | null, explicit: string | null): string | null {
	const text = compactText([explicit, ...locations, description].filter(Boolean).join(" ")) ?? "";
	if (/\bremote\b/i.test(text)) {
		return "Remote";
	}
	if (/\bhybrid\b/i.test(text)) {
		return "Hybrid";
	}
	if (/\bon-?site\b|\bin office\b/i.test(text)) {
		return "On-site";
	}

	return explicit;
}

function inferEmploymentType(text: string | null): string | null {
	if (!text) {
		return null;
	}
	if (/intern/i.test(text)) {
		return "Internship";
	}
	if (/contract/i.test(text)) {
		return "Contract";
	}
	if (/part[-\s]?time/i.test(text)) {
		return "Part-time";
	}
	if (/full[-\s]?time/i.test(text)) {
		return "Full-time";
	}

	return compactText(text);
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

	const match = description.match(/\$([0-9][0-9,]*(?:\.\d+)?)\s*(?:-|to|–)\s*\$?([0-9][0-9,]*(?:\.\d+)?)/i);
	if (!match) {
		return { salaryMin: null, salaryMax: null, salaryCurrency: null, salaryInterval: null };
	}

	const salaryMin = Number(match[1]?.replace(/,/g, ""));
	const salaryMax = Number(match[2]?.replace(/,/g, ""));

	return {
		salaryMin: Number.isFinite(salaryMin) ? salaryMin : null,
		salaryMax: Number.isFinite(salaryMax) ? salaryMax : null,
		salaryCurrency: "USD",
		salaryInterval: /hour|hr/i.test(description.slice(match.index ?? 0, (match.index ?? 0) + 120)) ? "hour" : "year",
	};
}

function extractSponsorship(description: string | null): {
	sponsorshipText: string | null;
	sponsorshipAvailable: boolean | null;
} {
	if (!description) {
		return { sponsorshipText: null, sponsorshipAvailable: null };
	}

	const sentence = description
		.split(/(?<=[.!?])\s+/)
		.find((part) => /\b(visa|sponsor|sponsorship|work authorization)\b/i.test(part));
	const sponsorshipText = compactText(sentence);
	if (!sponsorshipText) {
		return { sponsorshipText: null, sponsorshipAvailable: null };
	}
	if (/\b(no|not|unable|cannot|don't|does not)\b.{0,50}\b(sponsor|sponsorship|visa)\b/i.test(sponsorshipText)) {
		return { sponsorshipText, sponsorshipAvailable: false };
	}
	if (/\b(sponsor|sponsorship|visa)\b/i.test(sponsorshipText)) {
		return { sponsorshipText, sponsorshipAvailable: true };
	}

	return { sponsorshipText, sponsorshipAvailable: null };
}

function descriptionFromObject(object: JsonObject): string | null {
	const direct = readString(object, [
		"description",
		"jobDescription",
		"externalJobDescription",
		"htmlDescription",
		"jobSummary",
		"responsibilities",
		"qualifications",
	]);
	if (direct) {
		return htmlToText(direct) ?? direct;
	}

	const sections = object["sections"] ?? object["jobAdSections"];
	if (!Array.isArray(sections)) {
		return null;
	}

	const text = sections
		.flatMap((section) => {
			if (!isJsonObject(section)) {
				return [];
			}
			return [readString(section, ["title", "heading"]), readString(section, ["text", "content", "description"])];
		})
		.filter((part): part is string => Boolean(part))
		.join("\n\n");

	return htmlToText(text) ?? compactText(text);
}

function parseJobObject(object: JsonObject): ParsedJob | null {
	const title = readString(object, ["title", "jobTitle", "name"]);
	const id =
		readString(object, ["jobSeqNo", "jobId", "reqId", "requisitionId", "requisitionNumber", "refNumber"]) ??
		extractJobId(readString(object, ["jobUrl", "url", "applyUrl"]));
	const rawUrl = readString(object, ["jobUrl", "url", "canonicalUrl", "externalPath"]);
	const url = normalizeSnowflakeUrl(rawUrl, id, title);
	if (!url || (!id && !title)) {
		return null;
	}

	const description = descriptionFromObject(object);
	const locations = normalizeLocations(
		object["locations"],
		object["location"],
		readString(object, ["cityStateCountry", "formattedLocation", "primaryLocation"]),
		{
			city: object["city"],
			state: object["state"],
			country: object["country"],
		},
	);
	const employmentType = inferEmploymentType(
		readString(object, ["employmentType", "jobType", "typeOfEmployment", "workerType"]) ?? title,
	);
	const workplaceType = inferWorkplaceType(
		locations,
		description,
		readString(object, ["workplaceType", "remoteType", "workLocationType"]),
	);
	const tags = [
		readString(object, ["category", "jobCategory", "department", "team", "function", "jobFamily"]),
		readString(object, ["experienceLevel", "careerLevel"]),
		employmentType,
		workplaceType,
	]
		.flatMap((tag) => (tag ? tag.split(/\s*(?:;|\|)\s*/) : []))
		.map((tag) => compactText(tag))
		.filter((tag): tag is string => Boolean(tag));

	return {
		id,
		url,
		title,
		description,
		locations,
		tags: [...new Set(tags)].slice(0, 30),
		employmentType,
		workplaceType,
		postedAt: normalizeDate(readString(object, ["datePosted", "postedDate", "createdDate", "updatedDate"])),
		raw: {
			source: "snowflake-phenom",
			id,
			refNum: REF_NUM,
		},
	};
}

function parseJobsFromJson(value: JsonValue): ParsedJob[] {
	const objects: JsonObject[] = [];
	collectObjects(value, objects);

	const jobsByUrl = new Map<string, ParsedJob>();
	for (const object of objects) {
		const job = parseJobObject(object);
		if (!job) {
			continue;
		}

		if (job.id?.startsWith(REF_NUM) || /\/job\//i.test(job.url)) {
			jobsByUrl.set(job.url, job);
		}
	}

	return [...jobsByUrl.values()];
}

function requestHeaders(): HeadersInit {
	return {
		accept: "application/json, text/plain, */*",
		"content-type": "application/json",
		"user-agent": USER_AGENT,
	};
}

async function postWidget(body: JsonObject): Promise<JsonValue> {
	const response = await fetch("https://careers.snowflake.com/widgets", {
		method: "POST",
		headers: requestHeaders(),
		body: JSON.stringify(body),
	});
	if (response.status === 404 || response.status === 410) {
		throw new Error(`Snowflake widget request returned HTTP ${response.status}`);
	}
	if (!response.ok) {
		throw new Error(`Snowflake widget request failed with HTTP ${response.status}`);
	}

	return (await response.json()) as JsonValue;
}

async function fetchSearchPage(ctx: ScraperCompanyContext, from: number, size: number): Promise<ParsedJob[]> {
	const body: JsonObject = {
		ddoKey: "refineSearch",
		pageName: "search-results",
		refNum: REF_NUM,
		lang: "en_us",
		locale: "en_us",
		country: "us",
		deviceType: "desktop",
		from,
		size,
		jobs: true,
		counts: true,
		sortBy: "",
	};

	await ctx.logger.info("Fetching Snowflake search page", { from, size });
	return parseJobsFromJson(await postWidget(body)).slice(0, size);
}

function parseJobsFromHtml(html: string): ParsedJob[] {
	const jobsByUrl = new Map<string, ParsedJob>();
	const linkPattern = /href=["']([^"']*\/job\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
	let match: RegExpExecArray | null;

	while ((match = linkPattern.exec(html)) !== null) {
		const rawUrl = decodeHtmlEntities(match[1] ?? "");
		const title = htmlToText(match[2] ?? "") ?? extractJobId(rawUrl);
		const id = extractJobId(rawUrl);
		const url = normalizeSnowflakeUrl(rawUrl, id, title);
		if (!url) {
			continue;
		}

		jobsByUrl.set(url, {
			id,
			url,
			title,
			description: null,
			locations: [],
			tags: [],
			employmentType: null,
			workplaceType: null,
			postedAt: null,
			raw: {
				source: "snowflake-html-fallback",
				id,
				refNum: REF_NUM,
			},
		});
	}

	return [...jobsByUrl.values()];
}

async function fetchHtml(url: string): Promise<{ status: "ok"; html: string } | { status: "removed"; message: string }> {
	const response = await fetch(url, {
		headers: {
			accept: "text/html,application/xhtml+xml",
			"user-agent": USER_AGENT,
		},
	});

	if (response.status === 404 || response.status === 410) {
		return { status: "removed", message: `Snowflake posting returned HTTP ${response.status}` };
	}
	if (!response.ok) {
		throw new Error(`Snowflake HTML request failed with HTTP ${response.status}`);
	}

	return { status: "ok", html: await response.text() };
}

async function fetchDetailFromWidget(jobId: string): Promise<ParsedJob | null> {
	const bodies: JsonObject[] = [
		{
			ddoKey: "jobDetail",
			pageName: "job",
			refNum: REF_NUM,
			jobSeqNo: jobId,
			jobId,
			lang: "en_us",
			locale: "en_us",
			country: "us",
			deviceType: "desktop",
		},
		{
			ddoKey: "jobDetail",
			refNum: REF_NUM,
			jobSeqNo: jobId,
			lang: "en_us",
			deviceType: "desktop",
		},
	];

	for (const body of bodies) {
		const jobs = parseJobsFromJson(await postWidget(body));
		const match = jobs.find((job) => job.id === jobId) ?? jobs[0];
		if (match?.title || match?.description) {
			return match;
		}
	}

	return null;
}

function parseJsonLdJobs(html: string): ParsedJob[] {
	const jobs: ParsedJob[] = [];
	const scriptPattern = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
	let match: RegExpExecArray | null;

	while ((match = scriptPattern.exec(html)) !== null) {
		try {
			const parsed = JSON.parse(decodeHtmlEntities(match[1] ?? "")) as JsonValue;
			jobs.push(...parseJobsFromJson(parsed));
		} catch {
			// Ignore malformed structured data.
		}
	}

	return jobs;
}

function parseDetailFromHtml(html: string, url: string): ParsedJob | null {
	if (/this job has been closed|oh snap/i.test(htmlToText(html) ?? "")) {
		return null;
	}

	const structured = parseJsonLdJobs(html)[0];
	if (structured) {
		return structured;
	}

	const title =
		html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
		html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ??
		null;
	const text = htmlToText(html);
	const id = extractJobId(url);

	return {
		id,
		url,
		title: compactText(title?.replace(/\s*\|\s*Snowflake Careers\s*$/i, "")),
		description: text,
		locations: [],
		tags: [],
		employmentType: inferEmploymentType(text),
		workplaceType: inferWorkplaceType([], text, null),
		postedAt: null,
		raw: {
			source: "snowflake-html-fallback",
			id,
			refNum: REF_NUM,
		},
	};
}

function toFirstRunJob(job: ParsedJob): FirstRunJob {
	return {
		url: job.url,
		title: job.title,
		postedAt: job.postedAt,
		location: job.locations.join(", ") || null,
		raw: job.raw,
	};
}

export async function firstRun(ctx: ScraperCompanyContext): Promise<FirstRunResult> {
	const limit = maxJobsLimit(ctx);
	if (limit === 0) {
		await ctx.logger.info("Snowflake maxJobs is 0; skipping discovery", { boardUrl: OFFICIAL_BOARD_URL });
		return {
			jobs: [],
			sortApplied: "maxJobs limit",
			raw: { source: "snowflake-phenom", boardUrl: OFFICIAL_BOARD_URL, jobCount: 0 },
		};
	}

	const jobsByUrl = new Map<string, ParsedJob>();
	const pageSize = Math.min(DEFAULT_PAGE_SIZE, limit ?? DEFAULT_PAGE_SIZE);

	try {
		for (let page = 0; page < MAX_SEARCH_PAGES; page += 1) {
			if (limit !== null && jobsByUrl.size >= limit) {
				break;
			}

			const size = limit === null ? pageSize : Math.min(pageSize, limit - jobsByUrl.size);
			const jobs = await fetchSearchPage(ctx, page * pageSize, size);
			let added = 0;
			for (const job of jobs) {
				if (!jobsByUrl.has(job.url)) {
					jobsByUrl.set(job.url, job);
					added += 1;
				}
				if (limit !== null && jobsByUrl.size >= limit) {
					break;
				}
			}

			if (jobs.length < size || added === 0) {
				break;
			}
		}
	} catch (error) {
		await ctx.logger.warn("Snowflake Phenom search failed; trying HTML fallback", {
			error: error instanceof Error ? error.message : String(error),
		});
		const htmlResult = await fetchHtml(SEARCH_URL);
		if (htmlResult.status === "ok") {
			for (const job of parseJobsFromHtml(htmlResult.html)) {
				jobsByUrl.set(job.url, job);
				if (limit !== null && jobsByUrl.size >= limit) {
					break;
				}
			}
		}
	}

	const jobs = [...jobsByUrl.values()].slice(0, limit ?? undefined).map(toFirstRunJob);
	await ctx.logger.info("Fetched Snowflake jobs", { count: jobs.length, maxJobs: ctx.maxJobs ?? null });

	return {
		jobs,
		sortApplied: "snowflake phenom search order",
		raw: {
			source: "snowflake-phenom",
			boardUrl: OFFICIAL_BOARD_URL,
			searchUrl: SEARCH_URL,
			refNum: REF_NUM,
			jobCount: jobs.length,
		},
	};
}

export async function secondRun(ctx: SecondRunContext): Promise<SecondRunResult> {
	const jobId = extractJobId(ctx.jobUrl);
	if (!jobId) {
		return {
			status: "removed",
			message: "Snowflake job URL no longer contains a recognizable posting id",
			raw: { source: "snowflake-phenom", jobUrl: ctx.jobUrl },
		};
	}

	await ctx.logger.info("Fetching Snowflake job detail", { jobId, jobUrl: ctx.jobUrl });

	let job: ParsedJob | null = null;
	try {
		job = await fetchDetailFromWidget(jobId);
	} catch (error) {
		await ctx.logger.warn("Snowflake Phenom detail failed; trying HTML fallback", {
			jobId,
			error: error instanceof Error ? error.message : String(error),
		});
	}

	if (!job) {
		const htmlResult = await fetchHtml(ctx.jobUrl);
		if (htmlResult.status === "removed") {
			return {
				status: "removed",
				message: htmlResult.message,
				raw: { source: "snowflake-html-fallback", jobId, jobUrl: ctx.jobUrl },
			};
		}

		if (/this job has been closed|oh snap/i.test(htmlToText(htmlResult.html) ?? "")) {
			return {
				status: "removed",
				message: "Snowflake posting is closed",
				raw: { source: "snowflake-html-fallback", jobId, jobUrl: ctx.jobUrl },
			};
		}

		job = parseDetailFromHtml(htmlResult.html, ctx.jobUrl);
	}

	if (!job?.title && !job?.description) {
		return {
			status: "removed",
			message: "Snowflake posting is no longer available",
			raw: { source: "snowflake-phenom", jobId, jobUrl: ctx.jobUrl },
		};
	}

	const description = job.description;
	const salary = parseSalary(description);
	const sponsorship = extractSponsorship(description);
	const title = job.title ?? "Snowflake role";

	return {
		status: "ok",
		url: job.url,
		title,
		roleName: title,
		description,
		locations: job.locations,
		tags: job.tags,
		employmentType: job.employmentType,
		workplaceType: job.workplaceType,
		postedAt: job.postedAt,
		salaryMin: salary.salaryMin,
		salaryMax: salary.salaryMax,
		salaryCurrency: salary.salaryCurrency,
		salaryInterval: salary.salaryInterval,
		sponsorshipText: sponsorship.sponsorshipText,
		sponsorshipAvailable: sponsorship.sponsorshipAvailable,
		raw: {
			...job.raw,
			jobId,
			jobUrl: ctx.jobUrl,
		},
	};
}
