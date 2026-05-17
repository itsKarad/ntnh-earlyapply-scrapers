import type {
	FirstRunJob,
	FirstRunResult,
	ScraperCompanyContext,
	SecondRunContext,
	SecondRunResult,
} from "@/app/service/scraper-types";

const TENANT = "nvidia";
const SITE = "NVIDIAExternalCareerSite";
const OFFICIAL_BOARD_URL = `https://nvidia.wd5.myworkdayjobs.com/${SITE}`;
const API_BASE = `https://nvidia.wd5.myworkdayjobs.com/wday/cxs/${TENANT}/${SITE}`;
const JOBS_API_URL = `${API_BASE}/jobs`;
const DEFAULT_PAGE_SIZE = 20;
const USER_AGENT =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36 EarlyApply";

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
	postedOn?: string | null;
	startDate?: string | null;
	timeType?: string | null;
	jobReqId?: string | null;
	jobRequisitionId?: string | null;
	remoteType?: string | null;
	jobFamily?: string | null;
	jobFamilyGroup?: string | null;
	jobProfile?: string | null;
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
	  }
	| {
			status: "removed";
			message: string;
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

function normalizeUrl(value: string | null | undefined): string | null {
	const text = compactText(value);
	if (!text) {
		return null;
	}

	try {
		const parsed = new URL(text, OFFICIAL_BOARD_URL);
		if (!/^https?:$/i.test(parsed.protocol) || !/(^|\.)myworkdayjobs\.com$/i.test(parsed.hostname)) {
			return null;
		}
		parsed.hash = "";
		return parsed.toString();
	} catch {
		return null;
	}
}

function normalizeDate(value: string | null | undefined): string | null {
	const text = compactText(value);
	if (!text || /^posted\s+/i.test(text)) {
		return null;
	}

	const timestamp = Date.parse(text);
	return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function requestHeaders(accept: string): HeadersInit {
	return {
		accept,
		"accept-language": "en-US,en;q=0.9",
		origin: "https://nvidia.wd5.myworkdayjobs.com",
		referer: OFFICIAL_BOARD_URL,
		"user-agent": USER_AGENT,
	};
}

function canonicalJobUrl(externalPath: string | null | undefined): string | null {
	const path = compactText(externalPath);
	if (!path) {
		return null;
	}

	if (path.startsWith("/job/")) {
		return `${OFFICIAL_BOARD_URL}${path}`;
	}

	return normalizeUrl(path);
}

function externalPathFromUrl(jobUrl: string): string | null {
	try {
		const parsed = new URL(jobUrl);
		const siteIndex = parsed.pathname.split("/").filter(Boolean).findIndex((part) => part === SITE);
		if (siteIndex >= 0) {
			const parts = parsed.pathname.split("/").filter(Boolean).slice(siteIndex + 1);
			const jobIndex = parts.findIndex((part) => part === "job");
			if (jobIndex >= 0) {
				return `/${parts.slice(jobIndex).map(encodeURIComponent).join("/")}`.replace(/%2F/gi, "/");
			}
		}

		const jobMatch = parsed.pathname.match(/\/job\/.+$/);
		return jobMatch?.[0] ?? null;
	} catch {
		return null;
	}
}

function requisitionIdFromPosting(job: WorkdayJobPosting): string | null {
	const bulletId =
		job.bulletFields
			?.map((field) => compactText(field))
			.find((field) => field && /^JR\d+/i.test(field)) ?? null;
	const pathId = compactText(job.externalPath)?.match(/\bJR\d+(?:-\d+)?\b/i)?.[0] ?? null;
	return bulletId ?? pathId;
}

function requisitionIdFromDetail(info: WorkdayJobPostingInfo): string | null {
	return (
		compactText(info.jobReqId) ??
		compactText(info.jobRequisitionId) ??
		compactText(info.jobDescriptionText)?.match(/\bJR\d+(?:-\d+)?\b/i)?.[0] ??
		null
	);
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
				.filter((value) => !/^view all/i.test(value)),
		),
	].slice(0, 40);
}

function normalizeEmploymentType(value: string | null | undefined): string | null {
	const text = compactText(value);
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

function buildTags(info: WorkdayJobPostingInfo, locations: string[], workplaceType: string | null): string[] {
	const values = [
		compactText(info.jobFamily),
		compactText(info.jobFamilyGroup),
		compactText(info.jobProfile),
		normalizeEmploymentType(info.timeType),
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
				/(?:\$|USD\b).*\d[\d,]*(?:\.\d+)?\s*(?:-|to|–|—)\s*(?:\$|USD\b)?\s*\d[\d,]*(?:\.\d+)?|\d[\d,]*(?:\.\d+)?\s*USD\s*(?:-|to|–|—)\s*\d[\d,]*(?:\.\d+)?\s*USD/i.test(
					line,
				),
			) ?? null;
	const rangeMatch =
		salaryLine?.match(
			/(?:\$|USD\b)?\s*(\d[\d,]*(?:\.\d+)?)\s*(?:USD\b)?\s*(?:-|to|–|—)\s*(?:\$|USD\b)?\s*(\d[\d,]*(?:\.\d+)?)/i,
		) ?? null;
	const salaryMin = rangeMatch?.[1] ? Number(rangeMatch[1].replace(/,/g, "")) : null;
	const salaryMax = rangeMatch?.[2] ? Number(rangeMatch[2].replace(/,/g, "")) : null;

	return {
		salaryMin: Number.isFinite(salaryMin) ? salaryMin : null,
		salaryMax: Number.isFinite(salaryMax) ? salaryMax : null,
		salaryCurrency: rangeMatch ? "USD" : null,
		salaryInterval: /hour|hourly/i.test(salaryLine ?? "") ? "hour" : rangeMatch ? "year" : null,
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
	if (/without sponsorship|cannot sponsor|no visa sponsorship|do not sponsor|unable to sponsor/i.test(sponsorshipText)) {
		return { sponsorshipText, sponsorshipAvailable: false };
	}
	if (/sponsor|sponsorship|visa/i.test(sponsorshipText)) {
		return { sponsorshipText, sponsorshipAvailable: true };
	}

	return { sponsorshipText, sponsorshipAvailable: null };
}

async function fetchJobsPage(ctx: ScraperCompanyContext, offset: number, limit: number): Promise<WorkdayJobsResponse> {
	await ctx.logger.info("Fetching Nvidia Workday jobs page", {
		url: JOBS_API_URL,
		offset,
		limit,
		maxJobs: ctx.maxJobs ?? null,
	});

	const response = await fetch(JOBS_API_URL, {
		method: "POST",
		headers: {
			...requestHeaders("application/json"),
			"content-type": "application/json",
		},
		body: JSON.stringify({
			appliedFacets: {},
			limit,
			offset,
			searchText: "",
		}),
	});

	if (!response.ok) {
		throw new Error(`Nvidia Workday jobs request failed with HTTP ${response.status}`);
	}

	return (await response.json()) as WorkdayJobsResponse;
}

async function fetchWorkdayJobs(ctx: ScraperCompanyContext): Promise<WorkdayJobPosting[]> {
	const maxJobs = maxJobsLimit(ctx);
	if (maxJobs === 0) {
		return [];
	}

	const jobs: WorkdayJobPosting[] = [];
	let total: number | null = null;

	while (maxJobs === null || jobs.length < maxJobs) {
		const pageLimit = Math.min(DEFAULT_PAGE_SIZE, maxJobs === null ? DEFAULT_PAGE_SIZE : maxJobs - jobs.length);
		const page = await fetchJobsPage(ctx, jobs.length, pageLimit);
		const postings = Array.isArray(page.jobPostings) ? page.jobPostings : [];
		total = typeof page.total === "number" && Number.isFinite(page.total) ? page.total : total;

		jobs.push(...postings.slice(0, maxJobs === null ? undefined : maxJobs - jobs.length));
		if (postings.length < pageLimit || (total !== null && jobs.length >= total)) {
			break;
		}
	}

	return jobs;
}

async function fetchJobDetail(externalPath: string): Promise<FetchDetailResult> {
	const response = await fetch(`${API_BASE}${externalPath}`, {
		headers: requestHeaders("application/json, text/plain, */*"),
	});

	if (response.status === 404 || response.status === 410) {
		return { status: "removed", message: `Nvidia Workday job returned HTTP ${response.status}` };
	}
	if (!response.ok) {
		if (response.status >= 400 && response.status < 500) {
			return { status: "removed", message: `Nvidia Workday job returned HTTP ${response.status}` };
		}
		throw new Error(`Nvidia Workday job detail request failed with HTTP ${response.status}`);
	}

	const detail = (await response.json()) as WorkdayJobDetailResponse;
	const info = detail.jobPostingInfo;
	if (!info || !compactText(info.title)) {
		return { status: "removed", message: "Nvidia Workday job is no longer available" };
	}

	return { status: "ok", detail };
}

function toFirstRunJob(job: WorkdayJobPosting): FirstRunJob | null {
	const url = canonicalJobUrl(job.externalPath);
	if (!url) {
		return null;
	}

	return {
		url,
		title: compactText(job.title) ?? requisitionIdFromPosting(job),
		postedAt: normalizeDate(job.postedOn),
		location: compactText(job.locationsText),
		raw: {
			source: "workday-cxs-api",
			tenant: TENANT,
			site: SITE,
			externalPath: job.externalPath ?? null,
			requisitionId: requisitionIdFromPosting(job),
			postedOn: job.postedOn ?? null,
		},
	};
}

export async function firstRun(ctx: ScraperCompanyContext): Promise<FirstRunResult> {
	const jobs = (await fetchWorkdayJobs(ctx)).map(toFirstRunJob).filter((job): job is FirstRunJob => Boolean(job));

	await ctx.logger.info("Fetched Nvidia jobs", {
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
			apiUrl: JOBS_API_URL,
			jobCount: jobs.length,
		},
	};
}

export async function secondRun(ctx: SecondRunContext): Promise<SecondRunResult> {
	const externalPath = externalPathFromUrl(ctx.jobUrl);
	if (!externalPath) {
		return {
			status: "removed",
			message: "Nvidia job URL no longer contains a Workday external path",
			raw: {
				source: "workday-cxs-api",
				jobUrl: ctx.jobUrl,
			},
		};
	}

	await ctx.logger.info("Fetching Nvidia job detail", {
		externalPath,
		jobUrl: ctx.jobUrl,
	});

	const result = await fetchJobDetail(externalPath);
	if (result.status === "removed") {
		return {
			status: "removed",
			message: result.message,
			raw: {
				source: "workday-cxs-api",
				externalPath,
				jobUrl: ctx.jobUrl,
			},
		};
	}

	const info = result.detail.jobPostingInfo;
	if (!info) {
		return {
			status: "removed",
			message: "Nvidia Workday job detail did not include posting info",
			raw: {
				source: "workday-cxs-api",
				externalPath,
				jobUrl: ctx.jobUrl,
			},
		};
	}

	const description = compactText(info.jobDescriptionText) ?? htmlToText(info.jobDescription);
	const locations = normalizeLocations(info.location, info.additionalLocations, info.country);
	const workplaceType = inferWorkplaceType(locations, info.remoteType, description);
	const salary = parseSalary(description);
	const sponsorship = extractSponsorship(description);
	const title = compactText(info.title) ?? "Nvidia role";

	return {
		status: "ok",
		url: canonicalJobUrl(externalPath) ?? ctx.jobUrl,
		title,
		roleName: title,
		description,
		locations,
		tags: buildTags(info, locations, workplaceType),
		employmentType: normalizeEmploymentType(info.timeType),
		workplaceType,
		postedAt: normalizeDate(info.startDate),
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
			jobUrl: ctx.jobUrl,
			requisitionId: requisitionIdFromDetail(info),
			hiringOrganization: result.detail.hiringOrganization?.name ?? null,
			remoteType: info.remoteType ?? null,
		},
	};
}
