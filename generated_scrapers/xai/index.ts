import type {
	FirstRunJob,
	FirstRunResult,
	ScraperCompanyContext,
	SecondRunContext,
	SecondRunResult,
} from "@/app/service/scraper-types";

const BOARD_TOKEN = "xai";
const OFFICIAL_BOARD_URL = "https://job-boards.greenhouse.io/xai";
const GREENHOUSE_BOARD_API = `https://boards-api.greenhouse.io/v1/boards/${BOARD_TOKEN}/jobs`;
const USER_AGENT = "EarlyApply generated xAI scraper";

type GreenhouseLocation = {
	name?: string | null;
};

type GreenhouseOffice = {
	id?: number | string | null;
	name?: string | null;
	location?: string | GreenhouseLocation | null;
};

type GreenhouseDepartment = {
	id?: number | string | null;
	name?: string | null;
	child_ids?: Array<number | string> | null;
};

type GreenhouseMetadata = {
	id?: number | string | null;
	name?: string | null;
	value?: unknown;
	value_type?: string | null;
};

type GreenhouseQuestion = {
	label?: string | null;
	description?: string | null;
	fields?: unknown;
	required?: boolean | null;
};

type GreenhouseJob = {
	id?: number | string | null;
	internal_job_id?: number | string | null;
	title?: string | null;
	absolute_url?: string | null;
	content?: string | null;
	location?: GreenhouseLocation | null;
	offices?: GreenhouseOffice[] | null;
	departments?: GreenhouseDepartment[] | null;
	metadata?: GreenhouseMetadata[] | null;
	questions?: GreenhouseQuestion[] | null;
	updated_at?: string | null;
	requisition_id?: string | null;
};

type GreenhouseJobsResponse = {
	jobs?: GreenhouseJob[];
};

type FetchJobResult =
	| {
			status: "ok";
			job: GreenhouseJob;
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
	const text = compactText(value);
	if (!text) {
		return null;
	}

	const timestamp = Date.parse(text);
	return Number.isNaN(timestamp) ? null : new Date(timestamp).toISOString();
}

function normalizeUrl(value: string | null | undefined): string | null {
	const text = compactText(value);
	if (!text) {
		return null;
	}

	try {
		const parsed = new URL(text);
		if (!/^https?:$/i.test(parsed.protocol)) {
			return null;
		}
		parsed.hash = "";
		return parsed.toString();
	} catch {
		return null;
	}
}

function canonicalJobUrl(job: GreenhouseJob): string {
	const absoluteUrl = normalizeUrl(job.absolute_url);
	if (absoluteUrl) {
		return absoluteUrl;
	}

	const id = compactText(job.id);
	return id ? `${OFFICIAL_BOARD_URL}/jobs/${encodeURIComponent(id)}` : OFFICIAL_BOARD_URL;
}

function extractJobId(jobUrl: string): string | null {
	try {
		const parsed = new URL(jobUrl);
		const token =
			parsed.searchParams.get("gh_jid") ??
			parsed.searchParams.get("token") ??
			parsed.searchParams.get("job_id") ??
			parsed.searchParams.get("jobId");
		if (token && /^\d+$/.test(token)) {
			return token;
		}

		const segments = parsed.pathname.split("/").filter(Boolean);
		for (let index = 0; index < segments.length; index += 1) {
			if (segments[index]?.toLowerCase() === "jobs" && segments[index + 1]) {
				const match = segments[index + 1].match(/\d+/);
				if (match) {
					return match[0];
				}
			}
		}

		const lastSegmentMatch = segments.at(-1)?.match(/\d{6,}/);
		return lastSegmentMatch?.[0] ?? null;
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

async function fetchGreenhouseJobs(ctx: ScraperCompanyContext): Promise<GreenhouseJob[]> {
	const limit = maxJobsLimit(ctx);
	if (limit === 0) {
		return [];
	}

	const url = new URL(GREENHOUSE_BOARD_API);
	url.searchParams.set("content", "true");

	await ctx.logger.info("Fetching xAI Greenhouse jobs", {
		url: url.toString(),
		maxJobs: ctx.maxJobs ?? null,
	});

	const response = await fetch(url, { headers: apiHeaders() });
	if (!response.ok) {
		throw new Error(`xAI Greenhouse jobs request failed with HTTP ${response.status}`);
	}

	const data = (await response.json()) as GreenhouseJobsResponse;
	const jobs = Array.isArray(data.jobs) ? data.jobs : [];
	return limit === null ? jobs : jobs.slice(0, limit);
}

async function fetchGreenhouseJob(jobId: string): Promise<FetchJobResult> {
	const url = new URL(`${GREENHOUSE_BOARD_API}/${encodeURIComponent(jobId)}`);
	url.searchParams.set("questions", "true");

	const response = await fetch(url, { headers: apiHeaders() });
	if (response.status === 404 || response.status === 410) {
		return {
			status: "removed",
			message: `xAI Greenhouse job ${jobId} is no longer available`,
		};
	}
	if (!response.ok) {
		if (response.status >= 400 && response.status < 500) {
			return {
				status: "removed",
				message: `xAI Greenhouse job ${jobId} returned HTTP ${response.status}`,
			};
		}
		throw new Error(`xAI Greenhouse job ${jobId} request failed with HTTP ${response.status}`);
	}

	const job = (await response.json()) as GreenhouseJob;
	if (!compactText(job.title)) {
		return {
			status: "removed",
			message: `xAI Greenhouse job ${jobId} did not return an active posting`,
		};
	}

	return {
		status: "ok",
		job,
	};
}

function metadataValue(job: GreenhouseJob, namePattern: RegExp): string | null {
	for (const item of job.metadata ?? []) {
		if (!namePattern.test(item.name ?? "")) {
			continue;
		}

		if (Array.isArray(item.value)) {
			const values = item.value
				.map((value) => compactText(value))
				.filter((value): value is string => Boolean(value));
			if (values.length > 0) {
				return values.join(", ");
			}
		}

		const value = compactText(item.value);
		if (value) {
			return value;
		}
	}

	return null;
}

function officeLocation(office: GreenhouseOffice): string | null {
	if (typeof office.location === "string") {
		return compactText(office.location);
	}

	return compactText(office.location?.name) ?? compactText(office.name);
}

function normalizeLocations(job: GreenhouseJob): string[] {
	const values = [
		compactText(job.location?.name),
		...(job.offices ?? []).flatMap((office) => [compactText(office.name), officeLocation(office)]),
		metadataValue(job, /location|workplace/i),
	]
		.filter((value): value is string => Boolean(value))
		.flatMap((value) => value.split(/\s*(?:;|\|)\s*/))
		.map((value) => compactText(value))
		.filter((value): value is string => Boolean(value));

	return [...new Set(values)];
}

function buildTags(job: GreenhouseJob, locations: string[], workplaceType: string | null): string[] {
	const values = [
		...(job.departments ?? []).map((department) => compactText(department.name)),
		...(job.offices ?? []).map((office) => compactText(office.name)),
		...(job.metadata ?? []).map((item) => {
			const name = compactText(item.name);
			const value = Array.isArray(item.value)
				? item.value
						.map((entry) => compactText(entry))
						.filter((entry): entry is string => Boolean(entry))
						.join(", ")
				: compactText(item.value);
			return name && value ? `${name}:${value}` : value;
		}),
		workplaceType ? `workplace:${workplaceType}` : null,
		...locations.map((location) => `location:${location}`),
	]
		.filter((value): value is string => Boolean(value))
		.map((value) => value.trim())
		.filter(Boolean);

	return [...new Set(values)].slice(0, 50);
}

function inferEmploymentType(job: GreenhouseJob, description: string | null): string | null {
	const metadataEmployment = metadataValue(job, /employment|job\s*type|time\s*type/i);
	if (metadataEmployment) {
		return metadataEmployment;
	}

	const text = `${job.title ?? ""}\n${description ?? ""}`.toLowerCase();
	if (/\bintern(ship)?\b/.test(text)) {
		return "Internship";
	}
	if (/\bcontract(or)?\b/.test(text)) {
		return "Contract";
	}
	if (/\bpart[-\s]?time\b/.test(text)) {
		return "Part-time";
	}
	if (/\bfull[-\s]?time\b/.test(text)) {
		return "Full-time";
	}

	return null;
}

function inferWorkplaceType(locations: string[], description: string | null): string | null {
	const text = `${locations.join(" ")}\n${description ?? ""}`.toLowerCase();
	if (/\bremote\b/.test(text)) {
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

function parseSalary(description: string | null): {
	salaryMin: number | null;
	salaryMax: number | null;
	salaryCurrency: string | null;
	salaryInterval: string | null;
} {
	if (!description) {
		return {
			salaryMin: null,
			salaryMax: null,
			salaryCurrency: null,
			salaryInterval: null,
		};
	}

	const salaryLine =
		description
			.split("\n")
			.find((line) => /\$\s?\d[\d,]*(?:\.\d+)?\s*(?:-|to|–|—)\s*\$?\s?\d[\d,]*/i.test(line)) ??
		null;
	const rangeMatch = salaryLine?.match(
		/\$\s?(\d[\d,]*(?:\.\d+)?)\s*(?:-|to|–|—)\s*\$?\s?(\d[\d,]*(?:\.\d+)?)/i,
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

function extractSponsorship(job: GreenhouseJob, description: string | null): {
	sponsorshipText: string | null;
	sponsorshipAvailable: boolean | null;
} {
	const questionText =
		(job.questions ?? [])
			.map((question) => compactText(question.label) ?? compactText(question.description))
			.find((text) => text && /sponsor|visa|work authorization/i.test(text)) ?? null;
	const descriptionText =
		description
			?.split("\n")
			.map((line) => compactText(line))
			.find((line) => line && /sponsor|visa|work authorization/i.test(line)) ?? null;
	const sponsorshipText = descriptionText ?? questionText ?? null;

	if (!sponsorshipText) {
		return { sponsorshipText: null, sponsorshipAvailable: null };
	}
	if (/without sponsorship|cannot sponsor|no visa sponsorship|do not sponsor|unable to sponsor/i.test(sponsorshipText)) {
		return { sponsorshipText, sponsorshipAvailable: false };
	}
	if (/sponsorship (?:is )?(?:available|provided)|visa sponsorship available|we sponsor/i.test(sponsorshipText)) {
		return { sponsorshipText, sponsorshipAvailable: true };
	}

	return { sponsorshipText, sponsorshipAvailable: null };
}

function toFirstRunJob(job: GreenhouseJob): FirstRunJob {
	const locations = normalizeLocations(job);

	return {
		url: canonicalJobUrl(job),
		title: compactText(job.title),
		postedAt: normalizeDate(job.updated_at),
		location: locations.join(", ") || null,
		raw: {
			source: "greenhouse-board-api",
			id: job.id ?? null,
			internalJobId: job.internal_job_id ?? null,
			requisitionId: job.requisition_id ?? null,
			boardToken: BOARD_TOKEN,
			greenhouseUrl: normalizeUrl(job.absolute_url) ?? null,
		},
	};
}

export async function firstRun(ctx: ScraperCompanyContext): Promise<FirstRunResult> {
	const jobs = await fetchGreenhouseJobs(ctx);
	const mappedJobs = jobs.map(toFirstRunJob);

	await ctx.logger.info("Fetched xAI jobs", {
		count: mappedJobs.length,
		maxJobs: ctx.maxJobs ?? null,
		boardUrl: OFFICIAL_BOARD_URL,
	});

	return {
		jobs: mappedJobs,
		sortApplied: "greenhouse board order",
		raw: {
			source: "greenhouse-board-api",
			boardToken: BOARD_TOKEN,
			boardUrl: OFFICIAL_BOARD_URL,
			apiUrl: GREENHOUSE_BOARD_API,
			jobCount: mappedJobs.length,
		},
	};
}

export async function secondRun(ctx: SecondRunContext): Promise<SecondRunResult> {
	const jobId = extractJobId(ctx.jobUrl);
	if (!jobId) {
		return {
			status: "removed",
			message: "xAI job URL no longer contains a Greenhouse job id",
			raw: {
				jobUrl: ctx.jobUrl,
				source: "greenhouse-board-api",
			},
		};
	}

	await ctx.logger.info("Fetching xAI job detail", {
		jobId,
		jobUrl: ctx.jobUrl,
	});

	const result = await fetchGreenhouseJob(jobId);
	if (result.status === "removed") {
		return {
			status: "removed",
			message: result.message,
			raw: {
				jobId,
				jobUrl: ctx.jobUrl,
				source: "greenhouse-board-api",
			},
		};
	}

	const job = result.job;
	const description = htmlToText(job.content);
	const locations = normalizeLocations(job);
	const workplaceType = inferWorkplaceType(locations, description);
	const salary = parseSalary(description);
	const sponsorship = extractSponsorship(job, description);
	const title = compactText(job.title) ?? "xAI role";

	return {
		status: "ok",
		url: canonicalJobUrl(job),
		title,
		roleName: title,
		description,
		locations,
		tags: buildTags(job, locations, workplaceType),
		employmentType: inferEmploymentType(job, description),
		workplaceType,
		postedAt: normalizeDate(job.updated_at),
		salaryMin: salary.salaryMin,
		salaryMax: salary.salaryMax,
		salaryCurrency: salary.salaryCurrency,
		salaryInterval: salary.salaryInterval,
		sponsorshipText: sponsorship.sponsorshipText,
		sponsorshipAvailable: sponsorship.sponsorshipAvailable,
		raw: {
			source: "greenhouse-board-api",
			id: job.id ?? jobId,
			internalJobId: job.internal_job_id ?? null,
			requisitionId: job.requisition_id ?? null,
			boardToken: BOARD_TOKEN,
			jobUrl: ctx.jobUrl,
		},
	};
}
