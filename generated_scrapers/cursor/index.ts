import type {
	FirstRunJob,
	FirstRunResult,
	ScraperCompanyContext,
	SecondRunContext,
	SecondRunResult,
} from "@/app/service/scraper-types";

const OFFICIAL_BOARD_URL = "https://cursor.com/careers";
const CURSOR_ORIGIN = "https://cursor.com";
const USER_AGENT = "EarlyApply generated Cursor scraper";
const REQUEST_TIMEOUT_MS = 15_000;

const KNOWN_TEAMS = [
	"Customer Success",
	"Product Management",
	"Revenue Operations",
	"Engineering",
	"Marketing",
	"Operations",
	"Solutions",
	"People",
	"Design",
	"Sales",
	"User Ops",
];

type FetchTextResult =
	| {
			status: "ok";
			html: string;
	  }
	| {
			status: "removed";
			message: string;
	  };

type ParsedListing = {
	url: string;
	title: string | null;
	team: string | null;
	employmentType: string | null;
	locations: string[];
	rawText: string | null;
};

type ParsedDetail = {
	title: string | null;
	description: string | null;
	team: string | null;
	employmentType: string | null;
	locations: string[];
	tags: string[];
	workplaceType: string | null;
	sponsorshipText: string | null;
	sponsorshipAvailable: boolean | null;
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
		.replace(/<\s*\/(h1|h2|h3|h4|h5|h6|section|article|div|header|main|form)\s*>/gi, "\n")
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

function normalizeCursorCareersUrl(value: string | null | undefined): string | null {
	const url = normalizeUrl(value, CURSOR_ORIGIN);
	if (!url) {
		return null;
	}

	const parsed = new URL(url);
	if (parsed.hostname !== "cursor.com") {
		return null;
	}
	if (!/^\/careers\/[^/]+\/?$/i.test(parsed.pathname)) {
		return null;
	}

	parsed.pathname = parsed.pathname.replace(/\/$/, "");
	return parsed.toString();
}

function requestHeaders(accept: string): HeadersInit {
	return {
		accept,
		"accept-language": "en-US,en;q=0.9",
		"cache-control": "no-cache",
		pragma: "no-cache",
		"user-agent": USER_AGENT,
	};
}

async function fetchWithTimeout(url: string): Promise<Response> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
	try {
		return await fetch(url, {
			headers: requestHeaders("text/html,application/xhtml+xml"),
			signal: controller.signal,
		});
	} finally {
		clearTimeout(timeout);
	}
}

async function fetchHtml(url: string): Promise<FetchTextResult> {
	const response = await fetchWithTimeout(url);
	if (response.status === 404 || response.status === 410) {
		return {
			status: "removed",
			message: `Cursor posting returned HTTP ${response.status}`,
		};
	}
	if (!response.ok) {
		if (response.status >= 400 && response.status < 500) {
			return {
				status: "removed",
				message: `Cursor posting returned HTTP ${response.status}`,
			};
		}
		throw new Error(`Cursor request failed with HTTP ${response.status}`);
	}

	return {
		status: "ok",
		html: await response.text(),
	};
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
	const seen = new Set<string>();
	const result: string[] = [];

	for (const value of values) {
		const text = compactText(value);
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

function extractAnchorTags(html: string): Array<{ href: string; text: string | null }> {
	const anchors: Array<{ href: string; text: string | null }> = [];
	const anchorPattern = /<a\b[^>]*href\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a>/gi;

	for (const match of html.matchAll(anchorPattern)) {
		anchors.push({
			href: decodeHtmlEntities(match[2] ?? ""),
			text: htmlToText(match[3] ?? ""),
		});
	}

	return anchors;
}

function splitLocations(value: string | null): string[] {
	if (!value) {
		return [];
	}

	return uniqueStrings(value.split(/\s*(?:;|\/|\||, and | and )\s*/i));
}

function extractTeamAndTitle(value: string | null): { title: string | null; team: string | null } {
	const text = compactText(value);
	if (!text) {
		return { title: null, team: null };
	}

	const team = KNOWN_TEAMS.find((candidate) => text.endsWith(` ${candidate}`)) ?? null;
	if (!team) {
		return { title: text, team: null };
	}

	return {
		title: compactText(text.slice(0, -team.length)),
		team,
	};
}

function parseListingText(value: string | null): Omit<ParsedListing, "url" | "rawText"> {
	const text = compactText(value?.replace(/\s*Apply\s*(?:→|->)?\s*$/i, ""));
	if (!text) {
		return {
			title: null,
			team: null,
			employmentType: null,
			locations: [],
		};
	}

	const parts = text
		.split(/\s+·\s+/)
		.map((part) => compactText(part))
		.filter((part): part is string => Boolean(part));
	const titleAndTeam = extractTeamAndTitle(parts[0] ?? null);

	return {
		...titleAndTeam,
		employmentType: compactText(parts[1] ?? null),
		locations: splitLocations(parts[2] ?? null),
	};
}

function parseJobListings(html: string): ParsedListing[] {
	const listings = new Map<string, ParsedListing>();

	for (const anchor of extractAnchorTags(html)) {
		const url = normalizeCursorCareersUrl(anchor.href);
		if (!url) {
			continue;
		}

		const parsed = parseListingText(anchor.text);
		if (!parsed.title && !parsed.employmentType && parsed.locations.length === 0) {
			continue;
		}
		if (listings.has(url)) {
			continue;
		}

		listings.set(url, {
			url,
			...parsed,
			rawText: anchor.text,
		});
	}

	return [...listings.values()];
}

function extractFirstTagText(html: string, tagName: string): string | null {
	const pattern = new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i");
	const match = html.match(pattern);
	return match ? htmlToText(match[1]) : null;
}

function linesFromHtml(html: string): string[] {
	const text = htmlToText(html);
	if (!text) {
		return [];
	}

	const lines: string[] = [];
	const seenConsecutive = new Set<string>();
	for (const line of text.split("\n")) {
		const value = compactText(line);
		if (!value) {
			continue;
		}
		const duplicateKey = `${lines.length}:${value}`;
		if (seenConsecutive.has(duplicateKey)) {
			continue;
		}
		seenConsecutive.add(duplicateKey);
		lines.push(value);
	}

	return lines;
}

function parseSubtitle(value: string | null): {
	team: string | null;
	employmentType: string | null;
	locations: string[];
} {
	const parts = (value ?? "")
		.split(/\s+·\s+/)
		.map((part) => compactText(part))
		.filter((part): part is string => Boolean(part));

	return {
		team: compactText(parts[0] ?? null),
		employmentType: compactText(parts[1] ?? null),
		locations: splitLocations(parts[2] ?? null),
	};
}

function findSubtitleLine(lines: string[], title: string | null): string | null {
	const titleIndex = title ? lines.findIndex((line) => line === title) : -1;
	const candidates = titleIndex >= 0 ? lines.slice(titleIndex + 1, titleIndex + 5) : lines;
	return candidates.find((line) => /\s+·\s+/.test(line)) ?? null;
}

function extractDescription(lines: string[], title: string | null, subtitle: string | null): string | null {
	const titleIndex = title ? lines.findIndex((line) => line === title) : -1;
	const subtitleIndex = subtitle ? lines.findIndex((line, index) => index > titleIndex && line === subtitle) : -1;
	let startIndex = subtitleIndex >= 0 ? subtitleIndex + 1 : Math.max(titleIndex + 1, 0);

	const applyIndex = lines.findIndex((line, index) => index >= startIndex && /^Apply\b/i.test(line));
	if (applyIndex >= 0) {
		startIndex = applyIndex + 1;
	}

	const endIndex = lines.findIndex(
		(line, index) =>
			index > startIndex &&
			(/^(Apply for this role|Name\*|U\.S\. EQUAL EMPLOYMENT OPPORTUNITY|Product)$/i.test(line) ||
				line === title),
	);
	const descriptionLines = lines.slice(startIndex, endIndex >= 0 ? endIndex : undefined);

	return compactText(descriptionLines.join("\n"));
}

function inferWorkplaceType(locations: string[], description: string | null): string | null {
	if (locations.some((location) => /^remote$/i.test(location))) {
		return locations.length > 1 ? "Hybrid" : "Remote";
	}
	if (/\bremote\b/i.test(description ?? "")) {
		return "Remote";
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
			.find((line) => line && /sponsor|sponsorship|visa|work authorization/i.test(line)) ?? null;

	if (!sponsorshipText) {
		return {
			sponsorshipText: null,
			sponsorshipAvailable: null,
		};
	}
	if (/without sponsorship|cannot sponsor|no visa sponsorship|do not sponsor/i.test(sponsorshipText)) {
		return {
			sponsorshipText,
			sponsorshipAvailable: false,
		};
	}
	if (/sponsor|sponsorship|visa/i.test(sponsorshipText)) {
		return {
			sponsorshipText,
			sponsorshipAvailable: true,
		};
	}

	return {
		sponsorshipText,
		sponsorshipAvailable: null,
	};
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

	const salaryMatch = description.match(
		/\$([0-9][0-9,]*(?:\.\d+)?)\s*(?:k|K)?\s*(?:-|–|—|to)\s*\$?([0-9][0-9,]*(?:\.\d+)?)\s*(k|K)?/i,
	);
	if (!salaryMatch) {
		return {
			salaryMin: null,
			salaryMax: null,
			salaryCurrency: null,
			salaryInterval: null,
		};
	}

	const minRaw = Number.parseFloat((salaryMatch[1] ?? "").replace(/,/g, ""));
	const maxRaw = Number.parseFloat((salaryMatch[2] ?? "").replace(/,/g, ""));
	const multiplier = salaryMatch[0].toLowerCase().includes("k") ? 1000 : 1;

	return {
		salaryMin: Number.isFinite(minRaw) ? minRaw * multiplier : null,
		salaryMax: Number.isFinite(maxRaw) ? maxRaw * multiplier : null,
		salaryCurrency: "USD",
		salaryInterval: /hour|hourly/i.test(description) ? "hour" : "year",
	};
}

function parseDetail(html: string): ParsedDetail {
	const title = extractFirstTagText(html, "h1");
	const lines = linesFromHtml(html);
	const subtitle = findSubtitleLine(lines, title);
	const subtitleParts = parseSubtitle(subtitle);
	const description = extractDescription(lines, title, subtitle);
	const workplaceType = inferWorkplaceType(subtitleParts.locations, description);
	const sponsorship = extractSponsorship(description);
	const salary = parseSalary(description);
	const tags = uniqueStrings([subtitleParts.team, subtitleParts.employmentType, workplaceType]);

	return {
		title,
		description,
		team: subtitleParts.team,
		employmentType: subtitleParts.employmentType,
		locations: subtitleParts.locations,
		tags,
		workplaceType,
		...sponsorship,
		...salary,
	};
}

function toFirstRunJob(job: ParsedListing): FirstRunJob {
	return {
		url: job.url,
		title: job.title,
		location: job.locations.join(", ") || null,
		raw: {
			source: "cursor-careers-html",
			team: job.team,
			employmentType: job.employmentType,
			locations: job.locations,
			listingText: job.rawText,
		},
	};
}

export async function firstRun(ctx: ScraperCompanyContext): Promise<FirstRunResult> {
	const limit = maxJobsLimit(ctx);
	if (limit === 0) {
		return {
			jobs: [],
			sortApplied: "cursor careers page order",
			raw: {
				source: "cursor-careers-html",
				boardUrl: OFFICIAL_BOARD_URL,
				jobCount: 0,
			},
		};
	}

	await ctx.logger.info("Fetching Cursor careers page", {
		url: OFFICIAL_BOARD_URL,
		maxJobs: ctx.maxJobs ?? null,
	});

	const result = await fetchHtml(OFFICIAL_BOARD_URL);
	if (result.status === "removed") {
		throw new Error(result.message);
	}

	const parsedJobs = parseJobListings(result.html);
	const boundedJobs = limit === null ? parsedJobs : parsedJobs.slice(0, limit);
	const jobs = boundedJobs.map(toFirstRunJob);

	await ctx.logger.info("Fetched Cursor jobs", {
		count: jobs.length,
		maxJobs: ctx.maxJobs ?? null,
		boardUrl: OFFICIAL_BOARD_URL,
	});

	return {
		jobs,
		sortApplied: "cursor careers page order",
		raw: {
			source: "cursor-careers-html",
			boardUrl: OFFICIAL_BOARD_URL,
			jobCount: jobs.length,
			totalDiscovered: parsedJobs.length,
		},
	};
}

export async function secondRun(ctx: SecondRunContext): Promise<SecondRunResult> {
	const jobUrl = normalizeCursorCareersUrl(ctx.jobUrl);
	if (!jobUrl) {
		return {
			status: "removed",
			message: "Cursor job URL is no longer a recognized careers posting URL",
			raw: {
				jobUrl: ctx.jobUrl,
				source: "cursor-careers-html",
			},
		};
	}

	await ctx.logger.info("Fetching Cursor job detail", {
		jobUrl,
	});

	const result = await fetchHtml(jobUrl);
	if (result.status === "removed") {
		return {
			status: "removed",
			message: result.message,
			raw: {
				jobUrl,
				source: "cursor-careers-html",
			},
		};
	}

	const detail = parseDetail(result.html);
	if (!detail.title || !detail.description) {
		return {
			status: "removed",
			message: "Cursor posting did not contain active job details",
			raw: {
				jobUrl,
				source: "cursor-careers-html",
			},
		};
	}

	return {
		status: "ok",
		url: jobUrl,
		title: detail.title,
		roleName: detail.title,
		description: detail.description,
		locations: detail.locations,
		tags: detail.tags,
		employmentType: detail.employmentType,
		workplaceType: detail.workplaceType,
		salaryMin: detail.salaryMin,
		salaryMax: detail.salaryMax,
		salaryCurrency: detail.salaryCurrency,
		salaryInterval: detail.salaryInterval,
		sponsorshipText: detail.sponsorshipText,
		sponsorshipAvailable: detail.sponsorshipAvailable,
		raw: {
			source: "cursor-careers-html",
			jobUrl,
			team: detail.team,
		},
	};
}
