'use strict'

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const crypto = require('node:crypto')
const os = require('node:os')
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
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'valenced-gh-'))
console.log('Cloning gh-pages to:', temp)
execSync(`git clone --branch gh-pages https://github.com/asaprajx/ASAP-plugins.git "${temp}"`, { stdio: 'inherit' })

const poolDir = path.join(temp, 'pool')
fs.mkdirSync(poolDir, { recursive: true })

const scriptBytes = fs.readFileSync(path.join(root, 'plugins', 'minecraft-servers', 'index.js'))
const marklongManifestRaw = fs.readFileSync(path.join(root, 'plugins', 'minecraft-servers', 'manifest.json'), 'utf8')
const marklongManifest = JSON.parse(marklongManifestRaw)
const marklongVersion = marklongManifest.version || '1.5.3'

const marklongZip = createZip([
  ['manifest.json', Buffer.from(JSON.stringify(marklongManifest, null, 2), 'utf8')],
  ['index.js', scriptBytes],
])
const marklongFile = `marklong.minecraft-servers@${marklongVersion}.zip`
fs.writeFileSync(path.join(poolDir, marklongFile), marklongZip)

const asapVersion = '2.0.4'
const asapManifest = {
  format: 1,
  id: 'asaprajx.minecraft-servers',
  name: 'Minecraft Servers',
  description: 'Save your Minecraft servers and see if they are online, how many players are on, who is playing, the ping, the software and the address. A Minecraft servers row appears in the + menu next to the message box.',
  author: 'asaprajx (https://github.com/asaprajx "GitHub")',
  contributors: [
    'MarkLong0467 (https://github.com/MarkLong0467 "Original Author")',
    'Server data from mcstatus.io, mcsrvstat.us and minetools.eu (public status websites)'
  ],
  icon: 'GameControllerIcon',
  version: asapVersion,
  dependencies: {
    'valenced.api': { version: '>=1 <2' },
    'discord': { version: '*' }
  },
  dist: { script: 'index.js' }
}
const asapManifestBytes = Buffer.from(JSON.stringify(asapManifest, null, 2), 'utf8')
const asapZip = createZip([
  ['manifest.json', asapManifestBytes],
  ['index.js', scriptBytes],
])
const asapFile = `asaprajx.minecraft-servers@${asapVersion}.zip`
fs.writeFileSync(path.join(poolDir, asapFile), asapZip)

const baseUrl = 'https://raw.githubusercontent.com/asaprajx/ASAP-plugins/gh-pages'
const indexPath = path.join(temp, 'index.json')
let existingIndex = {}
try {
  existingIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8'))
} catch {}

const index = {
  format: 1,
  name: 'ASAP Plugins',
  description: 'Custom plugins and enhancements for Valenced Discord mobile client.',
  plugins: {
    'asaprajx.minecraft-servers': {
      name: asapManifest.name,
      description: asapManifest.description,
      author: asapManifest.author,
      contributors: asapManifest.contributors,
      icon: asapManifest.icon,
      channels: { latest: asapVersion },
      versions: {
        ...(existingIndex.plugins?.['asaprajx.minecraft-servers']?.versions || {}),
        [asapVersion]: {
          url: `${baseUrl}/pool/${asapFile}`,
          sha256: crypto.createHash('sha256').update(asapZip).digest('hex'),
          size: asapZip.length,
          dependencies: asapManifest.dependencies,
        }
      }
    },
    'marklong.minecraft-servers': {
      name: marklongManifest.name,
      description: marklongManifest.description,
      author: marklongManifest.author,
      contributors: marklongManifest.contributors,
      channels: { latest: marklongVersion },
      versions: {
        ...(existingIndex.plugins?.['marklong.minecraft-servers']?.versions || {}),
        [marklongVersion]: {
          url: `${baseUrl}/pool/${marklongFile}`,
          sha256: crypto.createHash('sha256').update(marklongZip).digest('hex'),
          size: marklongZip.length,
          dependencies: marklongManifest.dependencies,
        }
      }
    }
  }
}

const jsonStr = JSON.stringify(index, null, 2) + '\n'
fs.writeFileSync(indexPath, jsonStr, { encoding: 'utf8', flag: 'w' })

execSync('git add index.json pool', { cwd: temp, stdio: 'inherit' })
try {
  execSync(`git commit -m "Update: remove ping calibration card (v${asapVersion} / v${marklongVersion})"`, { cwd: temp, stdio: 'inherit' })
  execSync('git push origin gh-pages', { cwd: temp, stdio: 'inherit' })
  console.log('SUCCESS: Pushed accurate ping update to gh-pages!')
} catch (e) {
  console.log('Commit or push error:', e.message)
}

fs.rmSync(temp, { recursive: true, force: true })
console.log('DONE!')
