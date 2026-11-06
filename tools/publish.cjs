'use strict'

/**
 * Packages plugins and adds them to a repository index.
 *
 * Usage:
 *   node tools/publish.cjs <index-folder> <base-url> [plugin-folder-name ...]
 *
 * - `<index-folder>` holds `index.json` and a `pool/` folder (the `gh-pages` branch checked out somewhere).
 * - `<base-url>` is where that folder is served, for example
 *   `https://raw.githubusercontent.com/MarkLong0467/EskimoPlugins/gh-pages`.
 * - With no plugin names, every plugin under `plugins/` is packaged.
 *
 * For each plugin it:
 * 1. reads `plugins/<name>/manifest.json`,
 * 2. takes the script from `build/js/index.js` (the output of `bun run build`), or from the manifest's `dist.script`
 *    for a plugin that ships a ready-made bundle,
 * 3. writes `pool/<id>@<version>.zip` with `manifest.json` and `index.js` (the same layout the Valenced packaging
 *    produces),
 * 4. adds the version to `index.json` and makes it the `latest` channel.
 *
 * Rules that keep a release safe:
 * - Nothing is ever deleted from `pool/`, and older versions stay in the index, so a plugin can be rolled back.
 * - A zip that already exists is never overwritten. Publishing the same version with different content is refused:
 *   bump the version in the manifest instead.
 * - Entries of plugins that were not named are not touched, and the order of the index is kept.
 * - Run `bun run build` (the production build) first. `bun run test` does that and runs the tests.
 */

const fs = require('node:fs')
const path = require('node:path')
const zlib = require('node:zlib')
const crypto = require('node:crypto')

const [indexDir, baseUrl, ...names] = process.argv.slice(2)
if (!indexDir || !baseUrl) {
	console.error('usage: node tools/publish.cjs <index-folder> <base-url> [plugin-folder-name ...]')
	process.exit(1)
}

const pluginsDir = path.join(__dirname, '..', 'plugins')

/**
 * Builds a ZIP file in memory from `[name, Buffer]` pairs. The modification time is fixed (1980-01-01), so the same
 * input always gives the same bytes and a zip can be compared with an earlier one.
 */
function zip(files) {
	const parts = []
	const central = []
	let offset = 0
	for (const [name, data] of files) {
		const nameBuf = Buffer.from(name)
		const packed = zlib.deflateRawSync(data)
		const crc = zlib.crc32(data)

		const head = Buffer.alloc(30)
		head.writeUInt32LE(0x04034b50, 0)
		head.writeUInt16LE(20, 4)
		head.writeUInt16LE(0x0800, 6) // UTF-8 names
		head.writeUInt16LE(8, 8) // deflate
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

/** The bytes of a plugin's script: the production build if there is one, otherwise the file the manifest names. */
function readScript(dir, manifest) {
	const built = path.join(dir, 'build', 'js', 'index.js')
	if (fs.existsSync(built)) return fs.readFileSync(built)
	return fs.readFileSync(path.join(dir, manifest.dist.script))
}

const indexPath = path.join(indexDir, 'index.json')
const rawIndex = fs.existsSync(indexPath) ? fs.readFileSync(indexPath, 'utf8') : ''
const crlf = rawIndex.includes('\r\n')
const index = rawIndex
	? JSON.parse(rawIndex)
	: { format: 1, name: 'EskimoPlugins', description: 'Plugins for Valenced.', plugins: {} }

fs.mkdirSync(path.join(indexDir, 'pool'), { recursive: true })

const wanted = names.length ? names : fs.readdirSync(pluginsDir)
let failed = false

for (const folder of wanted) {
	const dir = path.join(pluginsDir, folder)
	const manifestPath = path.join(dir, 'manifest.json')
	if (!fs.existsSync(manifestPath)) {
		if (names.length) {
			console.error(`${folder}: no manifest.json`)
			failed = true
		}
		continue
	}

	const manifestRaw = fs.readFileSync(manifestPath)
	const manifest = JSON.parse(manifestRaw)
	const script = readScript(dir, manifest)
	const archive = zip([
		['manifest.json', manifestRaw],
		['index.js', script],
	])

	const file = `${manifest.id}@${manifest.version}.zip`
	const target = path.join(indexDir, 'pool', file)
	if (fs.existsSync(target) && !fs.readFileSync(target).equals(archive)) {
		console.error(`${folder}: ${file} already exists with different content. Bump the version in manifest.json.`)
		failed = true
		continue
	}
	if (!fs.existsSync(target)) fs.writeFileSync(target, archive)
	const published = fs.readFileSync(target)

	// Update the entry in place, so the order of its fields and of the whole index stays as it was.
	const entry = index.plugins[manifest.id] ?? { name: manifest.name, description: manifest.description, author: manifest.author, channels: {}, versions: {} }
	entry.name = manifest.name
	entry.description = manifest.description
	entry.author = manifest.author
	if (manifest.contributors || 'contributors' in entry) entry.contributors = manifest.contributors ?? entry.contributors
	entry.channels = { ...entry.channels, latest: manifest.version }
	entry.versions = {
		...entry.versions,
		[manifest.version]: {
			url: `${baseUrl.replace(/\/$/, '')}/pool/${file}`,
			sha256: crypto.createHash('sha256').update(published).digest('hex'),
			size: published.length,
			dependencies: manifest.dependencies,
		},
	}
	index.plugins[manifest.id] = entry
	console.log(`${manifest.id} ${manifest.version}: ${published.length} bytes`)
}

if (failed) process.exit(1)

const text = `${JSON.stringify(index, null, 2)}\n`
fs.writeFileSync(indexPath, crlf ? text.replace(/\n/g, '\r\n') : text)
