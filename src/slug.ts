export function slugifyCompany(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

export function canonicalizeJobUrl(input: string): string {
	const trackingParams = new Set([
		"utm_source",
		"utm_medium",
		"utm_campaign",
		"utm_term",
		"utm_content",
		"gh_src",
		"source",
		"src",
		"ref",
		"referrer",
		"lever-origin",
	]);
	const url = new URL(input);
	url.hash = "";

	for (const key of [...url.searchParams.keys()]) {
		if (trackingParams.has(key) || key.startsWith("utm_")) {
			url.searchParams.delete(key);
		}
	}

	const sortedParams = [...url.searchParams.entries()].sort(([left], [right]) =>
		left.localeCompare(right),
	);
	url.search = "";
	for (const [key, value] of sortedParams) {
		url.searchParams.append(key, value);
	}

	url.pathname = url.pathname.replace(/\/+$/, "") || "/";
	return url.toString();
}
