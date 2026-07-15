import { readFile } from "node:fs/promises"

export const agentDefinitions = Object.freeze({
  sol: {
    description: "Sole task owner that defaults bounded execution to managed workers and owns final verification",
    mode: "primary",
    permission: { task: { "*": "deny", "luna-medium": "allow", "luna-max": "allow", "terra-medium": "allow", "terra-max": "allow" }, report_to_parent: "deny", "agents_*": "allow" },
  },
  "luna-medium": { description: "Clear low-risk leaf work on one surface with an obvious method and easily checked result", mode: "subagent", permission: { task: "deny", todowrite: "deny", "agents_*": "deny", report_to_parent: "allow" } },
  "luna-max": { description: "Narrow leaf work requiring careful multi-step investigation, adversarial checking, or precise verification", mode: "subagent", permission: { task: "deny", todowrite: "deny", "agents_*": "deny", report_to_parent: "allow" } },
  "terra-medium": { description: "Leaf work needing stronger interpretation or cross-file execution within one known subsystem", mode: "subagent", permission: { task: "deny", todowrite: "deny", "agents_*": "deny", report_to_parent: "allow" } },
  "terra-max": { description: "Difficult bounded leaf work with genuine ambiguity, meaningful regression risk, or competing implementation choices", mode: "subagent", permission: { task: "deny", todowrite: "deny", "agents_*": "deny", report_to_parent: "allow" } },
})

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

export function mergeAgentDefinition(defaultAgent, userAgent) {
  if (userAgent === undefined) return defaultAgent
  if (!isObject(userAgent)) return userAgent
  const merged = { ...defaultAgent, ...userAgent }
  if (isObject(defaultAgent.permission) && isObject(userAgent.permission)) {
    merged.permission = { ...defaultAgent.permission, ...userAgent.permission }
    if (isObject(defaultAgent.permission.task) && isObject(userAgent.permission.task)) {
      merged.permission.task = { ...defaultAgent.permission.task, ...userAgent.permission.task }
    }
  }
  return merged
}

export async function defaultAgents() {
  return Object.fromEntries(await Promise.all(Object.entries(agentDefinitions).map(async ([name, definition]) => [
    name,
    { ...definition, prompt: await readFile(new URL(`./agents/${name}.md`, import.meta.url), "utf8") },
  ])))
}
