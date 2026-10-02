// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';
import starlightLlmsTxt from 'starlight-llms-txt';
import rehypeTableWrap from './src/plugins/rehype-table-wrap.mjs';

export default defineConfig({
	site: 'https://docs.tenuvault.com',
	trailingSlash: 'always',
	// Vercel redirects / in vercel.json; this keeps local preview and other hosts in sync.
	redirects: { '/': '/getting-started/' },
	markdown: {
		rehypePlugins: [rehypeTableWrap],
	},
	integrations: [
		starlight({
			title: 'TenuVault Docs',
			description: 'Intune backup, restore and drift detection that runs entirely on your machine.',
			logo: {
				light: './src/assets/logo-light.svg',
				dark: './src/assets/logo-dark.svg',
				alt: 'TenuVault',
			},
			favicon: '/favicon.svg',
			head: [
				{ tag: 'link', attrs: { rel: 'icon', href: '/favicon.ico', sizes: '32x32' } },
				{ tag: 'link', attrs: { rel: 'icon', type: 'image/png', href: '/favicon-32.png', sizes: '32x32' } },
				{ tag: 'link', attrs: { rel: 'apple-touch-icon', href: '/apple-touch-icon.png' } },
				{ tag: 'meta', attrs: { name: 'theme-color', content: '#fdfcfb', media: '(prefers-color-scheme: light)' } },
				{ tag: 'meta', attrs: { name: 'theme-color', content: '#111010', media: '(prefers-color-scheme: dark)' } },
			],
			customCss: ['@fontsource-variable/geist', '@fontsource-variable/geist-mono', './src/styles/custom.css'],
			expressiveCode: {
				// Warm, low contrast syntax themes; frames are plain rounded fills with no terminal chrome.
				themes: ['vitesse-dark', 'vitesse-light'],
				defaultProps: { frame: 'code' },
				styleOverrides: {
					borderRadius: '1rem',
					borderWidth: '0px',
					codeBackground: 'var(--tv-code-bg)',
					codeFontFamily: 'var(--__sl-font-mono)',
					codeFontSize: '0.8125rem',
					codeLineHeight: '1.7',
					codePaddingBlock: '1rem',
					codePaddingInline: '1.25rem',
					uiFontFamily: 'var(--__sl-font)',
					frames: {
						frameBoxShadowCssValue: 'none',
						editorBackground: 'var(--tv-code-bg)',
						editorTabBarBackground: 'var(--tv-code-bar)',
						editorActiveTabBackground: 'var(--tv-code-bg)',
						editorActiveTabIndicatorTopColor: 'transparent',
						editorActiveTabIndicatorBottomColor: 'transparent',
						editorTabBarBorderBottomColor: 'transparent',
						terminalBackground: 'var(--tv-code-bg)',
						terminalTitlebarBackground: 'var(--tv-code-bar)',
						terminalTitlebarBorderBottomColor: 'transparent',
						inlineButtonBackground: 'var(--sl-color-gray-4)',
						tooltipSuccessBackground: 'var(--sl-color-white)',
						tooltipSuccessForeground: 'var(--sl-color-black)',
					},
				},
			},
			social: [
				{ icon: 'github', label: 'GitHub', href: 'https://github.com/ugurkocde/TenuVault' },
			],
			components: {
				SocialIcons: './src/components/HeaderLinks.astro',
				PageTitle: './src/components/PageTitle.astro',
				SiteTitle: './src/components/SiteTitle.astro',
			},
			lastUpdated: false,
			plugins: [starlightLinksValidator(), starlightLlmsTxt()],
			// Mirrors docs/gitbook/SUMMARY.md.
			sidebar: [
				{
					label: 'Get started',
					items: [
						{ label: 'Overview', slug: 'getting-started' },
						{ label: 'Requirements', slug: 'getting-started/requirements' },
						{ label: 'Install and update TenuVault', slug: 'getting-started/install' },
						{ label: 'Create the app registration', slug: 'getting-started/app-registration' },
						{ label: 'Choose a plan on first launch', slug: 'getting-started/first-launch' },
						{ label: 'Sign in to your tenant', slug: 'getting-started/connect-tenant' },
						{ label: 'Choose where backups are stored', slug: 'getting-started/choose-storage' },
						{ label: 'Run your first backup', slug: 'getting-started/first-backup' },
					],
				},
				{
					label: 'Security',
					items: [
						{ label: 'Overview', slug: 'security' },
						{ label: 'App registration and delegated permissions', slug: 'security/permissions' },
						{ label: 'Network connections and data flows', slug: 'security/data-flows' },
						{ label: 'Encryption and recovery key', slug: 'security/encryption' },
					],
				},
				{
					label: 'Use TenuVault',
					items: [
						{ label: 'Manage tenants', slug: 'tenants' },
						{
							label: 'Run a backup',
							collapsed: true,
							items: [
								{ label: 'Overview', slug: 'backups' },
								{ label: 'What gets backed up', slug: 'backups/coverage' },
								{ label: 'Schedule backups', slug: 'backups/schedules' },
								{ label: 'Backup storage and retention', slug: 'backups/storage' },
								{ label: 'Compare backups', slug: 'backups/compare' },
							],
						},
						{
							label: 'Restore items',
							collapsed: true,
							items: [
								{ label: 'Overview', slug: 'restore' },
								{ label: 'Restore modes and assignments', slug: 'restore/modes' },
								{ label: 'Restore to another tenant', slug: 'restore/cross-tenant' },
								{ label: 'What cannot be restored', slug: 'restore/limitations' },
								{ label: 'Disaster recovery', slug: 'restore/disaster-recovery' },
							],
						},
						{ label: 'Drift detection', slug: 'drift' },
						{ label: 'Audit log', slug: 'audit-log' },
						{ label: 'OpenIntuneBaseline', slug: 'baselines/quick-start' },
						{ label: 'My baselines', slug: 'baselines/custom-baselines' },
						{ label: 'Framework coverage', slug: 'baselines/frameworks' },
					],
				},
				{
					label: 'Administration',
					items: [
						{
							label: 'Plans and features',
							collapsed: true,
							items: [
								{ label: 'Overview', slug: 'licensing' },
								{ label: 'Activate and manage your license', slug: 'licensing/manage' },
							],
						},
						{ label: 'Settings reference', slug: 'settings' },
						{ label: 'Deploy TenuVault in your organization', slug: 'deploy' },
					],
				},
				{
					label: 'Help',
					items: [
						{ label: 'Troubleshooting', slug: 'troubleshooting' },
					],
				},
			],
		}),
	],
});
