import type { APIRoute } from 'astro';
// Same file the repository ships for Azure administrators, so the download never drifts from it.
import script from '../../../../resources/New-TenuVaultStorage.ps1?raw';

export const GET: APIRoute = () =>
	new Response(script, {
		headers: { 'Content-Type': 'text/plain; charset=utf-8' },
	});
