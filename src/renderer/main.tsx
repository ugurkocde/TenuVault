import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { bridge } from "./lib/bridge"
import { installFetchBridge } from "./lib/fetch-bridge"
import { replaceAlerts } from "./lib/toast"
import "./desktop.css"

window.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled promise rejection:", event.reason)
})

installFetchBridge(bridge)
replaceAlerts()

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
