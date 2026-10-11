import { Component, type ErrorInfo, type ReactNode } from "react"
import { Button } from "~/components/ui/button"

export function ErrorPanel({ title, message, children }: { title: string; message: string; children: ReactNode }) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center bg-background p-6">
      <div role="alert" className="w-full max-w-lg space-y-4 rounded-3xl bg-card p-9 shadow-[0_24px_60px_-30px_rgba(22,21,20,0.25)]">
        <h1 className="text-2xl font-medium tracking-tight text-foreground">{title}</h1>
        <p className="break-words text-sm text-muted-foreground">{message}</p>
        <div className="flex flex-wrap gap-3">{children}</div>
      </div>
    </div>
  )
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Screen failed to render:", error, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <ErrorPanel title="This screen could not be loaded" message={this.state.error.message}>
          <Button type="button" onClick={() => this.setState({ error: null })}>Try again</Button>
          <Button type="button" variant="outline" onClick={() => window.location.reload()}>Reload</Button>
        </ErrorPanel>
      )
    }
    return this.props.children
  }
}
