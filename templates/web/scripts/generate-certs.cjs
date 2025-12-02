const fs = require('fs')
const path = require('path')
const selfsigned = require('selfsigned')

const attrs = [{ name: 'commonName', value: 'localhost' }]
const opts = {
  days: 365,
  algorithm: 'sha256',
  extensions: [
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 7, ip: '127.0.0.1' }
      ]
    }
  ]
}

const pems = selfsigned.generate(attrs, opts)
const outDir = path.resolve(process.cwd(), 'certs')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'localhost.key'), pems.private)
fs.writeFileSync(path.join(outDir, 'localhost.crt'), pems.cert)
console.log(`Wrote certs to ${outDir}/localhost.{key,crt}`)
