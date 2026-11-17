import { parseConnectLink, type ConnectLinkState, type PendingConnectLink } from "../shared/deep-link"

/** Windows supplies the protocol URL as a separate argument, sometimes with literal quotes. */
export function connectLinksFromArgv(argv: readonly string[]): string[] {
  return argv.map(value => value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value)
    .filter(value => /^tenuvault:/i.test(value))
}

/** Memory only. A reload may read the same link until the admin dismisses or accepts it. */
export class ConnectLinkIntake {
  private pending: PendingConnectLink | null = null
  private rejected = false
  private sequence = 0

  constructor(private readonly notify: () => void, private readonly focus: () => void) {}

  accept(raw: string): void {
    const details = parseConnectLink(raw)
    if (details) this.pending = { id: ++this.sequence, details }
    else this.rejected = true
    this.focus()
    this.notify()
  }

  argv(argv: readonly string[]): boolean {
    const links = connectLinksFromArgv(argv)
    for (const link of links) this.accept(link)
    return links.length > 0
  }

  take(): ConnectLinkState {
    return { pending: this.pending, rejected: this.rejected }
  }

  dismissRejection(): void {
    this.rejected = false
  }

  dismiss(id: unknown): void {
    if (id === this.pending?.id) this.pending = null
  }
}

export function shouldRegisterProtocol(packaged: boolean, optIn: string | undefined): boolean {
  return packaged || optIn === "1"
}
