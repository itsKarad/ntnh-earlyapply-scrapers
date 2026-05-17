import { spawn } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { validateScraper } from "./validate.js";
import { executableExists, findScraperSlug, newRunId } from "./runtime.js";
import { slugifyCompany } from "./slug.js";

type GenerateResult = {
	status: "generated" | "healed" | "failed";
	companySlug: string;
	message: string;
	logPath: string;
	publish?: PublishResult;
};

type GenerateMode = "generate" | "heal";
type PublishResult =
	| {
			status: "published";
			remoteUrl: string;
			branch: string;
			path: string;
	  }
	| {
			status: "skipped";
			reason: string;
			path: string;
	  };

const SCRAPER_GITHUB_REMOTE_URL =
	process.env.SCRAPER_GITHUB_REMOTE_URL ??
	"https://github.com/itsKarad/ntnh-earlyapply-scrapers";
const SCRAPER_GITHUB_BRANCH = process.env.SCRAPER_GITHUB_BRANCH ?? "main";

export async function resolveGeneratePlan(companyName: string): Promise<{
	mode: GenerateMode;
	companySlug: string;
}> {
	const existingSlug = await findScraperSlug(companyName);
	return {
		mode: existingSlug ? "heal" : "generate",
		companySlug: existingSlug ?? slugifyCompany(companyName),
	};
}

function buildPrompt(input: {
	companyName: string;
	companySlug: string;
	jobBoardUrl: string;
	mode: GenerateMode;
	lastError?: string | null;
}): string {
	const scraperDir = `generated_scrapers/${input.companySlug}`;
	const action =
		input.mode === "heal"
			? "Repair the existing generated scraper"
			: "Create a new generated scraper";

	return `
${action} for ${input.companyName}.

Official job board URL:
${input.jobBoardUrl}

${input.lastError ? `Failure hint from the previous run:\n${input.lastError}\n` : ""}
Rules:
- Edit only files under ${scraperDir}.
- Preserve the typed scraper API: firstRun(ctx) and secondRun(ctx).
- The scraper must return typed data only and must not write to any database.
- Keep logging through ctx.logger.
- Treat ctx.maxJobs as a hard upper bound.
- firstRun returns job list objects with at least url and a useful title when available.
- secondRun returns status "ok" with title, description, locations, tags, employment/workplace/salary/sponsorship fields when available, or status "removed" for closed postings.
- Validate with: npm run check

After editing, run npm run check and leave the files in place.
`.trim();
}

function shortCommand(command: string, args: string[]): string {
	if (command === "codex") {
		return `${command} ${args.slice(0, -1).join(" ")} <prompt>`;
	}
	return `${command} ${args.join(" ")}`;
}

function writeProcessChunk(command: string, stream: "stdout" | "stderr", chunk: Buffer): string {
	const text = chunk.toString();
	for (const line of text.split(/\r?\n/)) {
		if (!line.trim()) {
			continue;
		}
		const prefix = `[${new Date().toISOString()}] ${command}:${stream}`;
		const output = `${prefix} ${line}\n`;
		if (stream === "stderr") {
			process.stderr.write(output);
		} else {
			process.stdout.write(output);
		}
	}
	return text;
}

async function runProcess(
	command: string,
	args: string[],
	logPath: string,
): Promise<void> {
	const env = await buildProcessEnv();
	await fs.mkdir(path.dirname(logPath), { recursive: true });
	await fs.appendFile(
		logPath,
		`\n[${new Date().toISOString()}] $ ${shortCommand(command, args)}\n`,
		"utf8",
	);
	process.stdout.write(
		`[${new Date().toISOString()}] job process.start command="${shortCommand(command, args)}"\n`,
	);

	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: process.cwd(),
			env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			const text = writeProcessChunk(command, "stdout", chunk);
			stdout += text;
			void fs.appendFile(logPath, text, "utf8");
		});
		child.stderr.on("data", (chunk) => {
			const text = writeProcessChunk(command, "stderr", chunk);
			stderr += text;
			void fs.appendFile(logPath, text, "utf8");
		});
		child.on("error", reject);
		child.on("close", (code) => {
			process.stdout.write(
				`[${new Date().toISOString()}] job process.close command="${command}" exitCode=${code}\n`,
			);
			if (code === 0) {
				resolve();
				return;
			}
			reject(
				Object.assign(new Error(`${command} exited with code ${code}`), {
					stdout,
					stderr,
				}),
			);
		});
	});
}

async function runProcessExitCode(
	command: string,
	args: string[],
	logPath: string,
): Promise<number> {
	try {
		await runProcess(command, args, logPath);
		return 0;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const match = message.match(/exited with code (\d+)/);
		return match ? Number.parseInt(match[1], 10) : 1;
	}
}

async function buildProcessEnv(): Promise<NodeJS.ProcessEnv> {
	const home = process.env.HOME;
	const preferredDirs: string[] = [];

	if (home) {
		preferredDirs.push(path.join(home, ".local", "bin"));

		const localLibDir = path.join(home, ".local", "lib");
		try {
			const entries = await fs.readdir(localLibDir, {
				withFileTypes: true,
			});
			preferredDirs.push(
				...entries
					.filter(
						(entry) =>
							entry.isDirectory() &&
							entry.name.startsWith("node-"),
					)
					.map((entry) => path.join(localLibDir, entry.name, "bin"))
					.sort()
					.reverse(),
			);
		} catch {
			// The local node install path is optional.
		}
	}

	const inheritedPath = process.env.PATH ?? "";
	const pathEntries = [
		...preferredDirs,
		...inheritedPath.split(path.delimiter),
	]
		.filter(Boolean)
		.filter((entry, index, entries) => entries.indexOf(entry) === index);
	const usablePathEntries: string[] = [];

	for (const entry of pathEntries) {
		try {
			await fs.access(entry, fsConstants.X_OK);
			usablePathEntries.push(entry);
		} catch {
			// Skip missing or inaccessible path entries.
		}
	}

	return {
		...process.env,
		PATH: usablePathEntries.join(path.delimiter),
	};
}

function shouldPublishScrapers(): boolean {
	const value = process.env.SCRAPER_GITHUB_PUBLISH;
	return value === undefined || !["0", "false", "no"].includes(value.trim().toLowerCase());
}

async function ensureGithubRemote(logPath: string): Promise<void> {
	const hasOrigin = await runProcessExitCode("git", ["remote", "get-url", "origin"], logPath);
	if (hasOrigin === 0) {
		await runProcess("git", ["remote", "set-url", "origin", SCRAPER_GITHUB_REMOTE_URL], logPath);
		return;
	}
	await runProcess("git", ["remote", "add", "origin", SCRAPER_GITHUB_REMOTE_URL], logPath);
}

async function publishScraper(input: {
	companyName: string;
	companySlug: string;
	logPath: string;
}): Promise<PublishResult> {
	const scraperPath = path.posix.join("generated_scrapers", input.companySlug);
	if (!shouldPublishScrapers()) {
		return {
			status: "skipped",
			reason: "SCRAPER_GITHUB_PUBLISH is disabled",
			path: scraperPath,
		};
	}

	await ensureGithubRemote(input.logPath);
	await runProcess("git", ["branch", "-M", SCRAPER_GITHUB_BRANCH], input.logPath);
	await runProcess("git", ["add", "--", scraperPath], input.logPath);

	const noStagedChanges = await runProcessExitCode(
		"git",
		["diff", "--cached", "--quiet", "--", scraperPath],
		input.logPath,
	);
	if (noStagedChanges === 0) {
		return {
			status: "skipped",
			reason: "No scraper changes to commit",
			path: scraperPath,
		};
	}

	await runProcess(
		"git",
		[
			"commit",
			"--only",
			"-m",
			`chore(scraper): publish ${input.companySlug} scraper`,
			"--",
			scraperPath,
		],
		input.logPath,
	);
	await runProcess(
		"git",
		["push", "-u", "origin", `HEAD:${SCRAPER_GITHUB_BRANCH}`],
		input.logPath,
	);

	return {
		status: "published",
		remoteUrl: SCRAPER_GITHUB_REMOTE_URL,
		branch: SCRAPER_GITHUB_BRANCH,
		path: scraperPath,
	};
}

export async function generateOrHealScraper(input: {
	companyName: string;
	jobBoardUrl: string;
	mode?: GenerateMode;
	lastError?: string | null;
}): Promise<GenerateResult> {
	const plan = await resolveGeneratePlan(input.companyName);
	const companySlug = plan.companySlug;
	const mode = input.mode ?? plan.mode;
	const runId = newRunId();
	const logPath = path.join(process.cwd(), "var", "logs", `${runId}-generate.log`);

	if (!(await executableExists("codex"))) {
		return {
			status: "failed",
			companySlug,
			message: "codex executable was not found on PATH",
			logPath,
		};
	}

	try {
		await runProcess(
			"codex",
			[
				"-a",
				"never",
				"-s",
				"workspace-write",
				"exec",
				"--skip-git-repo-check",
				buildPrompt({
					companyName: input.companyName,
					companySlug,
					jobBoardUrl: input.jobBoardUrl,
					mode,
					lastError: input.lastError,
				}),
			],
			logPath,
		);
		await runProcess("npm", ["run", "check"], logPath);
		const validation = await validateScraper({
			companyName: input.companyName,
			jobBoardUrl: input.jobBoardUrl,
			maxJobs: 3,
		});
		const publish = await publishScraper({
			companyName: input.companyName,
			companySlug,
			logPath,
		});

		return {
			status: mode === "heal" ? "healed" : "generated",
			companySlug,
			message: validation.message,
			logPath,
			publish,
		};
	} catch (error) {
		return {
			status: "failed",
			companySlug,
			message: error instanceof Error ? error.message : "Scraper generation failed",
			logPath,
		};
	}
}
