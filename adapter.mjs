import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  parseJSONC,
  readText,
  writeAtomic,
  setArrayItem,
  delArrayItem,
  getObjectField,
  setObjectField,
  delObjectField,
} from './jsonc.mjs'

const CHAT_SETTING_DEFAULT_MODEL = 'chat.defaultModel'
const VENDOR_CUSTOM_ENDPOINT = 'customendpoint'
const VENDOR_CUSTOM_OAI = 'customoai'
const COPILOT_CHAT_ID = 'github.copilot-chat'

export function defaultCodeServerDirectory(home = os.homedir()) {
  const envDir = process.env.CODE_SERVER_USER_DATA_DIR
  if (envDir && envDir.trim()) {
    return path.resolve(envDir.trim())
  }
  return path.join(home, '.local', 'share', 'code-server')
}

export function defaultStateDirectory(home = os.homedir()) {
  return path.join(home, '.config', 'magpie-code-server')
}

export class CodeServerAdapter {
  constructor({
    home = os.homedir(),
    codeServerDir,
    stateDir,
    intervalMs = 1500,
    log = () => {},
  } = {}) {
    this.home = home
    this.codeServerDir = codeServerDir || defaultCodeServerDirectory(home)
    this.stateDir = stateDir || defaultStateDirectory(home)
    this.connectionFile = path.join(this.stateDir, 'connection.json')
    this.stateFile = path.join(this.stateDir, 'adapter-state.json')
    this.lockFile = path.join(this.stateDir, 'adapter-owner.json')

    this.userDir = path.join(this.codeServerDir, 'User')
    this.settingsFile = path.join(this.userDir, 'settings.json')
    this.modelsFile = path.join(this.userDir, 'chatLanguageModels.json')
    this.extensionsDir = path.join(this.codeServerDir, 'extensions')

    this.intervalMs = intervalMs
    this.log = log
    this.ownerID = crypto.randomUUID()
    this.locked = false
    this.running = false
    this.stopping = false
    this.lastSignature = null
  }

  bootstrap() {
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 })
    return true
  }

  ownLock() {
    if (this.locked) {
      try {
        const current = JSON.parse(fs.readFileSync(this.lockFile, 'utf8'))
        return current.ownerID === this.ownerID
      } catch {
        this.locked = false
      }
    }

    try {
      const current = JSON.parse(fs.readFileSync(this.lockFile, 'utf8'))
      let alive = true
      try {
        process.kill(current.pid, 0)
      } catch (err) {
        alive = err.code !== 'ESRCH'
      }
      if (alive) return false
      fs.unlinkSync(this.lockFile)
    } catch (err) {
      if (err.code !== 'ENOENT') return false
    }

    try {
      fs.writeFileSync(
        this.lockFile,
        JSON.stringify({ pid: process.pid, ownerID: this.ownerID }),
        { flag: 'wx', mode: 0o600 }
      )
      this.locked = true
      return true
    } catch {
      return false
    }
  }

  releaseLock() {
    try {
      const current = JSON.parse(fs.readFileSync(this.lockFile, 'utf8'))
      if (current.ownerID === this.ownerID) {
        fs.unlinkSync(this.lockFile)
      }
    } catch {}
    this.locked = false
  }

  loadState() {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))
    } catch {
      return { active: false, stashed: {} }
    }
  }

  saveState(state) {
    writeAtomic(this.stateFile, JSON.stringify(state, null, 2) + '\n')
  }

  /**
   * Detect installed Copilot Chat vendor (customendpoint vs customoai).
   * Follows vscodeChatOf logic from vscode.go.
   */
  detectVendor() {
    const extDir = this.extensionsDir
    if (!fs.existsSync(extDir)) {
      return VENDOR_CUSTOM_ENDPOINT
    }

    let installedPkg = null
    const extJsonPath = path.join(extDir, 'extensions.json')
    if (fs.existsSync(extJsonPath)) {
      try {
        const exts = JSON.parse(fs.readFileSync(extJsonPath, 'utf8'))
        const found = exts.find(e => e?.identifier?.id?.toLowerCase() === COPILOT_CHAT_ID)
        if (found) {
          const loc = found.relativeLocation
            ? path.join(extDir, found.relativeLocation)
            : found.location?.fsPath || found.location?.path
          if (loc && fs.existsSync(path.join(loc, 'package.json'))) {
            installedPkg = JSON.parse(fs.readFileSync(path.join(loc, 'package.json'), 'utf8'))
          }
        }
      } catch {}
    }

    if (!installedPkg) {
      try {
        const ents = fs.readdirSync(extDir, { withFileTypes: true })
        let bestDir = null
        for (const ent of ents) {
          if (!ent.isDirectory()) continue
          const name = ent.name.toLowerCase()
          if (name.startsWith(COPILOT_CHAT_ID + '-')) {
            bestDir = path.join(extDir, ent.name)
          }
        }
        if (bestDir && fs.existsSync(path.join(bestDir, 'package.json'))) {
          installedPkg = JSON.parse(fs.readFileSync(path.join(bestDir, 'package.json'), 'utf8'))
        }
      } catch {}
    }

    if (installedPkg?.contributes?.languageModelChatProviders) {
      const providers = installedPkg.contributes.languageModelChatProviders
      if (Array.isArray(providers)) {
        if (providers.some(p => p?.vendor === VENDOR_CUSTOM_ENDPOINT)) {
          return VENDOR_CUSTOM_ENDPOINT
        }
        if (providers.some(p => p?.vendor === VENDOR_CUSTOM_OAI)) {
          return VENDOR_CUSTOM_OAI
        }
      }
    }

    return VENDOR_CUSTOM_ENDPOINT
  }

  /**
   * Find all profiles settings.json and chatLanguageModels.json.
   * Follows vscodeProfiles from vscode.go.
   */
  getProfileTargets() {
    const defaultSettings = this.settingsFile
    const defaultModels = this.modelsFile
    const targets = [{ settings: defaultSettings, models: defaultModels }]

    const storagePath = path.join(this.userDir, 'globalStorage', 'storage.json')
    if (!fs.existsSync(storagePath)) {
      return targets
    }

    try {
      const storage = JSON.parse(fs.readFileSync(storagePath, 'utf8'))
      const profiles = storage?.userDataProfiles
      if (Array.isArray(profiles)) {
        for (const p of profiles) {
          let at = p.location
          if (p.location && typeof p.location === 'object') {
            at = p.location.fsPath || p.location.path
          } else if (typeof at === 'string' && at) {
            at = path.join(this.userDir, 'profiles', at)
          }
          if (!at || !fs.existsSync(at)) continue

          const sFile = p.useDefaultFlags?.settings ? defaultSettings : path.join(at, 'settings.json')
          const mFile = p.useDefaultFlags?.languageModels ? defaultModels : path.join(at, 'chatLanguageModels.json')

          if (!targets.some(t => t.settings === sFile && t.models === mFile)) {
            targets.push({ settings: sFile, models: mFile })
          }
        }
      }
    } catch {}

    return targets
  }

  buildGroup(desired, vendor) {
    const list = []
    const gatewayV1 = (desired.gateway?.v1 || desired.gateway?.url || '').replace(/\/$/, '')
    const url = gatewayV1 + '/chat/completions'
    const token = desired.gateway?.key || 'magpie-code-server'

    for (const m of desired.models || []) {
      const context = m.context || 128000
      let output = m.output || 8192
      output = Math.min(output, Math.floor(context / 4))

      const entry = {
        id: m.id,
        name: m.name || m.id,
        url,
        toolCalling: true,
        vision: Boolean(m.images),
        contextWindow: context,
        maxOutputTokens: output,
        requestHeaders: { Authorization: `Bearer ${token}` },
      }

      if (vendor === VENDOR_CUSTOM_OAI) {
        delete entry.contextWindow
        entry.maxInputTokens = context - output
        entry.requestHeaders = { 'x-api-key': token }
      }

      if (Array.isArray(m.efforts) && m.efforts.length > 0) {
        entry.supportsReasoningEffort = m.efforts
        entry.reasoningEffortFormat = 'chat-completions'
      }

      list.push(entry)
    }

    if (vendor === VENDOR_CUSTOM_OAI) {
      return { name: 'magpie', vendor: VENDOR_CUSTOM_OAI, models: list }
    }
    return { name: 'magpie', vendor: VENDOR_CUSTOM_ENDPOINT, apiType: 'chat-completions', models: list }
  }

  applyConnection(desired) {
    const vendor = this.detectVendor()
    const group = this.buildGroup(desired, vendor)
    const targets = this.getProfileTargets()
    const state = this.loadState()
    const stashed = state.stashed || {}

    for (const { settings, models } of targets) {
      // 1. Remove group of other vendor if present
      const otherVendor = vendor === VENDOR_CUSTOM_ENDPOINT ? VENDOR_CUSTOM_OAI : VENDOR_CUSTOM_ENDPOINT
      delArrayItem(models, { name: 'magpie', vendor: otherVendor })

      // 2. Set/update current vendor group in chatLanguageModels.json
      setArrayItem(models, { name: 'magpie', vendor }, group)

      // 3. Stash current default model if it was not magpie
      const currentDefault = getObjectField(settings, CHAT_SETTING_DEFAULT_MODEL)
      const isMagpieModel = desired.models?.some(m => m.id === currentDefault)
      if (!isMagpieModel && currentDefault !== undefined) {
        if (!(settings in stashed)) {
          stashed[settings] = currentDefault
        }
      }

      // 4. Set chat.defaultModel to selected model
      if (desired.model) {
        setObjectField(settings, CHAT_SETTING_DEFAULT_MODEL, desired.model)
      }
    }

    state.active = true
    state.stashed = stashed
    state.lastModel = desired.model
    this.saveState(state)
  }

  restoreOriginal() {
    const state = this.loadState()
    const stashed = state.stashed || {}
    const targets = this.getProfileTargets()

    for (const { settings, models } of targets) {
      // 1. Remove magpie groups from chatLanguageModels.json
      delArrayItem(models, { name: 'magpie', vendor: VENDOR_CUSTOM_ENDPOINT })
      delArrayItem(models, { name: 'magpie', vendor: VENDOR_CUSTOM_OAI })

      // 2. Restore stashed defaultModel
      if (settings in stashed) {
        const was = stashed[settings]
        if (was) {
          setObjectField(settings, CHAT_SETTING_DEFAULT_MODEL, was)
        } else {
          delObjectField(settings, CHAT_SETTING_DEFAULT_MODEL)
        }
      } else {
        const cur = getObjectField(settings, CHAT_SETTING_DEFAULT_MODEL)
        // If it was pointed to a model we know, delete or restore
        if (cur && cur.includes('/')) {
          delObjectField(settings, CHAT_SETTING_DEFAULT_MODEL)
        }
      }
    }

    state.active = false
    state.stashed = {}
    delete state.lastModel
    this.saveState(state)
  }

  async tick() {
    if (this.running || this.stopping) return
    this.running = true
    try {
      if (!this.bootstrap()) return
      if (!this.ownLock()) return

      let desired = null
      if (fs.existsSync(this.connectionFile)) {
        try {
          desired = parseJSONC(fs.readFileSync(this.connectionFile, 'utf8'))
        } catch {}
      }

      const isEnabled = Boolean(desired?.enabled && desired?.model)
      const sig = isEnabled
        ? crypto.createHash('sha256').update(JSON.stringify(desired)).digest('hex')
        : 'disabled'

      if (sig === this.lastSignature) {
        return
      }

      if (isEnabled) {
        this.applyConnection(desired)
      } else {
        const state = this.loadState()
        if (state.active) {
          this.restoreOriginal()
        }
      }

      this.lastSignature = sig
    } catch (err) {
      this.log(`code-server adapter error: ${err.message}`)
    } finally {
      this.running = false
    }
  }

  async start() {
    await this.tick()
    this.timer = setInterval(() => { void this.tick() }, this.intervalMs)
    this.timer.unref?.()
    return this
  }

  async stop() {
    clearInterval(this.timer)
    this.stopping = true
    while (this.running) {
      await new Promise(r => setTimeout(r, 20))
    }
    this.releaseLock()
  }

  restoreOnExit() {
    if (!this.locked) return
    try {
      const state = this.loadState()
      if (state.active) {
        this.restoreOriginal()
      }
    } catch {}
    this.releaseLock()
  }
}
