export function listNames(names: readonly string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names[0] ?? ""
}

export function needsAccessText(names: readonly string[]): string {
  return `${listNames(names)} ${names.length === 1 ? "needs" : "need"} more access.`
}

export function StartNowAccessHelp() {
  return <p className="text-sm text-gray-600">Start now uses the access your tenant already gives Microsoft Graph Command Line Tools. To add backup access, switch to your own app registration or use the TenuVault app where available.</p>
}
