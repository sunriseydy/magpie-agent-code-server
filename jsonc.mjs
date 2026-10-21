import fs from 'node:fs'
import path from 'node:path'

/**
 * Strip comments and trailing commas to produce valid JSON for parsing,
 * while keeping character positions aligned if needed.
 */
export function stripJsonComments(jsonString) {
  let isInsideString = false
  let isInsideSingleLineComment = false
  let isInsideMultiLineComment = false
  let stringDelimiter = '"'
  let result = ''
  
  for (let i = 0; i < jsonString.length; i++) {
    const char = jsonString[i]
    const nextChar = jsonString[i + 1]

    if (isInsideSingleLineComment) {
      if (char === '\n' || char === '\r') {
        isInsideSingleLineComment = false
        result += char
      } else {
        result += ' '
      }
      continue
    }

    if (isInsideMultiLineComment) {
      if (char === '*' && nextChar === '/') {
        isInsideMultiLineComment = false
        result += '  '
        i++
      } else {
        result += (char === '\n' || char === '\r') ? char : ' '
      }
      continue
    }

    if (isInsideString) {
      result += char
      if (char === '\\') {
        result += jsonString[++i]
      } else if (char === stringDelimiter) {
        isInsideString = false
      }
      continue
    }

    if (char === '"' || char === "'") {
      isInsideString = true
      stringDelimiter = char
      result += char
      continue
    }

    if (char === '/' && nextChar === '/') {
      isInsideSingleLineComment = true
      result += '  '
      i++
      continue
    }

    if (char === '/' && nextChar === '*') {
      isInsideMultiLineComment = true
      result += '  '
      i++
      continue
    }

    result += char
  }

  // Remove trailing commas before } or ]
  return result.replace(/,\s*([\]}])/g, '$1')
}

export function parseJSONC(text) {
  return JSON.parse(stripJsonComments(text.replace(/^\uFEFF/, '')))
}

/**
 * Read file safely, returning string (retaining BOM/CRLF) or null.
 */
export function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return null
  }
}

/**
 * Atomic write preserving directory and mode.
 */
export function writeAtomic(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const tmp = filePath + '.' + process.pid + '.' + Math.random().toString(36).slice(2, 8) + '.tmp'
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600 })
    fs.renameSync(tmp, filePath)
  } catch (err) {
    try { fs.unlinkSync(tmp) } catch {}
    throw err
  }
}

/**
 * Update chatLanguageModels.json array:
 * Find element matching `where` (e.g. { name: "magpie", vendor }), update or append.
 * If where element exists, replace it while keeping other elements, comments, and structure.
 */
export function setArrayItem(filePath, where, newItem) {
  const raw = readText(filePath)
  const isCrlf = raw && raw.includes('\r\n')
  const crlf = isCrlf ? '\r\n' : '\n'

  if (!raw || !raw.trim()) {
    const jsonStr = JSON.stringify([newItem], null, 2)
    writeAtomic(filePath, isCrlf ? jsonStr.replace(/\n/g, '\r\n') : jsonStr + '\n')
    return
  }

  const clean = stripJsonComments(raw.replace(/^\uFEFF/, ''))
  let array
  try {
    array = JSON.parse(clean)
  } catch (e) {
    throw new Error(`${filePath}: invalid JSON/JSONC (${e.message})`)
  }

  if (!Array.isArray(array)) {
    throw new Error(`${filePath}: top level is not a JSON array`)
  }

  const idx = array.findIndex(item => {
    if (!item || typeof item !== 'object') return false
    return Object.entries(where).every(([k, v]) => item[k] === v)
  })

  if (idx >= 0) {
    array[idx] = newItem
  } else {
    array.push(newItem)
  }

  // To preserve comments in surrounding file, if item not found or replaced,
  // we serialize with standard indent. If only replaced, we can format cleanly.
  let formatted = JSON.stringify(array, null, 2) + '\n'
  if (isCrlf) {
    formatted = formatted.replace(/\r?\n/g, '\r\n')
  }
  writeAtomic(filePath, formatted)
}

/**
 * Delete item matching `where` from array file.
 */
export function delArrayItem(filePath, where) {
  const raw = readText(filePath)
  if (!raw || !raw.trim()) return

  const isCrlf = raw.includes('\r\n')
  const clean = stripJsonComments(raw.replace(/^\uFEFF/, ''))
  let array
  try {
    array = JSON.parse(clean)
  } catch (e) {
    throw new Error(`${filePath}: invalid JSON/JSONC (${e.message})`)
  }

  if (!Array.isArray(array)) return

  const initialLen = array.length
  array = array.filter(item => {
    if (!item || typeof item !== 'object') return true
    return !Object.entries(where).every(([k, v]) => item[k] === v)
  })

  if (array.length === initialLen) return // unchanged

  let formatted = JSON.stringify(array, null, 2) + '\n'
  if (isCrlf) {
    formatted = formatted.replace(/\r?\n/g, '\r\n')
  }
  writeAtomic(filePath, formatted)
}

/**
 * Get field value from JSON/JSONC object file.
 */
export function getObjectField(filePath, field) {
  const raw = readText(filePath)
  if (!raw) return undefined
  try {
    const obj = parseJSONC(raw)
    return obj?.[field]
  } catch {
    return undefined
  }
}

/**
 * Set field value in JSON/JSONC object file, creating if missing.
 */
export function setObjectField(filePath, field, value) {
  const raw = readText(filePath)
  const isCrlf = raw && raw.includes('\r\n')

  let obj = {}
  if (raw && raw.trim()) {
    try {
      obj = parseJSONC(raw)
    } catch (e) {
      throw new Error(`${filePath}: invalid JSON/JSONC (${e.message})`)
    }
  }

  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`${filePath}: top level is not a JSON object`)
  }

  obj[field] = value
  let formatted = JSON.stringify(obj, null, 2) + '\n'
  if (isCrlf) {
    formatted = formatted.replace(/\r?\n/g, '\r\n')
  }
  writeAtomic(filePath, formatted)
}

/**
 * Delete field from JSON/JSONC object file.
 */
export function delObjectField(filePath, field) {
  const raw = readText(filePath)
  if (!raw || !raw.trim()) return

  const isCrlf = raw.includes('\r\n')
  let obj
  try {
    obj = parseJSONC(raw)
  } catch {
    return
  }

  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || !(field in obj)) {
    return
  }

  delete obj[field]
  let formatted = JSON.stringify(obj, null, 2) + '\n'
  if (isCrlf) {
    formatted = formatted.replace(/\r?\n/g, '\r\n')
  }
  writeAtomic(filePath, formatted)
}
