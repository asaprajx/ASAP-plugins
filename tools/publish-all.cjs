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
    ...(existingIndex.plugins || {})
  }
}

const pluginsDir = path.join(root, 'plugins')
const pluginFolders = fs.readdirSync(pluginsDir).filter(f => {
  const p = path.join(pluginsDir, f)
  return fs.statSync(p).isDirectory() &&
         fs.existsSync(path.join(p, 'manifest.json')) &&
         fs.existsSync(path.join(p, 'index.js'))
})

const publishedList = []

for (const folder of pluginFolders) {
  const pluginPath = path.join(pluginsDir, folder)
  const scriptBytes = fs.readFileSync(path.join(pluginPath, 'index.js'))
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginPath, 'manifest.json'), 'utf8'))
  const pluginId = manifest.id
  const version = manifest.version || '1.0.0'

  const zip = createZip([
    ['manifest.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8')],
    ['index.js', scriptBytes],
  ])
  const fileName = `${pluginId}@${version}.zip`
  fs.writeFileSync(path.join(poolDir, fileName), zip)

  index.plugins[pluginId] = {
    name: manifest.name,
    description: manifest.description,
    author: manifest.author,
    contributors: manifest.contributors,
    icon: manifest.icon || 'HelpIcon',
    channels: { latest: version },
    versions: {
      ...(existingIndex.plugins?.[pluginId]?.versions || {}),
      [version]: {
        url: `${baseUrl}/pool/${fileName}`,
        sha256: crypto.createHash('sha256').update(zip).digest('hex'),
        size: zip.length,
        dependencies: manifest.dependencies,
      }
    }
  }

  publishedList.push(`${pluginId} v${version}`)
  console.log(`Packaged: ${pluginId} v${version}`)
}

const jsonStr = JSON.stringify(index, null, 2) + '\n'
fs.writeFileSync(indexPath, jsonStr, { encoding: 'utf8', flag: 'w' })

execSync('git add index.json pool', { cwd: temp, stdio: 'inherit' })
try {
  const commitMsg = `Publish: ${publishedList.join(', ')}`
  execSync(`git commit -m "${commitMsg}"`, { cwd: temp, stdio: 'inherit' })
  execSync('git push origin gh-pages', { cwd: temp, stdio: 'inherit' })
  console.log(`SUCCESS: Published to gh-pages! (${publishedList.join(', ')})`)
} catch (e) {
  console.log('Commit or push error:', e.message)
}

fs.rmSync(temp, { recursive: true, force: true })
console.log('DONE!')
