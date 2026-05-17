import type {
	FirstRunJob,
	FirstRunResult,
	ScraperCompanyContext,
	SecondRunContext,
	SecondRunResult,
} from "@/app/service/scraper-types";

const ASHBY_BOARD_NAME = "notion";
const OFFICIAL_BOARD_URL = "https://jobs.ashbyhq.com/notion";
const ASHBY_BOARD_API = `https://api.ashbyhq.com/posting-api/job-board/${ASHBY_BOARD_NAME}`;
const USER_AGENT = "EarlyApply generated Notion scraper";
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_FIRST_RUN_LIMIT = 100;

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
	apiVersion?: string;
	jobs?: AshbyJob[];
};

type FetchAshbyJobsOptions = {
	includeCompensation: boolean;
	limit?: number | null;
	matches?: (job: AshbyJob) => boolean;
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

function normalizeDate(value: string | null | undefined): string | null {
	if (!value) {
		return null;
	}

	const timestamp = Date.parse(value);
	return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function normalizeEmploymentType(value: AshbyJob["employmentType"]): string | null {
	switch (value) {
		case "FullTime":
			return "Full-time";
		case "PartTime":
			return "Part-time";
		case "Intern":
			return "Internship";
		case "Contract":
			return "Contract";
		case "Temporary":
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

function locationFromAddress(address: AshbyAddress["postalAddress"] | AshbySecondaryLocation["address"]): string | null {
	if (!address) {
		return null;
	}

	return [address.addressLocality, address.addressRegion, address.addressCountry]
		.map((part) => compactText(part))
		.filter((part): part is string => Boolean(part))
		.join(", ") || null;
}

function normalizeLocations(job: AshbyJob): string[] {
	const values = [
		compactText(job.location),
		locationFromAddress(job.address?.postalAddress ?? null),
		...(job.secondaryLocations ?? []).flatMap((secondaryLocation) => [
			compactText(secondaryLocation.location),
			locationFromAddress(secondaryLocation.address ?? null),
		]),
	]
		.filter((value): value is string => Boolean(value))
		.flatMap((value) => value.split(/\s*(?:;|\|)\s*/))
		.map((value) => compactText(value))
		.filter((value): value is string => Boolean(value));

	return [...new Set(values)];
}

function canonicalJobUrl(job: AshbyJob): string {
	const jobUrl = compactText(job.jobUrl);
	if (jobUrl) {
		return jobUrl;
	}

	const id = compactText(job.id);
	if (id) {
		return `https://jobs.ashbyhq.com/${ASHBY_BOARD_NAME}/${encodeURIComponent(id)}`;
	}

	return OFFICIAL_BOARD_URL;
}

function extractAshbyJobId(jobUrl: string): string | null {
	try {
		const parsed = new URL(jobUrl);
		const pathParts = parsed.pathname.split("/").filter(Boolean);
		if (parsed.hostname === "jobs.ashbyhq.com" && pathParts[0]?.toLowerCase() === ASHBY_BOARD_NAME) {
			return pathParts[1] ? decodeURIComponent(pathParts[1]) : null;
		}

		return (
			parsed.searchParams.get("ashby_jid") ??
			parsed.searchParams.get("jobId") ??
			parsed.searchParams.get("job_id")
		);
	} catch {
		return null;
	}
}

function apiHeaders(): HeadersInit {
	return {
		accept: "application/json",
		"user-agent": USER_AGENT,
	};
}

async function fetchWithTimeout(url: URL): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		return await fetch(url, {
			headers: apiHeaders(),
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timeout);
	}
}

async function parseAshbyJobsFromJson(response: Response, options: FetchAshbyJobsOptions): Promise<AshbyJob[]> {
	const data = (await response.json()) as AshbyJobsResponse;
	const jobs = Array.isArray(data.jobs) ? data.jobs : [];
	const listedJobs = jobs.filter((job) => job.isListed !== false);
	const matchedJobs = options.matches ? listedJobs.filter(options.matches) : listedJobs;
	return options.limit === null || options.limit === undefined ? matchedJobs : matchedJobs.slice(0, options.limit);
}

async function parseAshbyJobsStream(response: Response, options: FetchAshbyJobsOptions): Promise<AshbyJob[]> {
	if (!response.body) {
		return parseAshbyJobsFromJson(response, options);
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	const jobs: AshbyJob[] = [];
	const limit = options.limit ?? null;
	let mode: "seekJobsKey" | "seekJobsArray" | "readJobs" = "seekJobsKey";
	let buffer = "";
	let currentObject = "";
	let depth = 0;
	let inString = false;
	let escaped = false;

	const maybeAddJob = async (rawJob: string): Promise<boolean> => {
		const job = JSON.parse(rawJob) as AshbyJob;
		if (job.isListed === false) {
			return false;
		}
		if (options.matches && !options.matches(job)) {
			return false;
		}

		jobs.push(job);
		if ((limit !== null && jobs.length >= limit) || options.matches) {
			await reader.cancel();
			return true;
		}

		return false;
	};

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}

		buffer += decoder.decode(value, { stream: true });
		let index = 0;

		while (index < buffer.length) {
			if (mode === "seekJobsKey") {
				const jobsIndex = buffer.indexOf('"jobs"', index);
				if (jobsIndex === -1) {
					buffer = buffer.slice(Math.max(0, buffer.length - 8));
					index = buffer.length;
					continue;
				}
				index = jobsIndex + 6;
				mode = "seekJobsArray";
			}

			if (mode === "seekJobsArray") {
				const arrayIndex = buffer.indexOf("[", index);
				if (arrayIndex === -1) {
					buffer = buffer.slice(Math.max(0, buffer.length - 1));
					index = buffer.length;
					continue;
				}
				index = arrayIndex + 1;
				mode = "readJobs";
			}

			for (; mode === "readJobs" && index < buffer.length; index += 1) {
				const char = buffer[index];
				if (depth === 0) {
					if (char === "]") {
						await reader.cancel();
						return jobs;
					}
					if (char === "{") {
						depth = 1;
						currentObject = "{";
						inString = false;
						escaped = false;
					}
					continue;
				}

				currentObject += char;
				if (inString) {
					if (escaped) {
						escaped = false;
					} else if (char === "\\") {
						escaped = true;
					} else if (char === '"') {
						inString = false;
					}
					continue;
				}

				if (char === '"') {
					inString = true;
				} else if (char === "{") {
					depth += 1;
				} else if (char === "}") {
					depth -= 1;
					if (depth === 0) {
						const shouldStop = await maybeAddJob(currentObject);
						currentObject = "";
						if (shouldStop) {
							return jobs;
						}
					}
				}
			}

			buffer = "";
		}
	}

	return jobs;
}

async function fetchAshbyJobs(
	ctx: ScraperCompanyContext,
	options: FetchAshbyJobsOptions,
): Promise<AshbyJob[]> {
	if (options.limit === 0) {
		return [];
	}

	const url = new URL(ASHBY_BOARD_API);
	url.searchParams.set("includeCompensation", options.includeCompensation ? "true" : "false");

	await ctx.logger.info("Fetching Notion Ashby jobs", {
		url: url.toString(),
		maxJobs: ctx.maxJobs ?? null,
		includeCompensation: options.includeCompensation,
		limit: options.limit ?? null,
		streaming: true,
	});

	const response = await fetchWithTimeout(url);
	if (!response.ok) {
		throw new Error(`Notion Ashby jobs request failed with HTTP ${response.status}`);
	}

	return parseAshbyJobsStream(response, options);
}

function toFirstRunJob(job: AshbyJob): FirstRunJob {
	const locations = normalizeLocations(job);

	return {
		url: canonicalJobUrl(job),
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

function buildTags(job: AshbyJob, locations: string[], workplaceType: string | null): string[] {
	const values = [
		compactText(job.department),
		compactText(job.team),
		normalizeEmploymentType(job.employmentType),
		workplaceType ? `workplace:${workplaceType}` : null,
		...locations.map((location) => `location:${location}`),
	]
		.filter((value): value is string => Boolean(value))
		.map((value) => value.trim())
		.filter(Boolean);

	return [...new Set(values)].slice(0, 50);
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

function compensationComponents(job: AshbyJob): AshbyCompensationComponent[] {
	const direct = job.compensation?.summaryComponents ?? [];
	const tiered = (job.compensation?.compensationTiers ?? []).flatMap((tier) => tier.components ?? []);
	return [...direct, ...tiered];
}

function parseSalary(job: AshbyJob): {
	salaryMin: number | null;
	salaryMax: number | null;
	salaryCurrency: string | null;
	salaryInterval: string | null;
} {
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

	const salaryText = compactText(job.compensation?.scrapeableCompensationSalarySummary);
	const rangeMatch = salaryText?.match(
		/([A-Z]{3}|\$)?\s?(\d[\d,]*(?:\.\d+)?)(K)?\s*(?:-|to|–|—)\s*(?:[A-Z]{3}|\$)?\s?(\d[\d,]*(?:\.\d+)?)(K)?/i,
	);
	const multiplier = rangeMatch?.[3] || rangeMatch?.[5] ? 1000 : 1;
	const salaryMin = rangeMatch?.[2] ? Number(rangeMatch[2].replace(/,/g, "")) * multiplier : null;
	const salaryMax = rangeMatch?.[4] ? Number(rangeMatch[4].replace(/,/g, "")) * multiplier : null;

	return {
		salaryMin: Number.isFinite(salaryMin) ? salaryMin : null,
		salaryMax: Number.isFinite(salaryMax) ? salaryMax : null,
		salaryCurrency: rangeMatch?.[1] === "$" ? "USD" : (rangeMatch?.[1] ?? null),
		salaryInterval: rangeMatch ? "year" : null,
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
	if (/without sponsorship|cannot sponsor|no visa sponsorship|do not sponsor/i.test(sponsorshipText)) {
		return { sponsorshipText, sponsorshipAvailable: false };
	}
	if (/sponsor|sponsorship|visa/i.test(sponsorshipText)) {
		return { sponsorshipText, sponsorshipAvailable: true };
	}

	return { sponsorshipText, sponsorshipAvailable: null };
}

function matchesJob(job: AshbyJob, requestedUrl: string, requestedId: string | null): boolean {
	const canonicalUrl = canonicalJobUrl(job);
	if (canonicalUrl === requestedUrl || job.applyUrl === requestedUrl) {
		return true;
	}

	const jobId = compactText(job.id) ?? extractAshbyJobId(canonicalUrl);
	return Boolean(requestedId && jobId && requestedId === jobId);
}

export async function firstRun(ctx: ScraperCompanyContext): Promise<FirstRunResult> {
	const requestedLimit = maxJobsLimit(ctx);
	const limit = requestedLimit ?? DEFAULT_FIRST_RUN_LIMIT;
	const jobs = await fetchAshbyJobs(ctx, { includeCompensation: false, limit });
	const mappedJobs = jobs.map(toFirstRunJob);

	await ctx.logger.info("Fetched Notion jobs", {
		count: mappedJobs.length,
		maxJobs: ctx.maxJobs ?? null,
		boardUrl: OFFICIAL_BOARD_URL,
	});

	return {
		jobs: mappedJobs,
		sortApplied: "ashby board order",
		raw: {
			source: "ashby-posting-api",
			boardName: ASHBY_BOARD_NAME,
			boardUrl: OFFICIAL_BOARD_URL,
			apiUrl: ASHBY_BOARD_API,
			jobCount: mappedJobs.length,
			defaultLimitApplied: requestedLimit === null,
		},
	};
}

export async function secondRun(ctx: SecondRunContext): Promise<SecondRunResult> {
	const requestedId = extractAshbyJobId(ctx.jobUrl);

	await ctx.logger.info("Fetching Notion job detail", {
		jobId: requestedId,
		jobUrl: ctx.jobUrl,
	});

	const jobs = await fetchAshbyJobs(ctx, {
		includeCompensation: true,
		limit: 1,
		matches: (candidate) => matchesJob(candidate, ctx.jobUrl, requestedId),
	});
	const job = jobs.find((candidate) => matchesJob(candidate, ctx.jobUrl, requestedId));
	if (!job) {
		return {
			status: "removed",
			message: "Notion Ashby job is no longer available",
			raw: {
				jobId: requestedId,
				jobUrl: ctx.jobUrl,
				source: "ashby-posting-api",
			},
		};
	}

	const description = compactText(job.descriptionPlain) ?? htmlToText(job.descriptionHtml);
	const locations = normalizeLocations(job);
	const workplaceType = normalizeWorkplaceType(job.workplaceType, job.isRemote);
	const salary = parseSalary(job);
	const sponsorship = extractSponsorship(description);
	const title = compactText(job.title) ?? "Notion role";

	return {
		status: "ok",
		url: canonicalJobUrl(job),
		title,
		roleName: title,
		description,
		locations,
		tags: buildTags(job, locations, workplaceType),
		employmentType: normalizeEmploymentType(job.employmentType),
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
			jobUrl: ctx.jobUrl,
			applyUrl: job.applyUrl ?? null,
			department: job.department ?? null,
			team: job.team ?? null,
			compensationSummary: job.compensation?.compensationTierSummary ?? null,
		},
	};
}
