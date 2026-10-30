import type { APIRoute } from 'astro';
// Same file the repository ships, so the download never drifts from it.
import script from '../../../../resources/New-TenuVaultCloudBackup.ps1?raw';

export const GET: APIRoute = () =>
	new Response(script, {
		headers: { 'Content-Type': 'text/plain; charset=utf-8' },
	});
