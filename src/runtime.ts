import { randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type {
	CompanyScraperModule,
	ScraperLogger,
} from "../app/service/scraper-types.js";
import { slugifyCompany } from "./slug.js";

const GENERATED_SCRAPER_DIR = path.join(process.cwd(), "generated_scrapers");
const LOG_DIR = path.join(process.cwd(), "var", "logs");

export function newRunId(): string {
	return randomUUID();
}

export function scraperPathForSlug(slug: string): string {
	return path.join(GENERATED_SCRAPER_DIR, slug, "index.ts");
}

export async function findScraperSlug(companyName: string): Promise<string | null> {
	const requestedSlug = slugifyCompany(companyName);
	try {
		const entries = await fs.readdir(GENERATED_SCRAPER_DIR, {
			withFileTypes: true,
		});
		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}
			if (slugifyCompany(entry.name) !== requestedSlug) {
				continue;
			}
			try {
				await fs.access(path.join(GENERATED_SCRAPER_DIR, entry.name, "index.ts"));
				return entry.name;
			} catch {
				return null;
			}
		}
		return null;
	} catch {
		return null;
	}
}

export async function scraperExists(companyName: string): Promise<boolean> {
	return (await findScraperSlug(companyName)) !== null;
}

export function createLogger(runId: string): ScraperLogger {
	const compact = (value: Record<string, unknown>): string =>
		Object.entries(value)
			.filter(([, fieldValue]) => fieldValue !== undefined && fieldValue !== null && fieldValue !== "")
			.map(([key, fieldValue]) => `${key}=${JSON.stringify(fieldValue)}`)
			.join(" ");

	const write = async (
		level: "info" | "warn" | "error",
		message: string,
		metadata: Record<string, unknown> = {},
	): Promise<void> => {
		await fs.mkdir(LOG_DIR, { recursive: true });
		const entry = {
			timestamp: new Date().toISOString(),
			runId,
			level,
			message,
			metadata,
		};
		await fs.appendFile(
			path.join(LOG_DIR, `${runId}.jsonl`),
			`${JSON.stringify(entry)}\n`,
			"utf8",
		);
		console.log(
			`[${entry.timestamp}] scraper.${level} runId=${JSON.stringify(runId)} message=${JSON.stringify(message)}${compact(metadata) ? ` ${compact(metadata)}` : ""}`,
		);
	};

	return {
		info: (message, metadata) => write("info", message, metadata),
		warn: (message, metadata) => write("warn", message, metadata),
		error: (message, metadata) => write("error", message, metadata),
	};
}

export async function loadScraper(
	companyName: string,
): Promise<{ slug: string; scraper: CompanyScraperModule }> {
	const slug = await findScraperSlug(companyName);
	if (!slug) {
		throw new Error(`No generated scraper found for ${companyName}`);
	}

	const moduleUrl = `${pathToFileURL(scraperPathForSlug(slug)).toString()}?cacheBust=${Date.now()}`;
	const mod = (await import(moduleUrl)) as Partial<CompanyScraperModule>;
	if (
		typeof mod.firstRun !== "function" ||
		typeof mod.secondRun !== "function"
	) {
		throw new Error(`Generated scraper for ${companyName} must export firstRun and secondRun`);
	}

	return {
		slug,
		scraper: {
			firstRun: mod.firstRun,
			secondRun: mod.secondRun,
		},
	};
}

export async function executableExists(command: string): Promise<boolean> {
	const pathValue = process.env.PATH ?? "";
	for (const dir of pathValue.split(path.delimiter)) {
		try {
			await fs.access(path.join(dir, command), fsConstants.X_OK);
			return true;
		} catch {
			// Keep looking.
		}
	}
	return false;
}
