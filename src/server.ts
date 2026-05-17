import http from "node:http";
import { randomUUID } from "node:crypto";
import { generateOrHealScraper } from "./generate.js";
import { createLogger, loadScraper, newRunId, scraperExists } from "./runtime.js";

type JsonRecord = Record<string, unknown>;
type QueueJobInput = {
	companyName: string;
	jobBoardUrl: string;
	companyPageId: string | null;
	callbackUrl: string | null;
	lastError: string | null;
	mode: "generate" | "heal";
};

const activeJobs = new Map<string, string>();

function text(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${field} is required`);
	}
	return value.trim();
}

async function readJson(req: http.IncomingMessage): Promise<JsonRecord> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	}
	if (!chunks.length) {
		return {};
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonRecord;
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: JsonRecord): void {
	res.writeHead(statusCode, { "content-type": "application/json" });
	res.end(JSON.stringify(payload));
}

function optionalText(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value.trim() : null;
}

function basename(value: unknown): string | undefined {
	return typeof value === "string" ? value.split("/").at(-1) : undefined;
}

function summarizeRequest(pathname: string, body: JsonRecord): JsonRecord {
	return {
		pathname,
		companyName: optionalText(body.companyName) ?? undefined,
		jobUrl: optionalText(body.jobUrl) ?? undefined,
		companyPageId: optionalText(body.companyPageId) ?? undefined,
		hasCallbackUrl: Boolean(optionalText(body.callbackUrl)),
		hasLastError: Boolean(optionalText(body.lastError) ?? optionalText(body.hint)),
	};
}

function summarizeResponse(payload: JsonRecord): JsonRecord {
	return {
		ok: payload.ok,
		hasScraper: payload.hasScraper,
		status: payload.status,
		jobId: payload.jobId,
		companySlug: payload.companySlug,
		discoveredCount: payload.discoveredCount,
		jobs: Array.isArray(payload.jobs) ? payload.jobs.length : undefined,
		logFile: basename(payload.logPath),
		error: payload.error,
	};
}

function cleanFields(fields: JsonRecord): string {
	return Object.entries(fields)
		.filter(([, value]) => value !== undefined && value !== null && value !== "")
		.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
		.join(" ");
}

function logLine(event: string, fields: JsonRecord = {}): void {
	console.log(
		`[${new Date().toISOString()}] ${event}${Object.keys(fields).length ? ` ${cleanFields(fields)}` : ""}`,
	);
}

async function postCallback(input: QueueJobInput, result: JsonRecord): Promise<boolean> {
	if (!input.callbackUrl) {
		return false;
	}

	const status = result.status === "failed" ? "failed" : "ready";
	const payload = {
		companyName: input.companyName,
		companyPageId: input.companyPageId,
		status,
		message: typeof result.message === "string" ? result.message : null,
	};
	const response = await fetch(input.callbackUrl, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	});
	if (!response.ok) {
		throw new Error(`callback returned ${response.status}`);
	}
	return true;
}

function queueGenerateJob(input: QueueJobInput): JsonRecord {
	const activeJobKey = `${input.mode}:${input.companyName.trim().toLowerCase()}`;
	const existingJobId = activeJobs.get(activeJobKey);
	if (existingJobId) {
		logLine("job.duplicate", {
			jobId: existingJobId,
			mode: input.mode,
			companyName: input.companyName,
		});
		return {
			status: "already_queued",
			jobId: existingJobId,
			message: "Scraper job is already running",
		};
	}

	const jobId = newRunId();
	activeJobs.set(activeJobKey, jobId);
	logLine("job.queued", {
		jobId,
		mode: input.mode,
		companyName: input.companyName,
		hasCallbackUrl: Boolean(input.callbackUrl),
		hasLastError: Boolean(input.lastError),
	});

	void (async () => {
		const startedAt = performance.now();
		logLine("job.start", {
			jobId,
			mode: input.mode,
			companyName: input.companyName,
		});
		try {
			const result = await generateOrHealScraper({
				companyName: input.companyName,
				jobBoardUrl: input.jobBoardUrl,
				mode: input.mode,
				lastError: input.lastError,
			});
			logLine("job.complete", {
				jobId,
				mode: input.mode,
				companyName: input.companyName,
				status: result.status,
				companySlug: result.companySlug,
				logFile: basename(result.logPath),
				durationMs: Math.round(performance.now() - startedAt),
			});
			try {
				const didCall = await postCallback(input, result);
				if (didCall) {
					logLine("job.callback", {
						jobId,
						companyName: input.companyName,
						status: result.status === "failed" ? "failed" : "ready",
					});
				} else {
					logLine("job.callback_skipped", {
						jobId,
						companyName: input.companyName,
						reason: "missing callbackUrl",
					});
				}
			} catch (callbackError) {
				logLine("job.callback_failed", {
					jobId,
					error: callbackError instanceof Error ? callbackError.message : "Callback failed",
				});
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : "Background job failed";
			logLine("job.failed", {
				jobId,
				mode: input.mode,
				companyName: input.companyName,
				error: message,
				durationMs: Math.round(performance.now() - startedAt),
			});
			try {
				const didCall = await postCallback(input, { status: "failed", message });
				if (!didCall) {
					logLine("job.callback_skipped", {
						jobId,
						companyName: input.companyName,
						reason: "missing callbackUrl",
					});
				}
			} catch (callbackError) {
				logLine("job.callback_failed", {
					jobId,
					error: callbackError instanceof Error ? callbackError.message : "Callback failed",
				});
			}
		} finally {
			activeJobs.delete(activeJobKey);
		}
	})();

	return {
		status: "queued",
		jobId,
		message: "Scraper job queued",
	};
}

async function route(pathname: string, body: JsonRecord): Promise<JsonRecord> {
	if (pathname === "/healthz") {
		return { ok: true };
	}

	if (pathname === "/v1/has-scraper") {
		const companyName = text(body.companyName, "companyName");
		return { hasScraper: await scraperExists(companyName) };
	}

	if (pathname === "/v1/generate-scraper") {
		const companyName = text(body.companyName, "companyName");
		const jobBoardUrl = text(body.jobBoardUrl, "jobBoardUrl");
		return await generateOrHealScraper({ companyName, jobBoardUrl });
	}

	if (pathname === "/v1/generate-scraper/queue") {
		const companyName = text(body.companyName, "companyName");
		const jobBoardUrl = text(body.jobBoardUrl, "jobBoardUrl");
		return queueGenerateJob({
			companyName,
			jobBoardUrl,
			companyPageId: optionalText(body.companyPageId),
			callbackUrl: optionalText(body.callbackUrl),
			lastError: null,
			mode: "generate",
		});
	}

	if (pathname === "/v1/heal-scraper/queue") {
		const companyName = text(body.companyName, "companyName");
		const jobBoardUrl = text(body.jobBoardUrl, "jobBoardUrl");
		const lastError = text(body.lastError ?? body.hint, "lastError");
		return queueGenerateJob({
			companyName,
			jobBoardUrl,
			companyPageId: optionalText(body.companyPageId),
			callbackUrl: optionalText(body.callbackUrl),
			lastError,
			mode: "heal",
		});
	}

	if (pathname === "/v1/first-run") {
		const companyName = text(body.companyName, "companyName");
		const jobBoardUrl = text(body.jobBoardUrl, "jobBoardUrl");
		const runId = newRunId();
		const { slug, scraper } = await loadScraper(companyName);
		const result = await scraper.firstRun({
			runId,
			companyId: 0,
			companyName,
			companySlug: slug,
			boardUrl: jobBoardUrl,
			logger: createLogger(runId),
		});
		return { companySlug: slug, ...result };
	}

	if (pathname === "/v1/second-run") {
		const companyName = text(body.companyName, "companyName");
		const jobBoardUrl = text(body.jobBoardUrl, "jobBoardUrl");
		const jobUrl = text(body.jobUrl, "jobUrl");
		const runId = newRunId();
		const { slug, scraper } = await loadScraper(companyName);
		const result = await scraper.secondRun({
			runId,
			companyId: 0,
			companyName,
			companySlug: slug,
			boardUrl: jobBoardUrl,
			jobUrl,
			logger: createLogger(runId),
		});
		return { companySlug: slug, ...result };
	}

	throw Object.assign(new Error(`Unknown endpoint: ${pathname}`), {
		statusCode: 404,
	});
}

const server = http.createServer((req, res) => {
	void (async () => {
		const requestId = randomUUID();
		const startedAt = performance.now();
		const method = req.method ?? "UNKNOWN";
		const rawUrl = req.url ?? "/";
		const url = new URL(rawUrl, "http://localhost");
		const baseRequestLog = {
			method,
			pathname: url.pathname,
		};
		let requestBody: JsonRecord = {};
		let requestLogged = false;

		const logRequest = (): void => {
			logLine("request", {
				requestId,
				...baseRequestLog,
				...summarizeRequest(url.pathname, requestBody),
			});
			requestLogged = true;
		};

		const logResponse = (statusCode: number, payload: JsonRecord): void => {
			logLine("response", {
				requestId,
				...baseRequestLog,
				statusCode,
				durationMs: Math.round(performance.now() - startedAt),
				...summarizeResponse(payload),
			});
		};

		try {
			if (method !== "POST" && rawUrl !== "/healthz") {
				const payload = { error: "Method not allowed" };
				logRequest();
				sendJson(res, 405, payload);
				logResponse(405, payload);
				return;
			}
			requestBody = method === "POST" ? await readJson(req) : {};
			logRequest();
			const payload = await route(url.pathname, requestBody);
			sendJson(res, 200, payload);
			logResponse(200, payload);
		} catch (error) {
			const statusCode =
				typeof error === "object" &&
				error !== null &&
				"statusCode" in error &&
				typeof error.statusCode === "number"
					? error.statusCode
					: 500;
			const payload = {
				error: error instanceof Error ? error.message : "Unknown error",
			};
			if (!requestLogged) {
				logRequest();
			}
			sendJson(res, statusCode, payload);
			logResponse(statusCode, payload);
		}
	})();
});

const port = Number(process.env.PORT ?? 8787);
server.listen(port, "0.0.0.0", () => {
	logLine("server.start", { url: `http://localhost:${port}` });
});
