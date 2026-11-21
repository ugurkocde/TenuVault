import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parse } from "@babel/parser"
import type { Node } from "@babel/types"
import { expect, it } from "vitest"

const methods = new Set(["POST", "PATCH", "PUT", "DELETE"])
const roots = ["src/main", "src/portal/app/api", "src/portal/lib", "src/shared/intune"]

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? files(path) : entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts") ? [path] : []
  })
}

const literal = (node?: Node | null) => node?.type === "StringLiteral" ? node.value : undefined

function methodProperty(node?: Node): Node | undefined {
  if (node?.type !== "ObjectExpression") return undefined
  for (const prop of node.properties) {
    if (prop.type === "ObjectProperty" && (prop.key.type === "Identifier" ? prop.key.name : literal(prop.key)) === "method") return prop.value
  }
  return undefined
}

const isNode = (value: unknown): value is Node => !!value && typeof value === "object" && "type" in value && typeof value.type === "string"

/**
 * Scan all main and in-process routes, including POST actions and generic dispatch sites.
 * Non-Graph sends using the same call patterns are recorded too, so a new transport is
 * visible before it can be used for a configuration write.
 */
it("inventories mutation and network dispatch sites for tenant approval review", async () => {
  const inventory: string[] = []
  for (const path of roots.flatMap(files).sort()) {
    const source = readFileSync(path, "utf8")
    const text = (node: Node) => source.slice(node.start!, node.end!).replace(/\s+/g, " ").trim()
    const file = parse(source, { sourceType: "module", plugins: ["typescript"] })
    const visit = (node: Node) => {
      if (node.type === "CallExpression" || node.type === "OptionalCallExpression" || node.type === "NewExpression") {
        const callee = text(node.callee)
        const [first, second] = node.arguments
        const method = methodProperty(second) ?? methodProperty(first)
        const indicator = literal(first)
        const transport = /(?:^|\.)(?:[A-Za-z]*fetch[A-Za-z]*|[A-Za-z]*graph[A-Za-z]*|request|dispatch)$/i.test(callee)
        if (indicator && methods.has(indicator)) inventory.push(`${path}: ${callee}(${indicator}, ${second ? text(second) : ""})`)
        else if (first && second && !indicator && /(?:^|\.)(?:method|verb)$/i.test(text(first))) {
          inventory.push(`${path}: ${callee}(${text(first)}, ${text(second)})`)
        }
        else if (method && (transport || methods.has(literal(method) ?? ""))) {
          const destination = methodProperty(first) ? "" : first ? text(first) : ""
          inventory.push(`${path}: ${callee}(${destination}) method ${text(method)}`)
        } else if (transport && first && (literal(method) !== "GET") && /fetch|request|dispatch/i.test(callee)) {
          inventory.push(`${path}: ${callee}(${text(first)}${second ? ", " + text(second).slice(0, 100) : ""})`)
        }
      }
      for (const value of Object.values(node)) {
        if (isNode(value)) visit(value)
        else if (Array.isArray(value)) for (const child of value) if (isNode(child)) visit(child)
      }
    }
    visit(file)
  }
  await expect(inventory.sort().join("\n") + "\n").toMatchFileSnapshot("./fixtures/write-approval-dispatch-inventory.txt")
})
