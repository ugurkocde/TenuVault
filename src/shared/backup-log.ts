/** Masks email addresses and UPNs while keeping the surrounding diagnostic text readable. */
export function maskBackupAccountIdentifiers(text: string): string {
  return text.replace(/(?<![\p{L}\p{N}._%+!#$&*=^`{|}~-])(?<![\p{L}\p{N}]')[\p{L}\p{N}_%+!#$&*=^`{|}~-]+(?:[.'][\p{L}\p{N}_%+!#$&*=^`{|}~-]+)*@[\p{L}\p{N}]+(?:[.-][\p{L}\p{N}]+)*/gu, "[redacted]")
}
