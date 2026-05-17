import type {
	FirstRunJob,
	FirstRunResult,
	ScraperCompanyContext,
	SecondRunContext,
	SecondRunResult,
} from "@/app/service/scraper-types";

const TENANT = "walmart";
const SITE = "WalmartExternal";
const OFFICIAL_BOARD_URL = "https://careers.walmart.com/";
const OFFICIAL_JOB_BASE_URL = "https://careers.walmart.com/us/en/jobs";
const WORKDAY_BOARD_URL = `https://walmart.wd5.myworkdayjobs.com/${SITE}`;
const API_BASE = `https://walmart.wd5.myworkdayjobs.com/wday/cxs/${TENANT}/${SITE}`;
const JOBS_API_URL = `${API_BASE}/jobs`;
const DEFAULT_FIRST_RUN_LIMIT = 50;
const DEFAULT_PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 20_000;
const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 EarlyApply";

type WorkdayJobPosting = {
	title?: string | null;
	externalPath?: string | null;
	locationsText?: string | null;
	postedOn?: string | null;
	bulletFields?: Array<string | number | boolean | null> | null;
};

type WorkdayJobsResponse = {
	total?: number | null;
	jobPostings?: WorkdayJobPosting[] | null;
};

type WorkdayJobPostingInfo = {
	title?: string | null;
	jobDescription?: string | null;
	jobDescriptionText?: string | null;
	location?: string | null;
	additionalLocations?: unknown;
	locationsText?: string | null;
	postedOn?: string | null;
	startDate?: string | null;
	timeType?: string | null;
	jobType?: string | null;
	workerType?: string | null;
	remoteType?: string | null;
	jobReqId?: string | null;
	jobRequisitionId?: string | null;
	jobFamily?: string | null;
	jobFamilyGroup?: string | null;
	jobProfile?: string | null;
	businessTitle?: string | null;
	country?: {
		descriptor?: string | null;
	} | null;
};

type WorkdayJobDetailResponse = {
	jobPostingInfo?: WorkdayJobPostingInfo | null;
	hiringOrganization?: {
		name?: string | null;
	} | null;
};

type FetchDetailResult =
	| {
			status: "ok";
			detail: WorkdayJobDetailResponse;
			externalPath: string;
	  }
	| {
			status: "removed";
			message: string;
	  };

type OfficialHtmlDetail = {
	url: string;
	title: string | null;
	description: string | null;
	locations: string[];
	employmentType: string | null;
	workplaceType: string | null;
};

function maxJobsLimit(ctx: ScraperCompanyContext): number {
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
	if (!text || /^posted\s+/i.test(text)) {
		return null;
	}

	const timestamp = Date.parse(text);
	return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function requestHeaders(accept: string, referer = WORKDAY_BOARD_URL): HeadersInit {
	return {
		accept,
		"accept-language": "en-US,en;q=0.9",
		"cache-control": "no-cache",
		origin: "https://walmart.wd5.myworkdayjobs.com",
		pragma: "no-cache",
		referer,
		"user-agent": USER_AGENT,
	};
}

async function fetchWithTimeout(url: string | URL, init: RequestInit): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		return await fetch(url, {
			...init,
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timeout);
	}
}

function extractJobId(value: string | null | undefined): string | null {
	const text = compactText(value);
	if (!text) {
		return null;
	}

	const match = text.match(/\b(?:R-\d+(?:-\d+)?|WD\d+(?:-\d+)?)\b/i);
	return match?.[0].toUpperCase() ?? null;
}

function officialJobUrlFromId(jobId: string | null): string | null {
	if (!jobId) {
		return null;
	}

	return `${OFFICIAL_JOB_BASE_URL}/${encodeURIComponent(jobId)}`;
}

function workdayJobUrl(externalPath: string | null | undefined): string | null {
	const path = compactText(externalPath);
	if (!path) {
		return null;
	}
	if (path.startsWith("/job/")) {
		return `${WORKDAY_BOARD_URL}${path}`;
	}

	try {
		const parsed = new URL(path, WORKDAY_BOARD_URL);
		if (!/(^|\.)myworkdayjobs\.com$/i.test(parsed.hostname)) {
			return null;
		}
		parsed.hash = "";
		return parsed.toString();
	} catch {
		return null;
	}
}

function canonicalJobUrl(externalPath: string | null | undefined): string | null {
	return officialJobUrlFromId(extractJobId(externalPath)) ?? workdayJobUrl(externalPath);
}

function externalPathFromWorkdayUrl(jobUrl: string): string | null {
	try {
		const parsed = new URL(jobUrl);
		if (!/(^|\.)myworkdayjobs\.com$/i.test(parsed.hostname)) {
			return null;
		}

		const pathMatch = parsed.pathname.match(/\/job\/.+$/);
		return pathMatch?.[0] ? decodeURIComponent(pathMatch[0]) : null;
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
			const object = value as Record<string, unknown>;
			return [
				compactText(object.descriptor),
				compactText(object.location),
				compactText(object.name),
				[compactText(object.city), compactText(object.state), compactText(object.country)].filter(Boolean).join(", "),
			].filter((item): item is string => Boolean(item));
		}
		return [];
	});

	return [
		...new Set(
			flattened
				.map((value) => compactText(decodeHtmlEntities(value)))
				.filter((value): value is string => Boolean(value))
				.filter((value) => !/^\d+\s+locations?$/i.test(value))
				.filter((value) => !/^loading map/i.test(value))
				.filter((value) => !/^multiple locations$/i.test(value))
				.filter((value) => !/^\$[\d,]+/.test(value)),
		),
	].slice(0, 40);
}

function normalizeEmploymentType(...values: Array<string | null | undefined>): string | null {
	const text = values.map((value) => compactText(value)).find(Boolean) ?? null;
	if (!text) {
		return null;
	}
	if (/full[-\s]?time/i.test(text)) {
		return "Full-time";
	}
	if (/part[-\s]?time/i.test(text)) {
		return "Part-time";
	}
	if (/intern/i.test(text)) {
		return "Internship";
	}
	if (/contract/i.test(text)) {
		return "Contract";
	}
	if (/temporary|seasonal/i.test(text)) {
		return "Temporary";
	}

	return text;
}

function inferWorkplaceType(locations: string[], remoteType: string | null | undefined, description: string | null): string | null {
	const explicit = compactText(remoteType);
	const text = `${explicit ?? ""}\n${locations.join(" ")}\n${description ?? ""}`.toLowerCase();
	if (/\bremote\b/.test(text)) {
		return "Remote";
	}
	if (/\bhybrid\b|flexible/.test(text)) {
		return "Hybrid";
	}
	if (/\bonsite\b|\bon-site\b|\bin office\b/.test(text) || locations.length > 0) {
		return "On-site";
	}

	return explicit;
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
	const seen = new Set<string>();
	const result: string[] = [];

	for (const value of values) {
		const text = compactText(value ? decodeHtmlEntities(value) : value);
		if (!text) {
			continue;
		}
		const key = text.toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		result.push(text);
	}

	return result;
}

function buildTags(info: WorkdayJobPostingInfo, locations: string[], workplaceType: string | null): string[] {
	return uniqueStrings([
		info.jobFamily,
		info.jobFamilyGroup,
		info.jobProfile,
		normalizeEmploymentType(info.timeType, info.jobType, info.workerType),
		workplaceType ? `workplace:${workplaceType}` : null,
		...locations.map((location) => `location:${location}`),
	]).slice(0, 50);
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
				/(?:\$|USD\b|US\$)\s?\d[\d,]*(?:\.\d+)?\s*(?:\/\s*)?(?:year|yr|hour|hr)?\s*(?:-|to|–|—)\s*(?:\$|USD\b|US\$)?\s?\d[\d,]*(?:\.\d+)?/i.test(
					line,
				),
			) ?? null;
	const rangeMatch = salaryLine?.match(
		/(?:\$|USD\b|US\$)?\s?(\d[\d,]*(?:\.\d+)?)\s*(?:\/\s*)?(?:year|yr|hour|hr)?\s*(?:-|to|–|—)\s*(?:\$|USD\b|US\$)?\s?(\d[\d,]*(?:\.\d+)?)/i,
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
			.find((line) => line && /sponsor|visa|work authorization|immigration/i.test(line)) ?? null;

	if (!sponsorshipText) {
		return { sponsorshipText: null, sponsorshipAvailable: null };
	}
	if (/without sponsorship|cannot sponsor|no visa sponsorship|do not sponsor|unable to sponsor|will not sponsor|not available/i.test(sponsorshipText)) {
		return { sponsorshipText, sponsorshipAvailable: false };
	}
	if (/sponsor|sponsorship|visa/i.test(sponsorshipText)) {
		return { sponsorshipText, sponsorshipAvailable: true };
	}

	return { sponsorshipText, sponsorshipAvailable: null };
}

async function fetchJobsPage(ctx: ScraperCompanyContext, offset: number, limit: number, searchText = ""): Promise<WorkdayJobsResponse> {
	await ctx.logger.info("Fetching Walmart Workday jobs page", {
		url: JOBS_API_URL,
		offset,
		limit,
		searchText: searchText || null,
		maxJobs: ctx.maxJobs ?? null,
	});

	const response = await fetchWithTimeout(JOBS_API_URL, {
		method: "POST",
		headers: {
			...requestHeaders("application/json"),
			"content-type": "application/json",
		},
		body: JSON.stringify({
			appliedFacets: {},
			limit,
			offset,
			searchText,
		}),
	});

	if (!response.ok) {
		throw new Error(`Walmart Workday jobs request failed with HTTP ${response.status}`);
	}

	return (await response.json()) as WorkdayJobsResponse;
}

async function fetchWorkdayJobs(ctx: ScraperCompanyContext): Promise<WorkdayJobPosting[]> {
	const maxJobs = maxJobsLimit(ctx);
	if (maxJobs === 0) {
		await ctx.logger.info("Walmart maxJobs is 0; skipping discovery", { boardUrl: OFFICIAL_BOARD_URL });
		return [];
	}

	const jobs: WorkdayJobPosting[] = [];
	let total: number | null = null;

	while (jobs.length < maxJobs) {
		const pageLimit = Math.min(DEFAULT_PAGE_SIZE, maxJobs - jobs.length);
		const page = await fetchJobsPage(ctx, jobs.length, pageLimit);
		const postings = Array.isArray(page.jobPostings) ? page.jobPostings : [];
		total = typeof page.total === "number" && Number.isFinite(page.total) ? page.total : total;

		jobs.push(...postings.slice(0, maxJobs - jobs.length));
		if (postings.length < pageLimit || (total !== null && jobs.length >= total)) {
			break;
		}
	}

	return jobs;
}

async function searchPostingByJobId(ctx: SecondRunContext, jobId: string): Promise<WorkdayJobPosting | null> {
	const page = await fetchJobsPage(ctx, 0, 20, jobId);
	const postings = Array.isArray(page.jobPostings) ? page.jobPostings : [];
	const lowerId = jobId.toLowerCase();

	return (
		postings.find((posting) => {
			const values = [posting.externalPath, posting.title, ...(posting.bulletFields ?? []).map((field) => compactText(field))];
			return values.some((value) => compactText(value)?.toLowerCase().includes(lowerId));
		}) ?? postings[0] ?? null
	);
}

async function fetchWorkdayDetail(externalPath: string): Promise<FetchDetailResult> {
	const response = await fetchWithTimeout(`${API_BASE}${externalPath}`, {
		headers: requestHeaders("application/json, text/plain, */*"),
	});

	if (response.status === 404 || response.status === 410) {
		return { status: "removed", message: `Walmart Workday job returned HTTP ${response.status}` };
	}
	if (!response.ok) {
		if (response.status >= 400 && response.status < 500) {
			return { status: "removed", message: `Walmart Workday job returned HTTP ${response.status}` };
		}
		throw new Error(`Walmart Workday job detail request failed with HTTP ${response.status}`);
	}

	const detail = (await response.json()) as WorkdayJobDetailResponse;
	const info = detail.jobPostingInfo;
	if (!info || !compactText(info.title)) {
		return { status: "removed", message: "Walmart Workday job is no longer available" };
	}

	return { status: "ok", detail, externalPath };
}

async function fetchDetailByUrl(ctx: SecondRunContext): Promise<FetchDetailResult> {
	const directPath = externalPathFromWorkdayUrl(ctx.jobUrl);
	if (directPath) {
		return fetchWorkdayDetail(directPath);
	}

	const jobId = extractJobId(ctx.jobUrl);
	if (!jobId) {
		return { status: "removed", message: "Walmart job URL no longer contains a recognized job id" };
	}

	const posting = await searchPostingByJobId(ctx, jobId);
	if (!posting?.externalPath) {
		return { status: "removed", message: "Walmart job is no longer available in Workday search" };
	}

	return fetchWorkdayDetail(posting.externalPath);
}

async function fetchOfficialHtmlDetail(jobUrl: string): Promise<OfficialHtmlDetail | null> {
	const response = await fetchWithTimeout(jobUrl, {
		headers: requestHeaders("text/html,application/xhtml+xml", OFFICIAL_BOARD_URL),
	});

	if (response.status === 404 || response.status === 410 || !response.ok) {
		return null;
	}

	const html = await response.text();
	const text = htmlToText(html);
	if (!text || /job is no longer available|job has been removed/i.test(text)) {
		return null;
	}

	const lines = text.split("\n").map((line) => compactText(line)).filter((line): line is string => Boolean(line));
	const jobId = extractJobId(jobUrl);
	const idIndex = jobId ? lines.findIndex((line) => line.includes(jobId)) : -1;
	const nearbyTitle =
		idIndex > 0
			? lines
					.slice(Math.max(0, idIndex - 5), idIndex)
					.reverse()
					.find((line: string) => !/apply now|multiple locations/i.test(line))
			: null;
	const title =
		nearbyTitle ??
		compactText(html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]) ??
		compactText(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.replace(/\s*\|\s*Walmart Careers\s*$/i, ""));
	const detailLines = idIndex >= 0 ? lines.slice(idIndex + 1, idIndex + 8) : lines.slice(0, 12);
	const locations = normalizeLocations(
		detailLines.filter((line) => !extractJobId(line) && !/\$[\d,]+|regular|permanent|salary|salaried|hourly/i.test(line)),
	);
	const employmentType = normalizeEmploymentType(detailLines.find((line) => /regular|permanent|part-time|full-time|temporary|intern/i.test(line)));
	const workplaceType = inferWorkplaceType(locations, null, text);

	return {
		url: jobUrl,
		title,
		description: text,
		locations,
		employmentType,
		workplaceType,
	};
}

function toFirstRunJob(job: WorkdayJobPosting): FirstRunJob | null {
	const jobId = extractJobId(job.externalPath) ?? job.bulletFields?.map((field) => extractJobId(compactText(field))).find(Boolean) ?? null;
	const url = officialJobUrlFromId(jobId) ?? workdayJobUrl(job.externalPath);
	if (!url) {
		return null;
	}

	return {
		url,
		title: compactText(job.title) ?? jobId,
		postedAt: normalizeDate(job.postedOn),
		location: compactText(job.locationsText),
		raw: {
			source: "workday-cxs-api",
			tenant: TENANT,
			site: SITE,
			externalPath: job.externalPath ?? null,
			workdayUrl: workdayJobUrl(job.externalPath),
			requisitionId: jobId,
			postedOn: job.postedOn ?? null,
		},
	};
}

function secondRunFromWorkday(detail: WorkdayJobDetailResponse, externalPath: string, requestedUrl: string): SecondRunResult {
	const info = detail.jobPostingInfo;
	if (!info) {
		return {
			status: "removed",
			message: "Walmart Workday job detail did not include posting info",
			raw: {
				source: "workday-cxs-api",
				externalPath,
				jobUrl: requestedUrl,
			},
		};
	}

	const description = compactText(info.jobDescriptionText) ?? htmlToText(info.jobDescription);
	const locations = normalizeLocations(info.location, info.locationsText, info.additionalLocations, info.country);
	const workplaceType = inferWorkplaceType(locations, info.remoteType, description);
	const employmentType = normalizeEmploymentType(info.timeType, info.jobType, info.workerType);
	const salary = parseSalary(description);
	const sponsorship = extractSponsorship(description);
	const title = compactText(info.title) ?? compactText(info.businessTitle) ?? "Walmart role";
	const jobId = extractJobId(info.jobReqId) ?? extractJobId(info.jobRequisitionId) ?? extractJobId(externalPath);

	return {
		status: "ok",
		url: canonicalJobUrl(externalPath) ?? requestedUrl,
		title,
		roleName: title,
		description,
		locations,
		tags: buildTags(info, locations, workplaceType),
		employmentType,
		workplaceType,
		postedAt: normalizeDate(info.startDate ?? info.postedOn),
		salaryMin: salary.salaryMin,
		salaryMax: salary.salaryMax,
		salaryCurrency: salary.salaryCurrency,
		salaryInterval: salary.salaryInterval,
		sponsorshipText: sponsorship.sponsorshipText,
		sponsorshipAvailable: sponsorship.sponsorshipAvailable,
		raw: {
			source: "workday-cxs-api",
			tenant: TENANT,
			site: SITE,
			externalPath,
			workdayUrl: workdayJobUrl(externalPath),
			jobUrl: requestedUrl,
			requisitionId: jobId,
			hiringOrganization: detail.hiringOrganization?.name ?? null,
			remoteType: info.remoteType ?? null,
			timeType: info.timeType ?? null,
			jobType: info.jobType ?? null,
		},
	};
}

export async function firstRun(ctx: ScraperCompanyContext): Promise<FirstRunResult> {
	const jobs = (await fetchWorkdayJobs(ctx)).map(toFirstRunJob).filter((job): job is FirstRunJob => Boolean(job));

	await ctx.logger.info("Fetched Walmart jobs", {
		count: jobs.length,
		maxJobs: ctx.maxJobs ?? null,
		boardUrl: OFFICIAL_BOARD_URL,
	});

	return {
		jobs,
		sortApplied: "workday board order",
		raw: {
			source: "workday-cxs-api",
			tenant: TENANT,
			site: SITE,
			boardUrl: OFFICIAL_BOARD_URL,
			workdayBoardUrl: WORKDAY_BOARD_URL,
			apiUrl: JOBS_API_URL,
			jobCount: jobs.length,
		},
	};
}

export async function secondRun(ctx: SecondRunContext): Promise<SecondRunResult> {
	await ctx.logger.info("Fetching Walmart job detail", {
		jobUrl: ctx.jobUrl,
		jobId: extractJobId(ctx.jobUrl),
	});

	try {
		const result = await fetchDetailByUrl(ctx);
		if (result.status === "ok") {
			return secondRunFromWorkday(result.detail, result.externalPath, ctx.jobUrl);
		}

		const officialDetail = await fetchOfficialHtmlDetail(ctx.jobUrl);
		if (officialDetail?.title && officialDetail.description) {
			const salary = parseSalary(officialDetail.description);
			const sponsorship = extractSponsorship(officialDetail.description);
			return {
				status: "ok",
				url: officialDetail.url,
				title: officialDetail.title,
				roleName: officialDetail.title,
				description: officialDetail.description,
				locations: officialDetail.locations,
				tags: uniqueStrings([
					officialDetail.employmentType,
					officialDetail.workplaceType ? `workplace:${officialDetail.workplaceType}` : null,
					...officialDetail.locations.map((location) => `location:${location}`),
				]),
				employmentType: officialDetail.employmentType,
				workplaceType: officialDetail.workplaceType,
				salaryMin: salary.salaryMin,
				salaryMax: salary.salaryMax,
				salaryCurrency: salary.salaryCurrency,
				salaryInterval: salary.salaryInterval,
				sponsorshipText: sponsorship.sponsorshipText,
				sponsorshipAvailable: sponsorship.sponsorshipAvailable,
				raw: {
					source: "careers-walmart-html",
					jobUrl: ctx.jobUrl,
					requisitionId: extractJobId(ctx.jobUrl),
					workdayMessage: result.message,
				},
			};
		}

		return {
			status: "removed",
			message: result.message,
			raw: {
				source: "workday-cxs-api",
				jobUrl: ctx.jobUrl,
				requisitionId: extractJobId(ctx.jobUrl),
			},
		};
	} catch (error) {
		await ctx.logger.warn("Walmart Workday detail failed; attempting official HTML fallback", {
			jobUrl: ctx.jobUrl,
			error: error instanceof Error ? error.message : String(error),
		});

		const officialDetail = await fetchOfficialHtmlDetail(ctx.jobUrl);
		if (!officialDetail?.title || !officialDetail.description) {
			throw error;
		}

		const salary = parseSalary(officialDetail.description);
		const sponsorship = extractSponsorship(officialDetail.description);
		return {
			status: "ok",
			url: officialDetail.url,
			title: officialDetail.title,
			roleName: officialDetail.title,
			description: officialDetail.description,
			locations: officialDetail.locations,
			tags: uniqueStrings([
				officialDetail.employmentType,
				officialDetail.workplaceType ? `workplace:${officialDetail.workplaceType}` : null,
				...officialDetail.locations.map((location) => `location:${location}`),
			]),
			employmentType: officialDetail.employmentType,
			workplaceType: officialDetail.workplaceType,
			salaryMin: salary.salaryMin,
			salaryMax: salary.salaryMax,
			salaryCurrency: salary.salaryCurrency,
			salaryInterval: salary.salaryInterval,
			sponsorshipText: sponsorship.sponsorshipText,
			sponsorshipAvailable: sponsorship.sponsorshipAvailable,
			raw: {
				source: "careers-walmart-html",
				jobUrl: ctx.jobUrl,
				requisitionId: extractJobId(ctx.jobUrl),
			},
		};
	}
}
