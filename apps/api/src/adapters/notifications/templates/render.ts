import type { Severity } from '@workspace/audit-engine';
import type { NotificationMessage } from '../port';

/**
 * Provider-neutral renderers. Every template produces a `NotificationMessage`;
 * these three functions are the only place that message becomes bytes, so a
 * new event type never touches a provider and a new provider never touches a
 * template.
 */

export const SEVERITY_COLORS: Record<Severity | 'info', number> = {
	critical: 0xdc2626,
	high: 0xea580c,
	moderate: 0xd97706,
	low: 0x2563eb,
	info: 0x64748b,
};

export const SEVERITY_HEX: Record<Severity | 'info', string> = {
	critical: '#dc2626',
	high: '#ea580c',
	moderate: '#d97706',
	low: '#2563eb',
	info: '#64748b',
};

/* Discord's documented hard limits — exceeding any of them is a 400. */
const MAX_EMBEDS = 10;
const MAX_DESCRIPTION = 4096;
const MAX_TOTAL = 6000;
const MAX_TITLE = 256;

export function colorFor(severity: Severity | undefined): number {
	return SEVERITY_COLORS[severity ?? 'info'];
}

export function hexFor(severity: Severity | undefined): string {
	return SEVERITY_HEX[severity ?? 'info'];
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/** Trims to `max` on a character boundary, appending an ellipsis when cut. */
function clamp(value: string, max: number): string {
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

export function toPlainText(message: NotificationMessage): string {
	const parts: string[] = [message.title, '', message.summary];
	for (const section of message.sections) {
		parts.push('');
		if (section.heading !== undefined) parts.push(`${section.heading}:`);
		for (const line of section.lines) {
			const severity =
				line.severity === undefined
					? ''
					: `[${line.severity.toUpperCase()}] `;
			const url = line.url === undefined ? '' : ` (${line.url})`;
			parts.push(`  - ${severity}${line.text}${url}`);
		}
	}
	if (message.url !== undefined) parts.push('', message.url);
	if (message.footer !== undefined) parts.push('', message.footer);
	return `${parts.join('\n')}\n`;
}

/**
 * Inline styles only: every serious mail client strips `<style>` blocks and
 * none of them fetch external CSS, so there is nothing to gain from a
 * stylesheet and a broken layout to lose.
 */
export function toHtml(message: NotificationMessage): string {
	const accent = hexFor(message.severity);
	const html: string[] = [
		'<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#0f172a;max-width:640px">',
		`<h1 style="font-size:18px;margin:0 0 8px;border-left:4px solid ${accent};padding-left:10px">${escapeHtml(message.title)}</h1>`,
		`<p style="margin:0 0 16px;color:#334155">${escapeHtml(message.summary)}</p>`,
	];

	for (const section of message.sections) {
		if (section.heading !== undefined) {
			html.push(
				`<h2 style="font-size:14px;margin:16px 0 6px;color:#0f172a">${escapeHtml(section.heading)}</h2>`
			);
		}
		html.push(
			'<ul style="margin:0 0 12px;padding-left:18px;color:#334155">'
		);
		for (const line of section.lines) {
			const badge =
				line.severity === undefined
					? ''
					: `<strong style="color:${hexFor(line.severity)}">${escapeHtml(
							line.severity.toUpperCase()
						)}</strong> `;
			const text =
				line.url === undefined
					? escapeHtml(line.text)
					: `<a href="${escapeHtml(line.url)}" style="color:#2563eb">${escapeHtml(line.text)}</a>`;
			html.push(`<li style="margin:2px 0">${badge}${text}</li>`);
		}
		html.push('</ul>');
	}

	if (message.url !== undefined) {
		html.push(
			`<p style="margin:16px 0 0"><a href="${escapeHtml(message.url)}" style="display:inline-block;background:${accent};color:#ffffff;padding:8px 14px;border-radius:6px;text-decoration:none">Open in understory</a></p>`
		);
	}
	if (message.footer !== undefined) {
		html.push(
			`<p style="margin:20px 0 0;font-size:12px;color:#64748b">${escapeHtml(message.footer)}</p>`
		);
	}
	html.push('</div>');
	return html.join('\n');
}

export interface DiscordEmbed {
	title: string;
	url?: string;
	description: string;
	color: number;
	timestamp: string;
	footer?: { text: string };
}

/**
 * One embed for the head (summary) plus one per section, truncated to
 * Discord's ceilings. Anything dropped is reported as "+N more" rather than
 * silently lost, and the deep link in the head embed leads to the full list.
 */
export function toDiscordEmbeds(
	message: NotificationMessage,
	now: Date = new Date()
): DiscordEmbed[] {
	const timestamp = now.toISOString();
	const color = colorFor(message.severity);
	const head: DiscordEmbed = {
		title: clamp(message.title, MAX_TITLE),
		description: clamp(message.summary, MAX_DESCRIPTION),
		color,
		timestamp,
		...(message.url === undefined ? {} : { url: message.url }),
		...(message.footer === undefined
			? {}
			: { footer: { text: clamp(message.footer, 2048) } }),
	};

	const embeds: DiscordEmbed[] = [head];
	const sections = message.sections;
	// The head always costs one slot. If the sections do not all fit, one more
	// slot is reserved for the "+N more" notice — so nothing is ever dropped
	// silently just because the payload was one section too long.
	const shown =
		sections.length <= MAX_EMBEDS - 1 ? sections.length : MAX_EMBEDS - 2;

	for (let index = 0; index < shown; index += 1) {
		const section = sections[index];
		if (section === undefined) continue;
		const lines = section.lines.map((line) => {
			const severity =
				line.severity === undefined
					? ''
					: `\`${line.severity.toUpperCase()}\` `;
			return line.url === undefined
				? `• ${severity}${line.text}`
				: `• ${severity}[${line.text}](${line.url})`;
		});
		embeds.push({
			title: clamp(section.heading ?? 'Details', MAX_TITLE),
			description: clamp(lines.join('\n'), MAX_DESCRIPTION),
			color,
			timestamp,
		});
	}

	const dropped = sections.length - shown;
	if (dropped > 0) {
		embeds.push({
			title: `+${dropped} more`,
			description:
				message.url === undefined
					? `${dropped} further section(s) omitted.`
					: `${dropped} further section(s) omitted — [open the full report](${message.url}).`,
			color,
			timestamp,
		});
	}

	return enforceTotalBudget(embeds);
}

/**
 * Discord also caps the SUM of all textual fields at 6000 characters; trim
 * descriptions from the tail until the whole payload fits.
 */
function enforceTotalBudget(embeds: DiscordEmbed[]): DiscordEmbed[] {
	const size = (list: DiscordEmbed[]): number =>
		list.reduce(
			(total, embed) =>
				total +
				embed.title.length +
				embed.description.length +
				(embed.footer?.text.length ?? 0),
			0
		);

	for (
		let index = embeds.length - 1;
		index >= 0 && size(embeds) > MAX_TOTAL;
		index -= 1
	) {
		const embed = embeds[index];
		if (embed === undefined) continue;
		const excess = size(embeds) - MAX_TOTAL;
		const keep = Math.max(0, embed.description.length - excess - 8);
		embed.description =
			keep === 0 ? '…' : `${embed.description.slice(0, keep)}\n…`;
	}
	return embeds;
}
