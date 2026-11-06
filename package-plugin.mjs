import fs from 'node:fs'
import path from 'node:path'
import { execSync } from 'node:child_process'
import AdmZip from 'adm-zip'

const root = process.cwd()
const dist = path.join(root, 'build', 'dist')
const manifestPath = path.join(root, 'plugins', 'minecraft-servers', 'manifest.json')
const indexPath = path.join(root, 'plugins', 'minecraft-servers', 'build', 'js', 'index.js')

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const zipName = `${manifest.id}@${manifest.version}.zip`

if (!fs.existsSync(dist)) fs.mkdirSync(dist, { recursive: true })

const zip = new AdmZip()
zip.addLocalFile(manifestPath)
zip.addLocalFile(indexPath)
zip.writeZip(path.join(dist, zipName))

console.log(`Packaged ${zipName}`)

execSync(
  `bun run generate-index --dist build/dist --base-url https://raw.githubusercontent.com/asaprajx/valenced-plugin-template/gh-pages/pool --out build/dist/index.json`,
  { stdio: 'inherit' }
)
