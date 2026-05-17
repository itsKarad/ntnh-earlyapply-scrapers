import { createLogger, loadScraper, newRunId } from "./runtime.js";

export async function validateScraper(input: {
	companyName: string;
	jobBoardUrl: string;
	maxJobs: number;
}): Promise<{ message: string; firstRunJobCount: number; reviewedJobCount: number }> {
	const runId = newRunId();
	const { slug, scraper } = await loadScraper(input.companyName);
	const logger = createLogger(runId);
	const first = await scraper.firstRun({
		runId,
		companyId: 0,
		companyName: input.companyName,
		companySlug: slug,
		boardUrl: input.jobBoardUrl,
		maxJobs: input.maxJobs,
		logger,
	});

	if (!first.jobs.length) {
		throw new Error("firstRun returned zero jobs");
	}
	if (first.jobs.length > input.maxJobs) {
		throw new Error(`firstRun returned ${first.jobs.length} jobs, expected at most ${input.maxJobs}`);
	}

	let reviewedJobCount = 0;
	for (const job of first.jobs.slice(0, input.maxJobs)) {
		const result = await scraper.secondRun({
			runId,
			companyId: 0,
			companyName: input.companyName,
			companySlug: slug,
			boardUrl: input.jobBoardUrl,
			maxJobs: input.maxJobs,
			jobUrl: job.url,
			logger,
		});
		if (result.status === "ok") {
			if (!result.title?.trim()) {
				throw new Error(`secondRun returned a job without title for ${job.url}`);
			}
			if (!result.description?.trim()) {
				throw new Error(`secondRun returned a job without description for ${job.url}`);
			}
			reviewedJobCount += 1;
		}
	}

	if (!reviewedJobCount) {
		throw new Error("secondRun reviewed zero active jobs");
	}

	return {
		message: `Validation passed for ${reviewedJobCount} job(s).`,
		firstRunJobCount: first.jobs.length,
		reviewedJobCount,
	};
}
