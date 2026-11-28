import type { PermissionPack } from "./services/permission-packs"

export const PACK_CONSENT_ERRORS = {
  AADSTS65001: "Ask a tenant administrator to approve the missing permission pack.",
  AADSTS65004: "Consent was declined. Try again or send the pack to your administrator.",
  AADSTS90094: "An administrator must approve this pack. Use Send to my admin.",
  AADSTS90095: "Use Request approval to open Microsoft's admin consent workflow, if your tenant enables it.",
  AADSTS50105: "Ask your Entra administrator to assign your account to the TenuVault enterprise app.",
  AADSTS53000: "Use a device that meets your tenant's compliance requirements.",
  AADSTS53001: "Use a device joined to the domain required by your tenant.",
  AADSTS53003: "Ask your Entra administrator to identify the Conditional Access policy in the sign-in logs.",
  AADSTS50076: "Sign in again and complete multifactor authentication.",
  AADSTS50079: "Register for multifactor authentication, then sign in again.",
  AADSTS700016: "Confirm the tenant ID and ask your administrator to check whether the TenuVault enterprise app is available.",
  AADSTS500011: "Ask your administrator to check that the API named in the pack is available in this tenant.",
  AADSTS50011: "Contact TenuVault support to check the registered redirect URI.",
  AADSTS7000218: "Contact TenuVault support to check the public-client configuration.",
  AADSTS50020: "Sign in with an account that belongs to this tenant or has accepted a guest invitation.",
  AADSTS90072: "Ask your administrator to invite this account to the tenant or sign in with a tenant account.",
  AADSTS650057: "Ask your administrator to check the API permissions for this pack, then try again.",
  AADSTS7000112: "Ask your administrator whether the TenuVault enterprise app can be enabled for sign-in.",
  AADSTS7000229: "Ask your administrator to approve the TenuVault app in this tenant.",
  AADSTS90002: "Check the tenant ID and try again.",
  AADSTS900023: "Check the tenant ID and try again.",
  graph_forbidden: "Ask your administrator to check your Microsoft role for this service. The permission pack alone does not grant that role.",
  intune_unlicensed: "Check the tenant's Intune license and the account's Intune access before trying again.",
} as const

export type PackConsentCode = keyof typeof PACK_CONSENT_ERRORS
export interface PackConsentIssue { code: string; message: string }
export type PackConsentResult =
  | { status: "received" | "verified" }
  | { status: "waiting"; issue?: PackConsentIssue }
  | { status: "handoff"; url: string; message: string }
  | { status: "error"; issue: PackConsentIssue }
export interface PackConsentPlan { packs: PermissionPack[] }
export type PackConsentAction = "open" | "handoff" | "request" | "check"
