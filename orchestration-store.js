import { randomUUID } from "node:crypto"
import * as nodeFS from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { OrchestrationState } from "./orchestration-state.js"

const localQueues = new Map()
const isMissing = (error) => error && typeof error === "object" && error.code === "ENOENT"
const isExisting = (error) => error && typeof error === "object" && error.code === "EEXIST"
const isProcessAlive = (pid) => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error && typeof error === "object" && error.code === "EPERM"
  }
}
const milliseconds = (value) => {
  const result = typeof value === "number" ? value : value instanceof Date ? value.getTime() : Date.parse(value)
  if (!Number.isFinite(result)) throw new OrchestrationStoreError("ORCHESTRATION_CLOCK_INVALID", "The orchestration store clock returned an invalid timestamp.")
  return result
}

export class OrchestrationStoreError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause === undefined ? undefined : { cause })
    this.name = "OrchestrationStoreError"
    this.code = code
  }
}

export const resolveStatePath = ({ statePath, env = process.env, home = os.homedir() } = {}) => {
  if (statePath !== undefined) {
    if (typeof statePath !== "string" || !statePath) throw new OrchestrationStoreError("ORCHESTRATION_STATE_PATH_INVALID", "statePath must be a non-empty string.")
    return statePath
  }
  if (typeof env?.OPENCODE_SOL_ORCHESTRATOR_STATE_PATH === "string" && env.OPENCODE_SOL_ORCHESTRATOR_STATE_PATH) return env.OPENCODE_SOL_ORCHESTRATOR_STATE_PATH
  if (typeof env?.XDG_STATE_HOME === "string" && env.XDG_STATE_HOME) return path.join(env.XDG_STATE_HOME, "opencode", "opencode-sol-orchestrator", "state.json")
  if (typeof home !== "string" || !home) throw new OrchestrationStoreError("ORCHESTRATION_HOME_INVALID", "The orchestration store home directory must be a non-empty string.")
  return path.join(home, ".local", "state", "opencode", "opencode-sol-orchestrator", "state.json")
}

export class OrchestrationStore {
  #fs
  #statePath
  #lockPath
  #recoveryPath
  #now
  #sleep
  #isProcessAlive
  #thresholds
  #lockTimeoutMs
  #lockRetryMs
  #staleLockMs

  constructor({ statePath, env, home, fs = nodeFS, now = () => Date.now(), sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)), isProcessAlive: processAlive = isProcessAlive, thresholds, lockTimeoutMs = 5_000, lockRetryMs = 10, staleLockMs = 60_000 } = {}) {
    for (const [name, value] of Object.entries({ lockTimeoutMs, lockRetryMs, staleLockMs })) {
      if (!Number.isSafeInteger(value) || value < 0) throw new OrchestrationStoreError("ORCHESTRATION_LOCK_OPTIONS_INVALID", `${name} must be a non-negative safe integer.`)
    }
    if (!fs || typeof fs !== "object") throw new OrchestrationStoreError("ORCHESTRATION_FS_INVALID", "The orchestration store fs adapter must be an object.")
    if (typeof now !== "function" || typeof sleep !== "function" || typeof processAlive !== "function") throw new OrchestrationStoreError("ORCHESTRATION_STORE_OPTIONS_INVALID", "The orchestration store now, sleep, and isProcessAlive options must be functions.")
    this.#fs = fs
    this.#statePath = resolveStatePath({ statePath, env, home })
    this.#lockPath = `${this.#statePath}.lock`
    this.#recoveryPath = `${this.#lockPath}.recovery`
    this.#now = now
    this.#sleep = sleep
    this.#isProcessAlive = processAlive
    this.#thresholds = thresholds
    this.#lockTimeoutMs = lockTimeoutMs
    this.#lockRetryMs = lockRetryMs
    this.#staleLockMs = staleLockMs
  }

  get statePath() { return this.#statePath }

  async initialize() { return this.read(() => undefined) }

  async read(reader = (state) => state.snapshot()) {
    if (typeof reader !== "function") throw new OrchestrationStoreError("ORCHESTRATION_READER_INVALID", "The orchestration store reader must be a function.")
    const state = await this.#load()
    return reader(state)
  }

  async mutate(mutation) {
    if (typeof mutation !== "function") throw new OrchestrationStoreError("ORCHESTRATION_MUTATION_INVALID", "The orchestration store mutation must be a function.")
    return this.#serialize(async () => this.#withLock(async () => {
      const state = await this.#load()
      const value = mutation(state)
      if (value && typeof value.then === "function") throw new OrchestrationStoreError("ORCHESTRATION_ASYNC_MUTATION", "Orchestration store mutation callbacks must be synchronous.")
      await this.#write(state)
      return value
    }))
  }

  async #serialize(operation) {
    const prior = localQueues.get(this.#statePath) ?? Promise.resolve()
    const queued = prior.catch(() => undefined).then(operation)
    localQueues.set(this.#statePath, queued)
    try { return await queued } finally { if (localQueues.get(this.#statePath) === queued) localQueues.delete(this.#statePath) }
  }

  async #load() {
    let contents
    try {
      contents = await this.#fs.readFile(this.#statePath, "utf8")
    } catch (error) {
      if (isMissing(error)) return new OrchestrationState({ now: this.#now, thresholds: this.#thresholds })
      throw new OrchestrationStoreError("ORCHESTRATION_STATE_READ_FAILED", `Could not read orchestration state at ${this.#statePath}.`, { cause: error })
    }
    let snapshot
    try { snapshot = JSON.parse(contents) } catch (error) {
      throw new OrchestrationStoreError("ORCHESTRATION_STATE_INVALID", `Orchestration state at ${this.#statePath} contains malformed JSON.`, { cause: error })
    }
    try { return OrchestrationState.restore(snapshot, { now: this.#now, thresholds: this.#thresholds }) } catch (error) {
      throw new OrchestrationStoreError("ORCHESTRATION_STATE_INVALID", `Orchestration state at ${this.#statePath} is invalid or uses an unsupported schema.`, { cause: error })
    }
  }

  async #write(state) {
    const directory = path.dirname(this.#statePath)
    const temporaryPath = `${this.#statePath}.tmp-${process.pid}-${randomUUID()}`
    let temporaryCreated = false
    try {
      await this.#fs.mkdir(directory, { recursive: true, mode: 0o700 })
      if (typeof this.#fs.chmod === "function") await this.#fs.chmod(directory, 0o700).catch(() => undefined)
      const handle = await this.#fs.open(temporaryPath, "wx", 0o600)
      temporaryCreated = true
      try {
        await handle.writeFile(`${JSON.stringify(state.snapshot())}\n`, "utf8")
        await handle.sync?.()
      } finally { await handle.close() }
      await this.#fs.rename(temporaryPath, this.#statePath)
      temporaryCreated = false
      if (typeof this.#fs.chmod === "function") await this.#fs.chmod(this.#statePath, 0o600).catch(() => undefined)
    } catch (error) {
      throw new OrchestrationStoreError("ORCHESTRATION_STATE_WRITE_FAILED", `Could not atomically write orchestration state at ${this.#statePath}.`, { cause: error })
    } finally {
      if (temporaryCreated && typeof this.#fs.rm === "function") await this.#fs.rm(temporaryPath, { force: true }).catch(() => undefined)
    }
  }

  async #withLock(operation) {
    const lease = await this.#acquireLock()
    try { return await operation() } finally { await this.#releaseLock(lease) }
  }

  async #acquireLock() {
    const token = randomUUID()
    const started = milliseconds(this.#now())
    try {
      await this.#fs.mkdir(path.dirname(this.#statePath), { recursive: true, mode: 0o700 })
      if (typeof this.#fs.chmod === "function") await this.#fs.chmod(path.dirname(this.#statePath), 0o700).catch(() => undefined)
    } catch (error) {
      throw new OrchestrationStoreError("ORCHESTRATION_LOCK_FAILED", `Could not prepare orchestration state directory at ${path.dirname(this.#statePath)}.`, { cause: error })
    }
    while (true) {
      const recovery = await this.#readLease(this.#recoveryPath)
      if (recovery) {
        if (this.#staleLease(recovery)) {
          await this.#breakStaleRecovery(recovery)
          continue
        }
        await this.#waitForLock(started)
        continue
      }
      try {
        return await this.#createLease(this.#lockPath, token)
      } catch (error) {
        if (!isExisting(error)) throw new OrchestrationStoreError("ORCHESTRATION_LOCK_FAILED", `Could not acquire orchestration state lock at ${this.#lockPath}.`, { cause: error })
        const current = await this.#readLease(this.#lockPath)
        if (current && this.#staleLease(current) && await this.#recoverStaleLock(current, started)) continue
        await this.#waitForLock(started)
      }
    }
  }

  async #createLease(lockPath, token) {
    await this.#fs.mkdir(lockPath, { mode: 0o700 })
    try {
      await this.#fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify({ token, pid: process.pid, created_at_ms: milliseconds(this.#now()) }), { encoding: "utf8", mode: 0o600, flag: "wx" })
    } catch (error) {
      await this.#fs.rm(lockPath, { recursive: true, force: true }).catch(() => undefined)
      throw error
    }
    return { token }
  }

  async #readLease(lockPath) {
    let contents
    try {
      contents = await this.#fs.readFile(path.join(lockPath, "owner.json"), "utf8")
    } catch (error) {
      if (!isMissing(error)) throw new OrchestrationStoreError("ORCHESTRATION_LOCK_FAILED", `Could not read orchestration state lock at ${lockPath}.`, { cause: error })
      return this.#leaseFromDirectory(lockPath)
    }
    try {
      const parsed = JSON.parse(contents)
      if (parsed && typeof parsed === "object" && typeof parsed.token === "string" && parsed.token && Number.isFinite(parsed.created_at_ms)) return {
        token: parsed.token,
        pid: Number.isSafeInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : undefined,
        created_at_ms: parsed.created_at_ms,
      }
    } catch {}
    return this.#leaseFromDirectory(lockPath)
  }

  async #leaseFromDirectory(lockPath) {
    try {
      const details = await this.#fs.stat(lockPath)
      return { created_at_ms: Number.isFinite(details.mtimeMs) ? details.mtimeMs : undefined }
    } catch (error) {
      if (isMissing(error)) return undefined
      throw new OrchestrationStoreError("ORCHESTRATION_LOCK_FAILED", `Could not inspect orchestration state lock at ${lockPath}.`, { cause: error })
    }
  }

  #staleLease(lease) {
    if (!Number.isFinite(lease?.created_at_ms) || milliseconds(this.#now()) - lease.created_at_ms <= this.#staleLockMs) return false
    return !this.#isProcessAlive(lease.pid)
  }

  #sameLease(expected, current) {
    if (!expected || !current) return false
    if (expected.token) return expected.token === current.token
    return !current.token && expected.created_at_ms === current.created_at_ms
  }

  async #waitForLock(started) {
    if (milliseconds(this.#now()) - started >= this.#lockTimeoutMs) throw new OrchestrationStoreError("ORCHESTRATION_LOCK_TIMEOUT", `Timed out waiting for the live orchestration state lock at ${this.#lockPath}.`)
    await this.#sleep(this.#lockRetryMs)
  }

  async #recoverStaleLock(candidate, started) {
    const recovery = await this.#acquireRecoveryGuard(started)
    try {
      const current = await this.#readLease(this.#lockPath)
      if (!this.#sameLease(candidate, current) || !this.#staleLease(current)) return false
      const abandoned = `${this.#lockPath}.abandoned-${candidate.token ?? "missing"}-${randomUUID()}`
      try {
        await this.#fs.rename(this.#lockPath, abandoned)
      } catch (error) {
        if (isMissing(error)) return true
        throw new OrchestrationStoreError("ORCHESTRATION_LOCK_FAILED", `Could not quarantine stale orchestration state lock at ${this.#lockPath}.`, { cause: error })
      }
      await this.#fs.rm(abandoned, { recursive: true, force: true }).catch((error) => {
        throw new OrchestrationStoreError("ORCHESTRATION_LOCK_FAILED", `Could not remove quarantined orchestration state lock at ${abandoned}.`, { cause: error })
      })
      return true
    } finally { await this.#releaseLease(this.#recoveryPath, recovery.token) }
  }

  async #acquireRecoveryGuard(started) {
    const token = randomUUID()
    while (true) {
      try { return await this.#createLease(this.#recoveryPath, token) } catch (error) {
        if (!isExisting(error)) throw new OrchestrationStoreError("ORCHESTRATION_LOCK_FAILED", `Could not acquire orchestration recovery guard at ${this.#recoveryPath}.`, { cause: error })
        const current = await this.#readLease(this.#recoveryPath)
        if (current && this.#staleLease(current)) {
          await this.#breakStaleRecovery(current)
          continue
        }
        await this.#waitForLock(started)
      }
    }
  }

  async #breakStaleRecovery(candidate) {
    const current = await this.#readLease(this.#recoveryPath)
    if (!this.#sameLease(candidate, current) || !this.#staleLease(current)) return
    const abandoned = `${this.#recoveryPath}.abandoned-${candidate.token ?? "missing"}-${randomUUID()}`
    try {
      await this.#fs.rename(this.#recoveryPath, abandoned)
    } catch (error) {
      if (isMissing(error)) return
      throw new OrchestrationStoreError("ORCHESTRATION_LOCK_FAILED", `Could not quarantine stale orchestration recovery guard at ${this.#recoveryPath}.`, { cause: error })
    }
    await this.#fs.rm(abandoned, { recursive: true, force: true }).catch((error) => {
      throw new OrchestrationStoreError("ORCHESTRATION_LOCK_FAILED", `Could not remove quarantined orchestration recovery guard at ${abandoned}.`, { cause: error })
    })
  }

  async #releaseLock(lease) {
    await this.#releaseLease(this.#lockPath, lease.token)
  }

  async #releaseLease(lockPath, token) {
    try {
      const owner = await this.#readLease(lockPath)
      if (owner?.token !== token) return
      await this.#fs.rm(lockPath, { recursive: true, force: true })
    } catch (error) {
      if (!isMissing(error)) throw new OrchestrationStoreError("ORCHESTRATION_LOCK_RELEASE_FAILED", `Could not release orchestration state lock at ${lockPath}.`, { cause: error })
    }
  }
}
