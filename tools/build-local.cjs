'use strict'

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const crypto = require('node:crypto')
const { execSync } = require('node:child_process')

function createZip(files) {
  const parts = []
  const central = []
  let offset = 0
  for (const [name, data] of files) {
    const nameBuf = Buffer.from(name.replace(/\\/g, '/'))
    const packed = zlib.deflateRawSync(data)
    const crc = zlib.crc32(data)
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(0x0800, 6)
    head.writeUInt16LE(8, 8)
    head.writeUInt16LE(0, 10)
    head.writeUInt16LE(0x21, 12)
    head.writeUInt32LE(crc, 14)
    head.writeUInt32LE(packed.length, 18)
    head.writeUInt32LE(data.length, 22)
    head.writeUInt16LE(nameBuf.length, 26)
    parts.push(head, nameBuf, packed)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(0x0800, 8)
    entry.writeUInt16LE(8, 10)
    entry.writeUInt16LE(0, 12)
    entry.writeUInt16LE(0x21, 14)
    entry.writeUInt32LE(crc, 16)
    entry.writeUInt32LE(packed.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(nameBuf.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, nameBuf)
    offset += 30 + nameBuf.length + packed.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, directory, end])
}

const root = path.join(__dirname, '..')
const targetPlugin = process.argv[2] || 'pterodactyl'
const pluginDir = path.join(root, 'plugins', targetPlugin)

if (!fs.existsSync(pluginDir)) {
  console.error(`Error: Plugin directory not found: ${pluginDir}`)
  process.exit(1)
}

const manifestPath = path.join(pluginDir, 'manifest.json')
const indexPath = path.join(pluginDir, 'index.js')

if (!fs.existsSync(manifestPath) || !fs.existsSync(indexPath)) {
  console.error(`Error: manifest.json or index.js missing in ${pluginDir}`)
  process.exit(1)
}

// Check syntax
console.log(`Checking syntax: node --check "${indexPath}"...`)
try {
  execSync(`node --check "${indexPath}"`, { stdio: 'inherit' })
} catch (e) {
  console.error('Syntax check failed!')
  process.exit(1)
}

const manifestRaw = fs.readFileSync(manifestPath)
const scriptRaw = fs.readFileSync(indexPath)

// Strip BOM if present
const manifestBuf = manifestRaw[0] === 0xef && manifestRaw[1] === 0xbb && manifestRaw[2] === 0xbf ? manifestRaw.slice(3) : manifestRaw
const scriptBuf = scriptRaw[0] === 0xef && scriptRaw[1] === 0xbb && scriptRaw[2] === 0xbf ? scriptRaw.slice(3) : scriptRaw

const manifest = JSON.parse(manifestBuf.toString('utf8'))
const pluginId = manifest.id || `asaprajx.${targetPlugin}`
const version = manifest.version || '1.0.0'

const distDir = path.join(root, 'dist')
fs.mkdirSync(distDir, { recursive: true })

const zip = createZip([
  ['manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')],
  ['index.js', scriptBuf],
])

const zipPath = path.join(distDir, `${pluginId}.zip`)
fs.writeFileSync(zipPath, zip)

const versionedZipPath = path.join(distDir, `${pluginId}-${version}.zip`)
fs.writeFileSync(versionedZipPath, zip)

const sha256 = crypto.createHash('sha256').update(zip).digest('hex')

console.log('----------------------------------------------------')
console.log(' Local Plugin Zip Built Successfully!')
console.log(' Plugin ID:   ', pluginId)
console.log(' Name:        ', manifest.name)
console.log(' Version:     ', version)
console.log(' Zip File:    ', zipPath)
console.log(' Size:        ', zip.length, 'bytes')
console.log(' SHA-256:     ', sha256)
console.log('----------------------------------------------------')
console.log(' NOTE: No changes have been pushed to GitHub.')
console.log('----------------------------------------------------')
