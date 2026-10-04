// @ts-check
import { defineConfig } from 'astro/config';
import starlight from '@astrojs/starlight';
import starlightLinksValidator from 'starlight-links-validator';
import starlightLlmsTxt from 'starlight-llms-txt';
import rehypeTableWrap from './src/plugins/rehype-table-wrap.mjs';
import remarkFaq from './src/plugins/remark-faq.mjs';

export default defineConfig({
	site: 'https://docs.tenuvault.com',
	trailingSlash: 'always',
	// Vercel redirects / in vercel.json; this keeps local preview and other hosts in sync.
	redirects: { '/': '/getting-started/' },
	markdown: {
		remarkPlugins: [remarkFaq],
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
				{ tag: 'meta', attrs: { property: 'og:image', content: 'https://docs.tenuvault.com/og-image.png' } },
				{ tag: 'meta', attrs: { property: 'og:image:width', content: '1200' } },
				{ tag: 'meta', attrs: { property: 'og:image:height', content: '630' } },
				{ tag: 'meta', attrs: { property: 'og:image:alt', content: 'TenuVault Desktop: OpenIntuneBaseline, backup, restore and drift detection for Windows and macOS' } },
				{ tag: 'meta', attrs: { name: 'twitter:card', content: 'summary_large_image' } },
				{ tag: 'meta', attrs: { name: 'twitter:image', content: 'https://docs.tenuvault.com/og-image.png' } },
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
				Head: './src/components/Head.astro',
				SocialIcons: './src/components/HeaderLinks.astro',
				PageTitle: './src/components/PageTitle.astro',
				SiteTitle: './src/components/SiteTitle.astro',
			},
			lastUpdated: true,
			plugins: [
				starlightLinksValidator(),
				starlightLlmsTxt({
					projectName: 'TenuVault',
					description:
						'TenuVault is a desktop app for Windows and macOS that backs up and restores Microsoft Intune configuration through Microsoft Graph using the admin\'s own delegated sign-in.',
					details: [
						'Key facts:',
						'',
						'- Product: TenuVault Desktop. Features: Intune backup, restore, drift detection between backups, OpenIntuneBaseline deployment, comparison and validation, and framework comparisons.',
						'- History: the first versions of TenuVault were a free PowerShell script and a hosted web portal. TenuVault Desktop, released in October 2026, is the current product for new users; the web portal remains available for existing users. This documentation covers TenuVault Desktop only.',
						'- Sign-in: delegated sign-in with the admin\'s own account through an app registration in the customer\'s tenant (a public client with no secret). MFA and Conditional Access apply, and changes are attributed to the admin in the Intune and Entra audit logs.',
						'- Coverage: 39 Intune object types in nine areas, with their assignments where Intune has them. App installer files, Apple tokens and private keys cannot be exported by Microsoft Graph and are not in backups.',
						'- Storage: backups are encrypted on the device (a local folder or a network share) on every plan, or in the customer\'s own Azure storage account on Pro and MSP. Backups are never sent to a TenuVault server.',
						'- Encryption: AES-256-GCM on the admin\'s machine before backups are written or uploaded, with a key protected by Windows DPAPI or the macOS Keychain. A recovery key lets backups be read on another device.',
						'- Plans: Community is free for one tenant and needs no license key (manual and weekly scheduled backups, backup history up to 30 days, restore one item as a copy). Pro covers 2 tenants and adds daily schedules, Azure storage, history from 7 to 365 days or forever, bulk restore, replace in place and assignment restore. MSP covers the subscribed number of tenants (new subscriptions include 5) and adds the cross tenant dashboard and actions across several tenants. Pro and MSP include a 30-day money-back guarantee; each tenant can be active on up to 5 installations.',
						'- Product overview: [Intune backup with TenuVault](https://www.tenuvault.com/intune-backup). Plans and prices: [TenuVault pricing](https://www.tenuvault.com/pricing).',
					].join('\n'),
				}),
			],
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
