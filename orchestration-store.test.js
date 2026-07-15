import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import * as nodeFS from "node:fs/promises"
import { mkdtemp, mkdir, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"
import { OrchestrationState } from "./orchestration-state.js"
import { OrchestrationStore, OrchestrationStoreError, resolveStatePath } from "./orchestration-store.js"

const parentID = "parent-1"
const taskID = "task-1"
const temporaryDirectory = async (run) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-sol-orchestrator-"))
  try { return await run(directory) } finally { await rm(directory, { recursive: true, force: true }) }
}
const statePathFor = (directory) => path.join(directory, "private", "state.json")
const checkpoint = (state, kind = "evidence", summary = kind, promptID) => state.deliver(parentID, { task_id: taskID, kind, summary, ...(promptID ? { prompt_id: promptID } : {}), files: [], needs_decision: false })

test("persists exact protocol truth across a fresh store instance", async () => temporaryDirectory(async (directory) => {
  let clock = 1_000
  const statePath = statePathFor(directory)
  const options = { statePath, now: () => clock, thresholds: { steeringUnacknowledgedMs: 10, firstCheckpointMs: 20, checkpointStaleMs: 30 } }
  const first = new OrchestrationStore(options)
  await first.mutate((state) => {
    state.registerTask(parentID, taskID)
    const prompt = state.reservePrompt(parentID, taskID)
    state.admitPrompt(parentID, taskID, prompt)
    state.markPromptStarted(parentID, taskID, prompt.message_id)
    const acknowledgement = checkpoint(state, "acknowledgement", "Acknowledged", prompt.prompt_id)
    checkpoint(state, "evidence", "Observed")
    const completion = checkpoint(state, "completion", "Complete")
    state.consumeThrough(parentID, taskID, acknowledgement.checkpoint.checkpoint_id)
    assert.equal(completion.checkpoint.checkpoint_id, "cp_v1_000000000003")
  })

  clock = 1_031
  const restored = new OrchestrationStore(options)
  const observed = await restored.read((state) => ({
    cursor: state.cursor(parentID, taskID),
    turn: state.turn(parentID, taskID),
    lifecycle: state.lifecycle(parentID, taskID),
    history: state.read(parentID, taskID, { after: "cp_v1_000000000001" }).checkpoints.map((entry) => entry.checkpoint_id),
  }))
  assert.deepEqual(observed.cursor, { consumed_through: "cp_v1_000000000001", latest_checkpoint_id: "cp_v1_000000000003" })
  assert.deepEqual(observed.turn, { generation: 2, terminal_completion_id: "cp_v1_000000000003" })
  assert.equal(observed.lifecycle.prompt_id, "pr_v1_000000000002")
  assert.equal(observed.lifecycle.prompt_stage, "completed")
  assert.equal(observed.lifecycle.acknowledgement_deadline_at, "1970-01-01T00:00:01.010Z")
  assert.deepEqual(observed.history, ["cp_v1_000000000002", "cp_v1_000000000003"])

  const next = await restored.mutate((state) => ({
    prompt: state.reservePrompt(parentID, taskID),
    nextCheckpoint: (() => { state.beginTurn(parentID, taskID); return checkpoint(state, "diff", "After restart") })(),
  }))
  assert.deepEqual(next.prompt, { prompt_id: "pr_v1_000000000003", message_id: "msg_pr_v1_000000000003" })
  assert.equal(next.nextCheckpoint.checkpoint.checkpoint_id, "cp_v1_000000000004")
}))

test("rejects asynchronous mutation callbacks before they can make durable lock ownership ambiguous", async () => temporaryDirectory(async (directory) => {
  const store = new OrchestrationStore({ statePath: statePathFor(directory) })
  await assert.rejects(store.mutate(async () => {}), (error) => error instanceof OrchestrationStoreError && error.code === "ORCHESTRATION_ASYNC_MUTATION")
  assert.deepEqual(await store.read((state) => state.snapshot().tasks), [])
}))

test("persists pending prompt reservations for post-restart admission and never reuses cancelled IDs", async () => temporaryDirectory(async (directory) => {
  const statePath = statePathFor(directory)
  const first = new OrchestrationStore({ statePath })
  const reserved = await first.mutate((state) => {
    state.registerTask(parentID, taskID)
    return state.reservePrompt(parentID, taskID)
  })
  assert.deepEqual(reserved, { prompt_id: "pr_v1_000000000002", message_id: "msg_pr_v1_000000000002" })

  const restarted = new OrchestrationStore({ statePath })
  const admitted = await restarted.mutate((state) => state.admitReservedPromptByMessage(parentID, taskID, reserved.message_id))
  assert.equal(admitted.prompt_stage, "started")
  assert.equal(admitted.prompt_id, reserved.prompt_id)
  assert.equal((await restarted.read((state) => state.turn(parentID, taskID))).generation, 2)

  const failed = await restarted.mutate((state) => state.reservePrompt(parentID, taskID))
  await restarted.mutate((state) => state.cancelPrompt(parentID, taskID, failed))
  const next = await restarted.mutate((state) => state.reservePrompt(parentID, taskID))
  assert.equal(failed.prompt_id, "pr_v1_000000000003")
  assert.equal(next.prompt_id, "pr_v1_000000000004")
}))

test("fails closed without overwriting malformed, future-version, or semantically invalid snapshots", async () => temporaryDirectory(async (directory) => {
  const statePath = statePathFor(directory)
  const lifecycle = new OrchestrationState({ now: () => 1_000 })
  lifecycle.registerTask(parentID, taskID)
  const impossibleCompletedPrompt = lifecycle.snapshot()
  impossibleCompletedPrompt.tasks[0].prompt.prompt_stage = "completed"
  impossibleCompletedPrompt.tasks[0].prompt.completed_at = null
  impossibleCompletedPrompt.tasks[0].prompt.completed_at_ms = null
  const checkpointState = new OrchestrationState({ now: () => 1_000 })
  checkpoint(checkpointState)
  const invalidCheckpointKind = checkpointState.snapshot()
  invalidCheckpointKind.checkpoints[0].checkpoint.kind = "corrupt"
  const invalidCheckpointTask = checkpointState.snapshot()
  invalidCheckpointTask.checkpoints[0].checkpoint.task_id = "other-task"
  const invalidCheckpointPrompt = checkpointState.snapshot()
  invalidCheckpointPrompt.checkpoints[0].checkpoint.prompt_id = "pr_v1_000000000999"
  const invalidSnapshots = [
    "{not json",
    JSON.stringify({ schema_version: 999, sequence: 0, prompt_sequence: 0, checkpoints: [], tasks: [] }),
    JSON.stringify({ schema_version: 1, sequence: 1, prompt_sequence: 0, checkpoints: [], tasks: [] }),
    JSON.stringify(impossibleCompletedPrompt),
    JSON.stringify(invalidCheckpointKind),
    JSON.stringify(invalidCheckpointTask),
    JSON.stringify(invalidCheckpointPrompt),
  ]
  for (const original of invalidSnapshots) {
    await mkdir(path.dirname(statePath), { recursive: true })
    await writeFile(statePath, original, "utf8")
    const store = new OrchestrationStore({ statePath })
    await assert.rejects(store.read(() => true), (error) => error instanceof OrchestrationStoreError && error.code === "ORCHESTRATION_STATE_INVALID")
    assert.equal(await readFile(statePath, "utf8"), original)
  }
}))

test("serializes same-process and concurrent-process mutations without lost updates or corrupt JSON", async () => temporaryDirectory(async (directory) => {
  const statePath = statePathFor(directory)
  const one = new OrchestrationStore({ statePath })
  const two = new OrchestrationStore({ statePath })
  await Promise.all([
    one.mutate((state) => checkpoint(state, "evidence", "same process one")),
    two.mutate((state) => checkpoint(state, "diff", "same process two")),
  ])

  const moduleURL = new URL("./orchestration-store.js", import.meta.url).href
  const script = `import { OrchestrationStore } from ${JSON.stringify(moduleURL)}; const store = new OrchestrationStore({ statePath: process.argv[1] }); await store.mutate((state) => state.deliver('parent-1', { task_id: process.argv[2], kind: 'evidence', summary: process.argv[2], files: [], needs_decision: false }));`
  const runWorker = (task) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script, statePath, task], { stdio: "ignore" })
    child.once("error", reject)
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`worker exited ${code}`)))
  })
  await Promise.all([runWorker("process-1"), runWorker("process-2")])

  const history = await one.read((state) => state.snapshot().checkpoints)
  assert.deepEqual(history.map((record) => record.checkpoint.sequence), [1, 2, 3, 4])
  assert.deepEqual(new Set(history.map((record) => record.task_id)), new Set([taskID, "process-1", "process-2"]))
  const persisted = await readFile(statePath, "utf8")
  assert.doesNotThrow(() => JSON.parse(persisted))
}))

test("recovers dead or missing stale locks but never removes an old lock owned by a live PID", async () => temporaryDirectory(async (directory) => {
  let clock = 1_000
  const statePath = statePathFor(directory)
  const lockPath = `${statePath}.lock`
  await mkdir(lockPath, { recursive: true })
  await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ token: "live", pid: process.pid, created_at_ms: clock }), "utf8")
  clock = 1_101
  const live = new OrchestrationStore({ statePath, now: () => clock, lockTimeoutMs: 0, staleLockMs: 100, sleep: async () => {} })
  await assert.rejects(live.mutate((state) => state.registerTask(parentID, taskID)), (error) => error instanceof OrchestrationStoreError && error.code === "ORCHESTRATION_LOCK_TIMEOUT")
  assert.equal((await readFile(path.join(lockPath, "owner.json"), "utf8")).includes("live"), true)

  await rm(lockPath, { recursive: true, force: true })
  await mkdir(lockPath, { recursive: true })
  await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ token: "dead", created_at_ms: 1_000 }), "utf8")
  const stale = new OrchestrationStore({ statePath, now: () => clock, lockTimeoutMs: 0, staleLockMs: 100, sleep: async () => {}, isProcessAlive: () => false })
  await stale.mutate((state) => state.registerTask(parentID, taskID))
  await assert.rejects(stat(lockPath), { code: "ENOENT" })

  await mkdir(lockPath)
  await utimes(lockPath, new Date(1_000), new Date(1_000))
  const missing = new OrchestrationStore({ statePath, now: () => clock, lockTimeoutMs: 0, staleLockMs: 100, sleep: async () => {}, isProcessAlive: () => false })
  await missing.mutate((state) => state.registerTask(parentID, "missing-owner"))
  await assert.rejects(stat(lockPath), { code: "ENOENT" })

  await mkdir(lockPath)
  await writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ token: "guarded-stale", created_at_ms: 1_000 }), "utf8")
  const recoveryPath = `${lockPath}.recovery`
  await mkdir(recoveryPath)
  await utimes(recoveryPath, new Date(1_000), new Date(1_000))
  await missing.mutate((state) => state.registerTask(parentID, "stale-recovery-guard"))
  await assert.rejects(stat(lockPath), { code: "ENOENT" })
  await assert.rejects(stat(recoveryPath), { code: "ENOENT" })
}))

test("stale recovery cannot remove a lock replaced after recovery starts", async () => temporaryDirectory(async (directory) => {
  const statePath = statePathFor(directory)
  const lockPath = `${statePath}.lock`
  const ownerPath = path.join(lockPath, "owner.json")
  const recoveryPath = `${lockPath}.recovery`
  await mkdir(lockPath, { recursive: true })
  await writeFile(ownerPath, JSON.stringify({ token: "stale", created_at_ms: 1_000 }), "utf8")
  let replaced = false
  const fs = new Proxy(nodeFS, { get(target, property) {
    if (property !== "readFile") return target[property]
    return async (filePath, ...rest) => {
      if (filePath === ownerPath && !replaced) {
        try {
          await target.stat(recoveryPath)
          await target.rm(lockPath, { recursive: true, force: true })
          await target.mkdir(lockPath)
          await target.writeFile(ownerPath, JSON.stringify({ token: "replacement", pid: process.pid, created_at_ms: 1_101 }), "utf8")
          replaced = true
        } catch (error) {
          if (error?.code !== "ENOENT") throw error
        }
      }
      return target.readFile(filePath, ...rest)
    }
  } })
  const store = new OrchestrationStore({ statePath, fs, now: () => 1_101, lockTimeoutMs: 0, staleLockMs: 100, sleep: async () => {}, isProcessAlive: () => false })
  await assert.rejects(store.mutate((state) => state.registerTask(parentID, taskID)), (error) => error instanceof OrchestrationStoreError && error.code === "ORCHESTRATION_LOCK_TIMEOUT")
  assert.equal(replaced, true)
  assert.equal(JSON.parse(await readFile(ownerPath, "utf8")).token, "replacement")
}))

test("uses documented state-path precedence and writes a private atomic state file", async () => temporaryDirectory(async (directory) => {
  const home = path.join(directory, "home")
  const env = { OPENCODE_SOL_ORCHESTRATOR_STATE_PATH: path.join(directory, "environment.json"), XDG_STATE_HOME: path.join(directory, "xdg") }
  assert.equal(resolveStatePath({ statePath: path.join(directory, "explicit.json"), env, home }), path.join(directory, "explicit.json"))
  assert.equal(resolveStatePath({ env, home }), env.OPENCODE_SOL_ORCHESTRATOR_STATE_PATH)
  assert.equal(resolveStatePath({ env: { XDG_STATE_HOME: env.XDG_STATE_HOME }, home }), path.join(env.XDG_STATE_HOME, "opencode", "opencode-sol-orchestrator", "state.json"))
  assert.equal(resolveStatePath({ env: {}, home }), path.join(home, ".local", "state", "opencode", "opencode-sol-orchestrator", "state.json"))

  const statePath = path.join(directory, "nested", "state.json")
  await new OrchestrationStore({ statePath }).mutate((state) => state.registerTask(parentID, taskID))
  const contents = await readFile(statePath, "utf8")
  assert.doesNotThrow(() => JSON.parse(contents))
  assert.equal((await stat(statePath)).mode & 0o077, 0)
  assert.deepEqual((await readdir(path.dirname(statePath))).filter((name) => name.includes(".tmp-")), [])
}))
