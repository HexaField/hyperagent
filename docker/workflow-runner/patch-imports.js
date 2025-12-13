const fs = require('fs')

function walk(dir) {
  let out = []
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const e of entries) {
    const p = `${dir}/${e.name}`
    if (e.isDirectory()) out = out.concat(walk(p))
    else if (e.isFile() && p.endsWith('.js')) out.push(p)
  }
  return out
}

const files = []
if (fs.existsSync('dist')) files.push(...walk('dist'))
if (fs.existsSync('packages/agent/dist')) files.push(...walk('packages/agent/dist'))

const importRegex = /(from\s+['"])(\.\.\/|\.\/)([^'"\n]+?)(['"])/g
const requireRegex = /(require\(\s*['"])(\.\.\/|\.\/)([^'"\n]+?)(['"]\s*\))/g

function resolveReplacement(filePath, rel, target) {
  const fileDir = require('path').dirname(filePath)
  const candidate = require('path').join(fileDir, rel, target)
  // If there's already a JS file at candidate.js, use it
  if (fs.existsSync(candidate + '.js')) return rel + target + '.js'
  // If candidate itself is a JS file (unlikely), keep as-is
  if (fs.existsSync(candidate) && candidate.endsWith('.js')) return rel + target
  // If candidate is a directory with index.js, use /index.js
  if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
    if (fs.existsSync(require('path').join(candidate, 'index.js'))) return rel + target + '/index.js'
  }
  // As a fallback, if candidate + '/index.js' exists
  if (fs.existsSync(require('path').join(candidate, 'index.js'))) return rel + target + '/index.js'
  // Otherwise, append .js (best-effort)
  return rel + target + '.js'
}

files.forEach((f) => {
  let s = fs.readFileSync(f, 'utf8')
  s = s.replace(importRegex, (m, p, rel, path, q) => {
    if (path.endsWith('.js') || path.includes('.json')) return m
    const repl = resolveReplacement(f, rel, path)
    return p + repl + q
  })
  s = s.replace(requireRegex, (m, p, rel, path, q) => {
    if (path.endsWith('.js') || path.includes('.json')) return m
    const repl = resolveReplacement(f, rel, path)
    return p + repl + q
  })
  fs.writeFileSync(f, s)
  console.log('patched', f)
})
