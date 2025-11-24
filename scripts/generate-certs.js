#!/usr/bin/env node
const fs = require('fs/promises')
const { existsSync } = require('fs')
const path = require('path')
const selfsigned = require('selfsigned')

const CERT_DIR = path.resolve(__dirname, '..', 'certs')
const CERT_PATH = path.join(CERT_DIR, 'hyperagent.cert.pem')
const KEY_PATH = path.join(CERT_DIR, 'hyperagent.key.pem')
const FORCE = process.argv.includes('--force')

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true })
}

async function writeFile(filePath, contents) {
  await fs.writeFile(filePath, contents, { encoding: 'utf8', mode: 0o600 })
}

function buildCertificate() {
  const attrs = [{ name: 'commonName', value: 'hyperagent.local' }]
  const altNames = ['localhost', 'hyperagent.local', 'host.docker.internal']
  const san = altNames.map((name) => ({ type: 2, value: name }))
  san.push({ type: 7, ip: '127.0.0.1' })
  san.push({ type: 7, ip: '::1' })
  const options = {
    days: 365,
    algorithm: 'sha256',
    keySize: 2048,
    extensions: [
      { name: 'basicConstraints', cA: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
      { name: 'subjectAltName', altNames: san }
    ]
  }
  return selfsigned.generate(attrs, options)
}

async function main() {
  if (!FORCE && existsSync(CERT_PATH) && existsSync(KEY_PATH)) {
    console.log('Existing certificates found. Re-run with --force to regenerate.')
    return
  }

  await ensureDir(CERT_DIR)
  const { cert, private: privateKey } = buildCertificate()
  await writeFile(CERT_PATH, cert)
  await writeFile(KEY_PATH, privateKey)
  console.log(`Created cert at ${CERT_PATH}`)
  console.log(`Created key at ${KEY_PATH}`)
}

main().catch((error) => {
  console.error('Failed to generate certificates', error)
  process.exit(1)
})
