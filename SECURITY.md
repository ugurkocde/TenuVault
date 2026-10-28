# Security Policy

## Supported versions

Security fixes are released for the latest stable version of TenuVault Desktop. Nightly builds
preview the next stable version and receive fixes as they are merged to `main`.

| Version | Supported |
|---|---|
| Latest stable release | Yes |
| Latest nightly build | Yes |
| Older releases | No, please update |

The app updates itself from GitHub releases. You can always find the newest version on the
[release page](https://github.com/ugurkocde/TenuVault/releases/latest).

## Reporting a vulnerability

Please do not report security vulnerabilities through public GitHub issues, discussions or pull
requests.

Report them privately through GitHub instead:
[open a private security advisory](https://github.com/ugurkocde/TenuVault/security/advisories/new).
If you cannot use GitHub, email [support@ugurlabs.com](mailto:support@ugurlabs.com) with
"Security" in the subject line.

Please include as much of the following as you can:

- The affected version and operating system (Windows or macOS)
- The type of issue, for example token exposure, backup decryption, privilege escalation or
  remote code execution
- Steps to reproduce, or a proof of concept
- The impact, including what an attacker would need (local access, a malicious backup file, a
  compromised network and so on)

Do not include real tenant data, access tokens or other secrets in your report.

## What to expect

- We acknowledge your report within 3 business days.
- We send an initial assessment within 10 business days, and keep you updated while we work on a
  fix.
- Once a fix is released, we publish a security advisory and credit you, unless you prefer to stay
  anonymous.

Please give us a reasonable amount of time to release a fix before disclosing the issue publicly.

## Scope

In scope:

- TenuVault Desktop for Windows and macOS, built from this repository
- The release and auto-update pipeline of this repository
- The tenuvault.com license service used by the app

Out of scope:

- Vulnerabilities in Microsoft Entra ID, Microsoft Graph, Intune or Azure themselves (report these
  to the [Microsoft Security Response Center](https://msrc.microsoft.com/report/))
- Issues that require an already compromised device or administrator account
- Denial of service, spam and social engineering
- Reports from automated scanners without a demonstrated impact

## Safe harbor

We will not pursue legal action against researchers who act in good faith, follow this policy,
avoid privacy violations and service disruption, and only test against tenants and devices they
own or are authorized to test.
