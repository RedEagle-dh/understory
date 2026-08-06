/** Deep links into the web UI. `baseUrl` is `env.APP_URL` (no trailing slash). */

function trim(baseUrl: string): string {
	return baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
}

export function vulnerabilitiesUrl(baseUrl: string, projectId: string): string {
	return `${trim(baseUrl)}/projects/${projectId}/vulnerabilities`;
}

export function dependenciesUrl(baseUrl: string, projectId: string): string {
	return `${trim(baseUrl)}/projects/${projectId}/dependencies`;
}

export function projectUrl(baseUrl: string, projectId: string): string {
	return `${trim(baseUrl)}/projects/${projectId}`;
}

export function scanUrl(baseUrl: string, scanId: string): string {
	return `${trim(baseUrl)}/scans/${scanId}`;
}

export function advisoryUrl(baseUrl: string, advisoryId: string): string {
	return `${trim(baseUrl)}/advisories/${advisoryId}`;
}

export function pullRequestsUrl(baseUrl: string, projectId: string): string {
	return `${trim(baseUrl)}/projects/${projectId}/pull-requests`;
}
