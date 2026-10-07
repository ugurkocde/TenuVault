import type { APIRoute } from 'astro';
// Same file the desktop app copies with Copy setup script, so the download never drifts from it.
import script from '../../../../resources/New-TenuVaultDesktopApp.ps1?raw';

export const GET: APIRoute = () =>
	new Response(script, {
		headers: { 'Content-Type': 'text/plain; charset=utf-8' },
	});
