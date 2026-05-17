export type ScraperRunKind = "first_run" | "second_run" | "repair";

export type ScraperLogLevel = "info" | "warn" | "error";

export type ScraperLogger = {
	info: (
		message: string,
		metadata?: Record<string, unknown>,
	) => Promise<void>;
	warn: (
		message: string,
		metadata?: Record<string, unknown>,
	) => Promise<void>;
	error: (
		message: string,
		metadata?: Record<string, unknown>,
	) => Promise<void>;
};

export type ScraperCompanyContext = {
	runId: string;
	companyId: number;
	companyName: string;
	companySlug: string;
	boardUrl: string;
	maxJobs?: number;
	logger: ScraperLogger;
};

export type FirstRunJob = {
	url: string;
	title?: string | null;
	postedAt?: string | null;
	location?: string | null;
	raw?: Record<string, unknown>;
};

export type FirstRunResult = {
	jobs: FirstRunJob[];
	sortApplied?: string | null;
	raw?: Record<string, unknown>;
};

export type SecondRunJobDetails = {
	status: "ok";
	url?: string | null;
	title: string;
	roleName?: string | null;
	description?: string | null;
	locations?: string[];
	tags?: string[];
	employmentType?: string | null;
	workplaceType?: string | null;
	salaryMin?: number | null;
	salaryMax?: number | null;
	salaryCurrency?: string | null;
	salaryInterval?: string | null;
	sponsorshipText?: string | null;
	sponsorshipAvailable?: boolean | null;
	postedAt?: string | null;
	raw?: Record<string, unknown>;
};

export type SecondRunRemoved = {
	status: "removed";
	message: string;
	raw?: Record<string, unknown>;
};

export type SecondRunResult = SecondRunJobDetails | SecondRunRemoved;

export type SecondRunContext = ScraperCompanyContext & {
	jobUrl: string;
};

export type CompanyScraperModule = {
	firstRun: (ctx: ScraperCompanyContext) => Promise<FirstRunResult>;
	secondRun: (ctx: SecondRunContext) => Promise<SecondRunResult>;
};
