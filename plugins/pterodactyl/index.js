(function (exports) {
	/*
	 * Pterodactyl Server Controller for Valenced Discord Mobile.
	 * Modern Discord Mobile UI overhaul: sleek capsule navigation, hero server cards, visual resource gauges,
	 * Minecraft player hub, IDE-style terminal console, file explorer, and server manager.
	 * Keep `(function` as the first thing in this file: Valenced loads it as `return <file>`.
	 */
	var PLUGIN_ID = 'asaprajx.pterodactyl'
	var SHEET_KEY = 'asaprajx.pterodactyl.panel'
	var VIEWER_SHEET_KEY = 'asaprajx.pterodactyl.fileviewer'
	var PLAYER_SHEET_KEY = 'asaprajx.pterodactyl.playeractions'
	var TOAST_ID = 'ASAP_PTERODACTYL'

	// ---- Modern Discord Color Tokens --------------------------------------------------------
	var GREEN = '#23a55a'
	var RED = '#f23f43'
	var AMBER = '#f0b232'
	var GRAY = '#80848e'
	var BLURPLE = '#5865f2'
	var CRIMSON = '#da373c'

	var BG_BASE = '#111214'
	var BG_SURFACE = '#1e1f22'
	var BG_RAISED = '#2b2d31'
	var BG_HOVER = '#35373c'
	var BORDER_SUBTLE = 'rgba(255, 255, 255, 0.07)'
	var TEXT_NORMAL = '#f2f3f5'
	var TEXT_MUTED = '#949ba4'

	var defaults = {
		panelUrl: 'https://panel.altare.global',
		apiKey: '',
		defaultServerId: 'ed321e1e',
		autoRefresh: 15,
		serverAliases: {}
	}

	var storage
	var listeners = []
	var timers = []
	var toastSeq = 0
	var state = {
		servers: [],
		selectedServerId: 'ed321e1e',
		serverDetails: {},
		serverStats: null,
		loadingStats: false,
		lastError: '',
		currentDir: '/',
		files: [],
		loadingFiles: false,
		logs: '',
		logLines: [],
		loadingLogs: false,
		history: [],
		// Players state
		onlinePlayers: [],
		onlinePlayerCount: 0,
		maxPlayerCount: 20,
		serverMotd: '',
		serverFavicon: null,
		knownPlayers: [],
		opsList: [],
		whitelist: [],
		loadingPlayers: false,
		statusProvider: ''
	}

	function finders() { return valenced.modules.finders }
	function Design() { return valenced.discord.design.Design }

	// ---- Helpers ----------------------------------------------------------------------------
	function tint(hex, alpha) {
		var m = /^#([0-9a-f]{6})$/i.exec(hex)
		if (!m) return hex
		var n = parseInt(m[1], 16)
		return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + alpha + ')'
	}

	function clearCookies() {
		try {
			var RN = valenced.react.ReactNative
			var nm = RN && RN.NativeModules
			var net = nm && (nm.Networking || nm.RCTNetworking)
			if (net && typeof net.clearCookies === 'function') {
				net.clearCookies(function () {})
			}
		} catch (e) {}
	}

	function cleanPanelUrl(raw) {
		var s = String(raw || '').trim()
		if (!s) return 'https://panel.altare.global'
		var m = s.match(/^(https?:\/\/[^\/]+)/i)
		return m ? m[1] : s.replace(/\/+$/, '')
	}

	function extractServerIdFromUrl(raw) {
		var s = String(raw || '').trim()
		var m = s.match(/\/server\/([a-zA-Z0-9_-]+)/i)
		return m ? m[1] : null
	}

	function setting(key) {
		var s = storage && storage.cache
		return s && s[key] !== undefined ? s[key] : defaults[key]
	}

	function saveSetting(patch) {
		if (patch && patch.panelUrl) {
			var extracted = extractServerIdFromUrl(patch.panelUrl)
			patch.panelUrl = cleanPanelUrl(patch.panelUrl)
			if (extracted && !patch.defaultServerId) {
				patch.defaultServerId = extracted
				state.selectedServerId = extracted
			}
		}
		try { if (storage && typeof storage.set === 'function') storage.set(patch) } catch (e) {}
		try { if (storage && storage.cache) Object.assign(storage.cache, patch) } catch (e) {}
		clearCookies()
	}

	function migrateStoredSettings() {
		try {
			var cache = storage && storage.cache
			if (cache && cache.panelUrl) {
				var raw = cache.panelUrl
				var cleaned = cleanPanelUrl(raw)
				var extracted = extractServerIdFromUrl(raw)
				var patch = {}
				if (raw !== cleaned) patch.panelUrl = cleaned
				if (extracted && !cache.defaultServerId) {
					patch.defaultServerId = extracted
					state.selectedServerId = extracted
				}
				if (Object.keys(patch).length > 0) {
					saveSetting(patch)
				}
			}
		} catch (e) {}
	}

	function getServerDisplayName(server) {
		if (!server) return 'Pterodactyl Server'
		var aliases = setting('serverAliases') || {}
		return aliases[server.id] || server.name || 'Pterodactyl Server'
	}

	function setServerAlias(serverId, newName) {
		var id = serverId || getActiveServerId()
		var aliases = Object.assign({}, setting('serverAliases') || {})
		var trimmed = String(newName || '').trim()
		if (trimmed) {
			aliases[id] = trimmed
			toast('Server renamed to "' + trimmed + '" (local only)')
		} else {
			delete aliases[id]
			toast('Server name reset to default')
		}
		saveSetting({ serverAliases: aliases })
		changed()
	}

	function changed() {
		listeners.slice().forEach(function (l) { try { l() } catch (e) {} })
	}

	function toast(text) {
		try {
			toastSeq = (toastSeq + 1) % 1000
			valenced.discord.actions.ToastActionCreators.open(TOAST_ID + '_' + toastSeq, { text: String(text) })
		} catch (e) {
			try { valenced.discord.actions.ToastActionCreators.open(TOAST_ID, { text: String(text) }) } catch (e2) {}
		}
	}

	function copyText(str, label) {
		try {
			if (valenced.externals && valenced.externals.ReactNativeClipboard && valenced.externals.ReactNativeClipboard.Clipboard) {
				valenced.externals.ReactNativeClipboard.Clipboard.setString(String(str || ''))
			} else if (valenced.react.ReactNative && valenced.react.ReactNative.Clipboard) {
				valenced.react.ReactNative.Clipboard.setString(String(str || ''))
			}
			toast((label || 'Text') + ' copied to clipboard')
		} catch (e) {
			toast('Could not copy')
		}
	}

	function h(type, props) {
		var children = Array.prototype.slice.call(arguments, 2)
		var rt = valenced.react.ReactJSXRuntime
		var p = Object.assign({}, props)
		var key = p.key
		delete p.key
		if (children.length === 1) p.children = children[0]
		else if (children.length > 1) p.children = children
		return (children.length > 1 ? rt.jsxs : rt.jsx)(type, p, key)
	}

	function T(props, text) {
		var D = Design()
		var p = Object.assign({}, props)
		p.style = Object.assign({ includeFontPadding: false }, p.style || {})
		return h(D.Text, p, text)
	}

	function errorText(e) {
		return String((e && e.message) || e)
	}

	function getPanelUrl() {
		return cleanPanelUrl(setting('panelUrl'))
	}

	function getApiKey() {
		return String(setting('apiKey') || '').trim()
	}

	function getActiveServerId() {
		return state.selectedServerId || setting('defaultServerId') || extractServerIdFromUrl(setting('panelUrl')) || 'ed321e1e'
	}

	function formatBytes(bytes) {
		if (!bytes || isNaN(bytes)) return '0 B'
		var b = Number(bytes)
		if (b < 1024) return b + ' B'
		if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB'
		if (b < 1024 * 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + ' MB'
		return (b / (1024 * 1024 * 1024)).toFixed(2) + ' GB'
	}

	function formatUptime(seconds) {
		if (!seconds || isNaN(seconds)) return 'Offline'
		var s = Math.floor(Number(seconds))
		var d = Math.floor(s / 86400)
		var h = Math.floor((s % 86400) / 3600)
		var m = Math.floor((s % 3600) / 60)
		if (d > 0) return d + 'd ' + h + 'h ' + m + 'm'
		if (h > 0) return h + 'h ' + m + 'm'
		return m + 'm ' + (s % 60) + 's'
	}

	// Safe BottomSheet / ActionSheet ScrollView with ErrorBoundary fallback
	var scrollPick = null
	var boundaryClass = null
	function sheetScrollComponent() {
		var RN = valenced.react.ReactNative
		if (scrollPick) return scrollPick
		var pick = RN.ScrollView
		try {
			var D = valenced.discord.design.Design
			var c = D && (D.BottomSheetScrollView || D.ActionSheetScrollView)
			if (!c) {
				var f = finders()
				var m = f.lookupModule(f.filters.withProps('BottomSheetScrollView'))[0]
				c = m && m.BottomSheetScrollView
			}
			if (c) pick = c
		} catch (e) {}
		scrollPick = pick
		return pick
	}

	function scrollBoundary() {
		if (boundaryClass) return boundaryClass
		var React = valenced.react.React
		if (!React || typeof React.Component !== 'function') return null
		boundaryClass = class extends React.Component {
			constructor(p) { super(p); this.state = { bad: false } }
			static getDerivedStateFromError() { return { bad: true } }
			componentDidCatch() {}
			render() { return this.state.bad ? this.props.fallback : this.props.children }
		}
		return boundaryClass
	}

	function scrollView(RN, scrollProps, children) {
		var Scroll = sheetScrollComponent()
		var plain = h(RN.ScrollView, scrollProps, children)
		var Boundary = Scroll === RN.ScrollView ? null : scrollBoundary()
		if (!Boundary) return plain
		return h(Boundary, { fallback: plain }, h(Scroll, scrollProps, children))
	}

	// ---- Modern UI Design Blocks ------------------------------------------------------------
	function Card(props) {
		var RN = valenced.react.ReactNative
		return h(
			RN.View,
			{
				style: Object.assign({
					backgroundColor: BG_SURFACE,
					borderRadius: 14,
					padding: 14,
					borderWidth: 1,
					borderColor: BORDER_SUBTLE,
					marginBottom: 10
				}, props.style || {})
			},
			props.children
		)
	}

	function StatusPill(props) {
		var RN = valenced.react.ReactNative
		var c = props.color || GRAY
		return h(
			RN.View,
			{
				style: {
					flexDirection: 'row',
					alignItems: 'center',
					justifyContent: 'center',
					height: 24,
					paddingHorizontal: 8,
					borderRadius: 12,
					backgroundColor: tint(c, 0.16)
				}
			},
			h(RN.View, { style: { width: 6, height: 6, borderRadius: 3, backgroundColor: c, marginRight: 5 } }),
			T({ variant: 'text-xs/bold', style: { color: c, textTransform: 'uppercase', includeFontPadding: false, textAlignVertical: 'center' } }, props.text)
		)
	}

	function ProgressBar(props) {
		var RN = valenced.react.ReactNative
		var val = Math.min(100, Math.max(0, Number(props.percent) || 0))
		var c = props.color || GREEN
		return h(
			RN.View,
			{ style: { height: 4, borderRadius: 2, backgroundColor: BG_RAISED, overflow: 'hidden', marginTop: 6 } },
			h(RN.View, { style: { width: val + '%', height: '100%', borderRadius: 2, backgroundColor: c } })
		)
	}

	function StatWidget(props) {
		var RN = valenced.react.ReactNative
		return h(
			RN.View,
			{
				style: Object.assign({
					flex: 1,
					backgroundColor: BG_SURFACE,
					borderRadius: 14,
					padding: 12,
					borderWidth: 1,
					borderColor: BORDER_SUBTLE
				}, props.style || {})
			},
			T({ variant: 'text-xs/semibold', style: { color: TEXT_MUTED } }, props.label),
			T({ variant: 'heading-sm/bold', style: { color: TEXT_NORMAL, marginTop: 2 } }, props.value),
			props.percent != null ? h(ProgressBar, { percent: props.percent, color: props.color || GREEN }) : null,
			props.sub ? T({ variant: 'text-xs/medium', style: { color: TEXT_MUTED, marginTop: 4 } }, props.sub) : null
		)
	}

	// ======================================================================================
	// API Client
	// ======================================================================================
	function apiRequest(path, options) {
		options = options || {}
		var panel = getPanelUrl()
		var key = getApiKey()
		if (!key) {
			return Promise.reject(new Error('Please set your Pterodactyl API Key in Config.'))
		}

		var url = panel + path
		var headers = {
			'Authorization': 'Bearer ' + key,
			'Accept': 'application/json',
			'X-Requested-With': 'XMLHttpRequest',
			'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ValencedPterodactyl/1.0'
		}
		if (options.headers) {
			Object.assign(headers, options.headers)
		}

		var fetchOpts = {
			method: options.method || 'GET',
			headers: headers,
			body: options.body,
			credentials: 'omit'
		}

		return fetch(url, fetchOpts).then(function (res) {
			if (res.status === 204) return { success: true }
			if (res.status === 419 && !options._retried) {
				clearCookies()
				options._retried = true
				return apiRequest(path, options)
			}
			return res.text().then(function (text) {
				if (!res.ok) {
					var msg = 'HTTP ' + res.status
					try {
						var j = JSON.parse(text)
						if (j.errors && j.errors.length) {
							msg += ': ' + (j.errors[0].detail || j.errors[0].code)
						}
					} catch (e) {}
					throw new Error(msg)
				}
				try {
					return JSON.parse(text)
				} catch (e) {
					return text
				}
			})
		})
	}

	function fetchServers() {
		return apiRequest('/api/client').then(function (res) {
			var list = (res && res.data) || []
			state.servers = list.map(function (item) {
				var a = item.attributes || {}
				return {
					id: a.identifier,
					uuid: a.uuid,
					name: a.name,
					node: a.node,
					sftp: (a.sftp_details && a.sftp_details.ip ? a.sftp_details.ip + ':' + a.sftp_details.port : ''),
					limits: a.limits || {}
				}
			})
			if (!state.selectedServerId && state.servers.length) {
				state.selectedServerId = state.servers[0].id
			}
			changed()
			fetchServerDetails(state.selectedServerId)
			return state.servers
		}).catch(function (err) {
			state.lastError = errorText(err)
			changed()
			throw err
		})
	}

	function fetchServerDetails(serverId) {
		var id = serverId || getActiveServerId()
		if (!id) return Promise.resolve(null)
		return apiRequest('/api/client/servers/' + id).then(function (res) {
			var attr = (res && res.attributes) || {}
			var rel = (attr.relationships && attr.relationships.allocations && attr.relationships.allocations.data) || []
			var host = null
			var port = null
			for (var i = 0; i < rel.length; i++) {
				var a = rel[i].attributes || {}
				if (a.is_default || !host) {
					host = a.ip_alias || a.ip
					port = a.port
				}
			}
			if (!host && attr.sftp_details) {
				host = attr.sftp_details.ip
				port = 25565
			}
			state.serverDetails[id] = {
				id: id,
				name: attr.name,
				host: host || 'in-mum01.altare.global',
				port: port || 25297
			}
			changed()
			return state.serverDetails[id]
		}).catch(function () {})
	}

	function fetchResources(serverId) {
		var id = serverId || getActiveServerId()
		if (!id) return Promise.reject(new Error('No server selected'))
		state.loadingStats = true
		changed()

		return apiRequest('/api/client/servers/' + id + '/resources').then(function (res) {
			state.loadingStats = false
			state.serverStats = res.attributes || {}
			state.lastError = ''
			changed()
			return state.serverStats
		}).catch(function (err) {
			state.loadingStats = false
			state.lastError = errorText(err)
			changed()
			throw err
		})
	}

	function sendPower(serverId, signal) {
		var id = serverId || getActiveServerId()
		if (!id) return Promise.reject(new Error('No server selected'))
		clearCookies()
		toast('Sending ' + signal + ' signal...')
		return apiRequest('/api/client/servers/' + id + '/power', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ signal: signal })
		}).then(function () {
			toast('Power signal sent: ' + signal)
			setTimeout(function () { fetchResources(id) }, 1500)
		}).catch(function (err) {
			toast('Power error: ' + errorText(err))
		})
	}

	function sendCommand(serverId, cmd) {
		var id = serverId || getActiveServerId()
		var cleanCmd = String(cmd || '').trim()
		if (!id) return Promise.reject(new Error('No server selected'))
		if (!cleanCmd) return Promise.reject(new Error('Enter a command'))
		clearCookies()

		return apiRequest('/api/client/servers/' + id + '/command', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ command: cleanCmd })
		}).then(function () {
			toast('Command executed: ' + cleanCmd)
			addHistory(cleanCmd)
			setTimeout(function () { fetchLogs(id) }, 1200)
		}).catch(function (err) {
			toast('Command error: ' + errorText(err))
		})
	}

	function fetchFiles(serverId, dir) {
		var id = serverId || getActiveServerId()
		var d = dir || state.currentDir || '/'
		state.loadingFiles = true
		state.currentDir = d
		changed()

		return apiRequest('/api/client/servers/' + id + '/files/list?directory=' + encodeURIComponent(d)).then(function (res) {
			state.loadingFiles = false
			var list = (res && res.data) || []
			state.files = list.map(function (item) { return item.attributes || {} })
			changed()
		}).catch(function (err) {
			state.loadingFiles = false
			state.lastError = errorText(err)
			toast('Files error: ' + errorText(err))
			changed()
		})
	}

	function readFile(serverId, filePath) {
		var id = serverId || getActiveServerId()
		return apiRequest('/api/client/servers/' + id + '/files/contents?file=' + encodeURIComponent(filePath))
	}

	function fetchLogs(serverId) {
		var id = serverId || getActiveServerId()
		state.loadingLogs = true
		changed()
		return readFile(id, 'logs/latest.log').then(function (content) {
			state.loadingLogs = false
			if (typeof content === 'string') {
				var raw = content.split('\n')
				state.logLines = raw.filter(function (l) { return l.length > 0 })
				state.logs = state.logLines.slice(-60).join('\n')
			}
			changed()
		}).catch(function (err) {
			state.loadingLogs = false
			state.logs = 'Failed to load logs/latest.log: ' + errorText(err)
			changed()
		})
	}

	// ======================================================================================
	// Multi-Service Status Engine (Zero Pterodactyl Rate Limits)
	// ======================================================================================
	function queryStatusTimeout(url, ms) {
		return new Promise(function (resolve, reject) {
			var timer = setTimeout(function () { reject(new Error('Timeout')) }, ms || 4000)
			fetch(url, { headers: { 'User-Agent': 'ValencedPterodactyl/1.0' } })
				.then(function (res) {
					clearTimeout(timer)
					if (!res.ok) throw new Error('HTTP ' + res.status)
					return res.json()
				})
				.then(function (data) {
					clearTimeout(timer)
					resolve(data)
				})
				.catch(function (err) {
					clearTimeout(timer)
					reject(err)
				})
		})
	}

	function queryMinecraftStatus(host, port) {
		var target = encodeURIComponent(host + ':' + (port || 25565))
		var cleanHost = encodeURIComponent(host)
		var cleanPort = encodeURIComponent(port || 25565)

		var tryMcstatus = function () {
			return queryStatusTimeout('https://api.mcstatus.io/v2/status/java/' + target, 3500).then(function (data) {
				if (!data || !data.online) throw new Error('Offline or invalid data')
				var pInfo = data.players || {}
				var list = (pInfo.list && Array.isArray(pInfo.list)) ? pInfo.list.map(function (p) {
					return { name: p.name_clean || p.name_raw || p.name || 'Player', uuid: p.uuid || '' }
				}) : []
				return {
					provider: 'mcstatus.io',
					online: true,
					playerCount: Number(pInfo.online) || 0,
					maxPlayers: Number(pInfo.max) || 20,
					players: list,
					motd: data.motd && data.motd.clean ? data.motd.clean : '',
					icon: data.icon || null
				}
			})
		}

		var tryMcsrvstat = function () {
			return queryStatusTimeout('https://api.mcsrvstat.us/3/' + target, 3500).then(function (data) {
				if (!data || !data.online) throw new Error('Offline or invalid data')
				var pInfo = data.players || {}
				var list = []
				if (pInfo.list && Array.isArray(pInfo.list)) {
					list = pInfo.list.map(function (p) {
						if (typeof p === 'string') return { name: p, uuid: '' }
						return { name: p.name || 'Player', uuid: p.uuid || '' }
					})
				}
				return {
					provider: 'mcsrvstat.us',
					online: true,
					playerCount: Number(pInfo.online) || 0,
					maxPlayers: Number(pInfo.max) || 20,
					players: list,
					motd: data.motd && data.motd.clean && data.motd.clean.length ? data.motd.clean.join('\n') : '',
					icon: data.icon || null
				}
			})
		}

		var tryMinetools = function () {
			return queryStatusTimeout('https://api.minetools.eu/ping/' + cleanHost + '/' + cleanPort, 3500).then(function (data) {
				if (!data || data.error) throw new Error('Offline or invalid data')
				var pInfo = data.players || {}
				var list = []
				if (pInfo.sample && Array.isArray(pInfo.sample)) {
					list = pInfo.sample.map(function (p) {
						return { name: p.name || 'Player', uuid: p.id || '' }
					})
				}
				return {
					provider: 'minetools.eu',
					online: true,
					playerCount: Number(pInfo.online) || 0,
					maxPlayers: Number(pInfo.max) || 20,
					players: list,
					motd: data.description || '',
					icon: data.favicon || null
				}
			})
		}

		return tryMcstatus().catch(function () {
			return tryMcsrvstat().catch(function () {
				return tryMinetools()
			})
		})
	}

	function fetchPlayers(serverId) {
		var id = serverId || getActiveServerId()
		if (!id) return Promise.reject(new Error('No server selected'))
		state.loadingPlayers = true
		changed()

		var details = state.serverDetails[id] || {}
		var host = details.host || 'in-mum01.altare.global'
		var port = details.port || 25297

		var usercachePromise = readFile(id, 'usercache.json').then(function (content) {
			try {
				var parsed = typeof content === 'string' ? JSON.parse(content) : content
				if (Array.isArray(parsed)) {
					state.knownPlayers = parsed.map(function (p) {
						return { name: p.name || 'Player', uuid: p.uuid || '' }
					})
				}
			} catch (e) {
				state.knownPlayers = []
			}
		}).catch(function () {
			state.knownPlayers = []
		})

		var opsPromise = readFile(id, 'ops.json').then(function (content) {
			try {
				var parsed = typeof content === 'string' ? JSON.parse(content) : content
				if (Array.isArray(parsed)) {
					state.opsList = parsed.map(function (o) { return String(o.name || '').toLowerCase() })
				}
			} catch (e) {
				state.opsList = []
			}
		}).catch(function () {
			state.opsList = []
		})

		var whitelistPromise = readFile(id, 'whitelist.json').then(function (content) {
			try {
				var parsed = typeof content === 'string' ? JSON.parse(content) : content
				if (Array.isArray(parsed)) {
					state.whitelist = parsed.map(function (w) { return String(w.name || '').toLowerCase() })
				}
			} catch (e) {
				state.whitelist = []
			}
		}).catch(function () {
			state.whitelist = []
		})

		var statusPromise = queryMinecraftStatus(host, port).then(function (res) {
			state.statusProvider = res.provider
			state.onlinePlayerCount = res.playerCount
			state.maxPlayerCount = res.maxPlayers
			state.onlinePlayers = res.players
			if (res.icon) state.serverFavicon = res.icon
			if (res.motd) state.serverMotd = res.motd
		}).catch(function () {
			state.statusProvider = 'none'
			state.onlinePlayerCount = 0
			state.onlinePlayers = []
		})

		return Promise.all([usercachePromise, opsPromise, whitelistPromise, statusPromise]).then(function () {
			state.loadingPlayers = false
			changed()
		}).catch(function () {
			state.loadingPlayers = false
			changed()
		})
	}

	function addHistory(cmd) {
		var hList = state.history
		if (hList.indexOf(cmd) === -1) {
			hList.unshift(cmd)
			if (hList.length > 15) hList.pop()
			changed()
		}
	}

	// ======================================================================================
	// UI Components
	// ======================================================================================

	function FileViewerSheet(props) {
		var RN = valenced.react.ReactNative
		var D = Design()
		var size = RN.useWindowDimensions ? RN.useWindowDimensions() : { height: 800 }
		var windowHeight = (size && size.height) || 800
		var viewerHeight = Math.max(340, Math.round(windowHeight * 0.62))

		return h(
			D.ActionSheet,
			null,
			// Header
			h(
				RN.View,
				{ style: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 14, marginBottom: 10 } },
				h(
					RN.View,
					{ style: { flex: 1, marginRight: 10 } },
					T({ variant: 'heading-md/bold', style: { color: TEXT_NORMAL } }, props.fileName),
					T({ variant: 'text-xs/medium', style: { color: TEXT_MUTED } }, props.filePath)
				),
				h(
					RN.TouchableOpacity,
					{
						onPress: function () {
							try { valenced.discord.actions.ActionSheetActionCreators.hideActionSheet(VIEWER_SHEET_KEY) } catch (e) {}
						},
						style: { backgroundColor: BG_RAISED, width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' }
					},
					T({ variant: 'text-xs/bold', style: { color: TEXT_MUTED } }, '✕')
				)
			),
			// Content Area
			scrollView(
				RN,
				{
					style: {
						height: viewerHeight,
						backgroundColor: '#0c0d0e',
						borderRadius: 12,
						marginHorizontal: 14,
						borderWidth: 1,
						borderColor: BORDER_SUBTLE
					},
					contentContainerStyle: {
						padding: 12,
						paddingBottom: 24,
						flexGrow: 1
					},
					nestedScrollEnabled: true
				},
				T({ variant: 'code', style: { color: '#dbdee1', fontSize: 11, fontFamily: 'monospace', lineHeight: 16 } }, props.content || '(Empty file)')
			),
			// Action Bar
			h(
				RN.View,
				{ style: { flexDirection: 'row', paddingHorizontal: 14, paddingTop: 10, paddingBottom: 20 } },
				h(
					RN.TouchableOpacity,
					{
						onPress: function () { copyText(props.content || '', props.fileName) },
						style: { flex: 1, height: 40, backgroundColor: BG_RAISED, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginRight: 8 }
					},
					T({ variant: 'text-sm/bold', style: { color: TEXT_NORMAL } }, 'Copy Content')
				),
				h(
					RN.TouchableOpacity,
					{
						onPress: function () {
							try { valenced.discord.actions.ActionSheetActionCreators.hideActionSheet(VIEWER_SHEET_KEY) } catch (e) {}
						},
						style: { flex: 1, height: 40, backgroundColor: BLURPLE, borderRadius: 10, alignItems: 'center', justifyContent: 'center' }
					},
					T({ variant: 'text-sm/bold', style: { color: '#ffffff' } }, 'Close')
				)
			)
		)
	}

	function openFileViewer(fileName, filePath, content) {
		try {
			valenced.discord.actions.ActionSheetActionCreators.openLazy(
				Promise.resolve({ default: function () { return h(FileViewerSheet, { fileName: fileName, filePath: filePath, content: content }) } }),
				VIEWER_SHEET_KEY,
				{}
			)
		} catch (e) {
			toast('Could not open file viewer: ' + errorText(e))
		}
	}

	function Panel() {
		var React = valenced.react.React
		var RN = valenced.react.ReactNative
		var D = Design()

		var size = RN.useWindowDimensions ? RN.useWindowDimensions() : { height: 800 }
		var windowHeight = (size && size.height) || 800
		var sheetMinHeight = Math.max(380, Math.round(windowHeight * 0.65))
		var sheetMaxHeight = Math.max(480, Math.round(windowHeight * 0.82))

		// Reactive States
		var tabState = React.useState('status')
		var activeTab = tabState[0]
		var setActiveTab = tabState[1]

		var tickState = React.useState(0)
		var setTick = tickState[1]

		// Controlled command input
		var commandInputState = React.useState('')
		var commandText = commandInputState[0]
		var setCommandText = commandInputState[1]

		// Log ordering ('bottom' = latest at bottom, 'top' = latest at top)
		var logOrderState = React.useState('bottom')
		var logOrder = logOrderState[0]
		var setLogOrder = logOrderState[1]
		var logScrollRef = React.useRef(null)

		// Inline Server Rename editing state
		var editingNameState = React.useState(false)
		var isEditingName = editingNameState[0]
		var setIsEditingName = editingNameState[1]
		var newNameInputRef = React.useRef('')

		// Selected player for Player Actions view (Sub-view inside Players Tab)
		var selectedPlayerState = React.useState(null)
		var selectedPlayer = selectedPlayerState[0]
		var setSelectedPlayer = selectedPlayerState[1]

		// Hook listener for background state updates
		React.useEffect(function () {
			clearCookies()
			migrateStoredSettings()

			var onUpdate = function () { setTick(function (n) { return n + 1 }) }
			listeners.push(onUpdate)

			var id = getActiveServerId()
			if (getApiKey()) {
				fetchServers().then(function () {
					fetchResources(id)
					fetchServerDetails(id)
				}).catch(function () {})
			}

			var refreshInterval = Number(setting('autoRefresh')) || 15
			var timer = refreshInterval > 0 ? setInterval(function () {
				fetchResources(getActiveServerId()).catch(function () {})
			}, refreshInterval * 1000) : null

			return function () {
				listeners = listeners.filter(function (l) { return l !== onUpdate })
				if (timer) clearInterval(timer)
			}
		}, [])

		// Auto-scroll to bottom of logs when in chronological mode
		React.useEffect(function () {
			if (activeTab === 'console' && logOrder === 'bottom' && logScrollRef.current) {
				setTimeout(function () {
					try {
						if (logScrollRef.current && typeof logScrollRef.current.scrollToEnd === 'function') {
							logScrollRef.current.scrollToEnd({ animated: true })
						}
					} catch (e) {}
				}, 150)
			}
		}, [state.logs, logOrder, activeTab])

		var currentServerId = getActiveServerId()
		var selectedServer = state.servers.find(function (s) { return s.id === currentServerId }) || { name: 'Pterodactyl Server', id: currentServerId }
		var serverDisplayName = getServerDisplayName(selectedServer)
		var stats = state.serverStats || {}
		var res = stats.resources || {}
		var currentState = stats.current_state || 'unknown'

		var stateColor = GRAY
		if (currentState === 'running') stateColor = GREEN
		else if (currentState === 'starting' || currentState === 'stopping') stateColor = AMBER
		else if (currentState === 'offline') stateColor = RED

		// Navigation Tabs Header (Modern Discord Capsule Pill Bar)
		function renderTabs() {
			var tabs = [
				{ id: 'status', label: 'Overview', icon: '📊' },
				{ id: 'players', label: 'Players', icon: '👥' },
				{ id: 'console', label: 'Console', icon: '💻' },
				{ id: 'files', label: 'Files', icon: '📁' },
				{ id: 'settings', label: 'Settings', icon: '⚙️' }
			]
			return h(
				RN.View,
				{ style: { marginBottom: 12, paddingTop: 4 } },
				h(
					RN.ScrollView,
					{
						horizontal: true,
						showsHorizontalScrollIndicator: false,
						contentContainerStyle: { paddingHorizontal: 14, alignItems: 'center' }
					},
					tabs.map(function (tab, idx) {
						var isActive = activeTab === tab.id
						return h(
							RN.TouchableOpacity,
							{
								key: tab.id,
								onPress: function () {
									setActiveTab(tab.id)
									if (tab.id === 'files' && !state.files.length) {
										fetchFiles(currentServerId, '/')
									}
									if (tab.id === 'console' && !state.logs) {
										fetchLogs(currentServerId)
									}
									if (tab.id === 'players') {
										setSelectedPlayer(null)
										fetchPlayers(currentServerId)
									}
								},
								style: {
									flexDirection: 'row',
									alignItems: 'center',
									justifyContent: 'center',
									height: 34,
									paddingHorizontal: 12,
									borderRadius: 17,
									backgroundColor: isActive ? BLURPLE : BG_RAISED,
									borderWidth: 1,
									borderColor: isActive ? 'transparent' : BORDER_SUBTLE,
									marginRight: idx < tabs.length - 1 ? 8 : 0
								}
							},
							T({ variant: 'text-xs/bold', style: { marginRight: 6, includeFontPadding: false, textAlignVertical: 'center' } }, tab.icon),
							T({ variant: 'text-sm/bold', style: { color: isActive ? '#ffffff' : TEXT_MUTED, includeFontPadding: false, textAlignVertical: 'center' } }, tab.label)
						)
					})
				)
			)
		}

		// TAB 1: OVERVIEW & SERVER STATUS
		function renderStatusTab() {
			var cpuNum = res.cpu_absolute != null ? res.cpu_absolute : 0
			var cpuPercentStr = cpuNum.toFixed(1) + '%'
			var memStr = formatBytes(res.memory_bytes)
			var memMaxMB = selectedServer.limits && selectedServer.limits.memory ? Number(selectedServer.limits.memory) : 0
			var memLimitStr = memMaxMB ? memMaxMB + ' MB' : 'Unlimited'
			var memPercent = memMaxMB ? Math.min(100, Math.round(((Number(res.memory_bytes) || 0) / (memMaxMB * 1024 * 1024)) * 100)) : 0

			var diskStr = formatBytes(res.disk_bytes)
			var diskMaxMB = selectedServer.limits && selectedServer.limits.disk ? Number(selectedServer.limits.disk) : 0
			var diskLimitStr = diskMaxMB ? diskMaxMB + ' MB' : 'Unlimited'
			var diskPercent = diskMaxMB ? Math.min(100, Math.round(((Number(res.disk_bytes) || 0) / (diskMaxMB * 1024 * 1024)) * 100)) : 0

			var details = state.serverDetails[currentServerId] || {}
			var hostPort = details.host ? details.host + ':' + (details.port || 25297) : (selectedServer.node ? selectedServer.node : '')

			var serverAssetId = valenced.assets.getAssetIdByName('ServerIcon') || valenced.assets.getAssetIdByName('GameControllerIcon')
			var faviconUri = state.serverFavicon

			var iconElem = faviconUri
				? h(RN.Image, { source: { uri: faviconUri }, style: { width: 48, height: 48, borderRadius: 12, marginRight: 12 } })
				: h(
					RN.View,
					{ style: { width: 48, height: 48, borderRadius: 12, backgroundColor: BLURPLE, justifyContent: 'center', alignItems: 'center', marginRight: 12 } },
					serverAssetId
						? h(RN.Image, { source: serverAssetId, style: { width: 26, height: 26, tintColor: '#ffffff' } })
						: T({ variant: 'heading-lg/bold', style: { color: '#ffffff' } }, '🎮')
				)

			return h(
				RN.View,
				{ style: { paddingHorizontal: 14 } },
				// Hero Server Profile Card
				h(
					Card,
					null,
					h(
						RN.View,
						{ style: { flexDirection: 'row', alignItems: 'center' } },
						iconElem,
						h(
							RN.View,
							{ style: { flex: 1, marginRight: 8 } },
							h(
								RN.View,
								{ style: { flexDirection: 'row', alignItems: 'center' } },
								T({ variant: 'heading-md/bold', style: { color: TEXT_NORMAL, marginRight: 6 } }, serverDisplayName),
								h(
									RN.TouchableOpacity,
									{
										onPress: function () {
											newNameInputRef.current = serverDisplayName
											setIsEditingName(!isEditingName)
										},
										style: { padding: 4 }
									},
									T({ variant: 'text-xs/bold', style: { color: BLURPLE } }, '✏️')
								)
							),
							serverDisplayName !== selectedServer.name
								? T({ variant: 'text-xs/medium', style: { color: TEXT_MUTED } }, 'Panel: ' + selectedServer.name)
								: null,
							T({ variant: 'text-xs/medium', style: { color: TEXT_MUTED } }, 'ID: ' + selectedServer.id + (selectedServer.node ? ' • ' + selectedServer.node : ''))
						),
						h(StatusPill, { text: currentState, color: stateColor })
					),
					// Address Pill
					hostPort ? h(
						RN.TouchableOpacity,
						{
							onPress: function () { copyText(hostPort, 'Server address') },
							style: {
								flexDirection: 'row',
								alignItems: 'center',
								backgroundColor: BG_BASE,
								height: 32,
								paddingHorizontal: 10,
								borderRadius: 8,
								marginTop: 10
							}
						},
						T({ variant: 'text-xs/semibold', style: { color: TEXT_MUTED, flex: 1 } }, 'Address: ' + hostPort),
						T({ variant: 'text-xs/bold', style: { color: BLURPLE } }, '⧉ Copy')
					) : null,
					// Inline Rename Card
					isEditingName ? h(
						RN.View,
						{ style: { marginTop: 10, padding: 10, backgroundColor: BG_RAISED, borderRadius: 10 } },
						T({ variant: 'text-xs/semibold', style: { color: TEXT_MUTED, marginBottom: 6 } }, 'Rename Server (Local inside plugin):'),
						h(
							RN.View,
							{ style: { flexDirection: 'row', alignItems: 'center' } },
							h(
								RN.View,
								{ style: { flex: 1, marginRight: 6 } },
								h(D.TextInput, {
									defaultValue: serverDisplayName,
									placeholder: selectedServer.name,
									onChange: function (v) { newNameInputRef.current = v }
								})
							),
							h(
								RN.TouchableOpacity,
								{
									onPress: function () {
										setServerAlias(currentServerId, newNameInputRef.current)
										setIsEditingName(false)
									},
									style: { backgroundColor: GREEN, height: 36, paddingHorizontal: 12, borderRadius: 8, alignItems: 'center', justifyContent: 'center', marginRight: 4 }
								},
								T({ variant: 'text-xs/bold', style: { color: '#ffffff' } }, 'Save')
							),
							serverDisplayName !== selectedServer.name ? h(
								RN.TouchableOpacity,
								{
									onPress: function () {
										setServerAlias(currentServerId, '')
										setIsEditingName(false)
									},
									style: { backgroundColor: BG_HOVER, height: 36, paddingHorizontal: 10, borderRadius: 8, alignItems: 'center', justifyContent: 'center' }
								},
								T({ variant: 'text-xs/medium', style: { color: TEXT_NORMAL } }, 'Reset')
							) : null
						)
					) : null
				),
				// Modern Resource Widgets
				h(
					RN.View,
					{ style: { flexDirection: 'row', marginBottom: 10 } },
					h(StatWidget, { style: { marginRight: 8 }, label: 'CPU LOAD', value: cpuPercentStr, percent: Math.min(100, Math.round(cpuNum)), color: cpuNum > 80 ? RED : cpuNum > 50 ? AMBER : GREEN }),
					h(StatWidget, { style: { marginRight: 8 }, label: 'MEMORY (RAM)', value: memStr, percent: memPercent, sub: memLimitStr, color: memPercent > 85 ? RED : memPercent > 65 ? AMBER : GREEN }),
					h(StatWidget, { label: 'STORAGE (DISK)', value: diskStr, percent: diskPercent, sub: diskLimitStr, color: diskPercent > 90 ? RED : GREEN })
				),
				// Power Actions Card
				h(
					Card,
					null,
					T({ variant: 'eyebrow', style: { color: TEXT_MUTED, marginBottom: 10 } }, 'POWER CONTROLS'),
					h(
						RN.View,
						{ style: { flexDirection: 'row' } },
						h(
							RN.TouchableOpacity,
							{
								onPress: function () { sendPower(currentServerId, 'start') },
								style: { flex: 1, height: 40, backgroundColor: GREEN, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginRight: 6 }
							},
							T({ variant: 'text-sm/bold', style: { color: '#ffffff' } }, '▶ Start')
						),
						h(
							RN.TouchableOpacity,
							{
								onPress: function () { sendPower(currentServerId, 'restart') },
								style: { flex: 1, height: 40, backgroundColor: AMBER, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginRight: 6 }
							},
							T({ variant: 'text-sm/bold', style: { color: '#111214' } }, '⟳ Restart')
						),
						h(
							RN.TouchableOpacity,
							{
								onPress: function () { sendPower(currentServerId, 'stop') },
								style: { flex: 1, height: 40, backgroundColor: RED, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginRight: 6 }
							},
							T({ variant: 'text-sm/bold', style: { color: '#ffffff' } }, '■ Stop')
						),
						h(
							RN.TouchableOpacity,
							{
								onPress: function () { sendPower(currentServerId, 'kill') },
								style: { flex: 1, height: 40, backgroundColor: CRIMSON, borderRadius: 10, alignItems: 'center', justifyContent: 'center' }
							},
							T({ variant: 'text-sm/bold', style: { color: '#ffffff' } }, '⚡ Kill')
						)
					)
				),
				// Uptime & Refresh Bar
				h(
					RN.View,
					{
						style: {
							flexDirection: 'row',
							justifyContent: 'space-between',
							alignItems: 'center',
							backgroundColor: BG_SURFACE,
							borderRadius: 12,
							paddingHorizontal: 12,
							paddingVertical: 10,
							borderWidth: 1,
							borderColor: BORDER_SUBTLE,
							marginBottom: 10
						}
					},
					T({ variant: 'text-xs/medium', style: { color: TEXT_MUTED } }, '⏱️ Uptime: ' + formatUptime(res.uptime)),
					h(
						RN.TouchableOpacity,
						{
							onPress: function () { fetchResources(currentServerId) },
							style: {
								backgroundColor: BG_RAISED,
								paddingHorizontal: 12,
								height: 28,
								borderRadius: 8,
								alignItems: 'center',
								justifyContent: 'center',
								borderWidth: 1,
								borderColor: BORDER_SUBTLE
							}
						},
						T({ variant: 'text-xs/bold', style: { color: BLURPLE } }, state.loadingStats ? 'Refreshing…' : '⟳ Refresh Metrics')
					)
				)
			)
		}

		// TAB 2 SUBVIEW: PLAYER ACTIONS (Rendered right inside the full-height sheet body)
		function renderPlayerDetailView(p, goBack) {
			var pName = p.name || 'Player'
			var pLower = pName.toLowerCase()
			var isOp = state.opsList.indexOf(pLower) !== -1
			var isWl = state.whitelist.indexOf(pLower) !== -1
			var headUrl = 'https://mc-heads.net/avatar/' + encodeURIComponent(pName) + '/54'

			function runCmd(cmd, label) {
				sendCommand(currentServerId, cmd)
				toast(label + ' for ' + pName)
				goBack()
				setTimeout(function () { fetchPlayers(currentServerId) }, 1500)
			}

			return h(
				RN.View,
				{ style: { paddingHorizontal: 14 } },
				// Back Button
				h(
					RN.TouchableOpacity,
					{
						onPress: goBack,
						style: { flexDirection: 'row', alignItems: 'center', marginBottom: 12, paddingVertical: 4 }
					},
					T({ variant: 'text-sm/bold', style: { color: BLURPLE } }, '‹ Back to All Players')
				),
				// Player Hero Profile Card
				h(
					Card,
					null,
					h(
						RN.View,
						{ style: { flexDirection: 'row', alignItems: 'center' } },
						h(RN.Image, { source: { uri: headUrl }, style: { width: 50, height: 50, borderRadius: 12, marginRight: 12 } }),
						h(
							RN.View,
							{ style: { flex: 1 } },
							T({ variant: 'heading-md/bold', style: { color: TEXT_NORMAL } }, pName),
							h(
								RN.View,
								{ style: { flexDirection: 'row', alignItems: 'center', marginTop: 4 } },
								isOp ? h(
									RN.View,
									{ style: { backgroundColor: tint(AMBER, 0.2), height: 22, paddingHorizontal: 8, borderRadius: 11, alignItems: 'center', justifyContent: 'center', marginRight: 6 } },
									T({ variant: 'text-xs/bold', style: { color: AMBER } }, '👑 OPERATOR')
								) : null,
								isWl ? h(
									RN.View,
									{ style: { backgroundColor: tint(GREEN, 0.2), height: 22, paddingHorizontal: 8, borderRadius: 11, alignItems: 'center', justifyContent: 'center', marginRight: 6 } },
									T({ variant: 'text-xs/bold', style: { color: GREEN } }, '✅ WHITELISTED')
								) : null,
								!isOp && !isWl ? T({ variant: 'text-xs/medium', style: { color: TEXT_MUTED } }, 'Regular Player') : null
							),
							p.uuid ? h(
								RN.TouchableOpacity,
								{ onPress: function () { copyText(p.uuid, 'Player UUID') }, style: { marginTop: 4 } },
								T({ variant: 'text-xs/medium', style: { color: TEXT_MUTED } }, 'UUID: ' + p.uuid.slice(0, 18) + '... ⧉')
							) : null
						)
					)
				),
				// 1. Operator Controls
				T({ variant: 'eyebrow', style: { color: TEXT_MUTED, marginBottom: 8 } }, 'OPERATOR PRIVILEGES'),
				!isOp ? h(
					RN.TouchableOpacity,
					{
						onPress: function () { runCmd('op ' + pName, 'Granted OP') },
						style: { backgroundColor: GREEN, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginBottom: 12 }
					},
					T({ variant: 'text-sm/bold', style: { color: '#ffffff' } }, '👑 Make Operator (/op ' + pName + ')')
				) : h(
					RN.TouchableOpacity,
					{
						onPress: function () { runCmd('deop ' + pName, 'Removed OP') },
						style: { backgroundColor: RED, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginBottom: 12 }
					},
					T({ variant: 'text-sm/bold', style: { color: '#ffffff' } }, '🛑 Remove Operator (/deop ' + pName + ')')
				),
				// 2. Whitelist Controls
				T({ variant: 'eyebrow', style: { color: TEXT_MUTED, marginBottom: 8 } }, 'WHITELIST MANAGEMENT'),
				!isWl ? h(
					RN.TouchableOpacity,
					{
						onPress: function () { runCmd('whitelist add ' + pName, 'Whitelisted') },
						style: { backgroundColor: BLURPLE, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginBottom: 12 }
					},
					T({ variant: 'text-sm/bold', style: { color: '#ffffff' } }, '✅ Add to Whitelist (/whitelist add)')
				) : h(
					RN.TouchableOpacity,
					{
						onPress: function () { runCmd('whitelist remove ' + pName, 'Removed from whitelist') },
						style: { backgroundColor: AMBER, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginBottom: 12 }
					},
					T({ variant: 'text-sm/bold', style: { color: '#111214' } }, '❌ Remove from Whitelist (/whitelist remove)')
				),
				// 3. Moderation Controls
				T({ variant: 'eyebrow', style: { color: TEXT_MUTED, marginBottom: 8 } }, 'MODERATION ACTIONS'),
				h(
					RN.View,
					{ style: { flexDirection: 'row', marginBottom: 12 } },
					h(
						RN.TouchableOpacity,
						{
							onPress: function () { runCmd('kick ' + pName, 'Kicked') },
							style: { flex: 1, height: 38, backgroundColor: RED, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginRight: 6 }
						},
						T({ variant: 'text-sm/bold', style: { color: '#ffffff' } }, '👢 Kick')
					),
					h(
						RN.TouchableOpacity,
						{
							onPress: function () { runCmd('ban ' + pName, 'Banned') },
							style: { flex: 1, height: 38, backgroundColor: CRIMSON, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginRight: 6 }
						},
						T({ variant: 'text-sm/bold', style: { color: '#ffffff' } }, '🔨 Ban')
					),
					h(
						RN.TouchableOpacity,
						{
							onPress: function () { runCmd('pardon ' + pName, 'Unbanned') },
							style: { flex: 1, height: 38, backgroundColor: BG_RAISED, borderRadius: 10, alignItems: 'center', justifyContent: 'center' }
						},
						T({ variant: 'text-sm/bold', style: { color: TEXT_NORMAL } }, '🔓 Unban')
					)
				),
				// 4. In-Game Interactions
				T({ variant: 'eyebrow', style: { color: TEXT_MUTED, marginBottom: 8 } }, 'IN-GAME INTERACTIONS'),
				h(
					RN.View,
					{ style: { flexDirection: 'row', marginBottom: 16 } },
					h(
						RN.TouchableOpacity,
						{
							onPress: function () { runCmd('tp ' + pName + ' 0 80 0', 'Teleported') },
							style: { flex: 1, height: 36, backgroundColor: BG_RAISED, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginRight: 6 }
						},
						T({ variant: 'text-xs/bold', style: { color: TEXT_NORMAL } }, '📍 Spawn TP')
					),
					h(
						RN.TouchableOpacity,
						{
							onPress: function () { runCmd('gamemode survival ' + pName, 'Gamemode Survival') },
							style: { flex: 1, height: 36, backgroundColor: BG_RAISED, borderRadius: 10, alignItems: 'center', justifyContent: 'center', marginRight: 6 }
						},
						T({ variant: 'text-xs/bold', style: { color: TEXT_NORMAL } }, '🎮 Survival')
					),
					h(
						RN.TouchableOpacity,
						{
							onPress: function () { runCmd('gamemode creative ' + pName, 'Gamemode Creative') },
							style: { flex: 1, height: 36, backgroundColor: BG_RAISED, borderRadius: 10, alignItems: 'center', justifyContent: 'center' }
						},
						T({ variant: 'text-xs/bold', style: { color: TEXT_NORMAL } }, '✨ Creative')
					)
				)
			)
		}

		// TAB 2: PLAYERS TAB (Clean Player Entries + ⚙️ Gear Action Sheets)
		function renderPlayersTab() {
			if (selectedPlayer) {
				return renderPlayerDetailView(selectedPlayer, function () { setSelectedPlayer(null) })
			}

			var details = state.serverDetails[currentServerId] || {}
			var address = (details.host || 'in-mum01.altare.global') + ':' + (details.port || 25297)

			return h(
				RN.View,
				{ style: { paddingHorizontal: 14 } },
				// Header Card
				h(
					Card,
					null,
					h(
						RN.View,
						{ style: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' } },
						h(
							RN.View,
							null,
							T({ variant: 'eyebrow', style: { color: TEXT_MUTED } }, 'MINECRAFT PLAYERS'),
							T({ variant: 'heading-md/bold', style: { color: TEXT_NORMAL, marginTop: 2 } }, currentState === 'running' ? state.onlinePlayerCount + ' / ' + state.maxPlayerCount + ' Online' : 'Server is ' + currentState.toUpperCase()),
							state.statusProvider && state.statusProvider !== 'none'
								? T({ variant: 'text-xs/medium', style: { color: TEXT_MUTED, marginTop: 2 } }, 'Via ' + state.statusProvider + ' (External Ping)')
								: null
						),
						h(
							RN.TouchableOpacity,
							{
								onPress: function () { fetchPlayers(currentServerId) },
								style: { backgroundColor: BG_RAISED, height: 30, paddingHorizontal: 12, borderRadius: 8, alignItems: 'center', justifyContent: 'center' }
							},
							T({ variant: 'text-xs/bold', style: { color: BLURPLE } }, state.loadingPlayers ? 'Checking…' : '⟳ Refresh')
						)
					),
					h(
						RN.TouchableOpacity,
						{
							onPress: function () { copyText(address, 'Server address') },
							style: {
								flexDirection: 'row',
								alignItems: 'center',
								backgroundColor: BG_BASE,
								height: 32,
								paddingHorizontal: 10,
								borderRadius: 8,
								marginTop: 10
							}
						},
						T({ variant: 'text-xs/semibold', style: { color: TEXT_MUTED, flex: 1 } }, 'Address: ' + address),
						T({ variant: 'text-xs/bold', style: { color: BLURPLE } }, '⧉ Copy')
					)
				),
				// Online Players Section
				T({ variant: 'eyebrow', style: { color: TEXT_MUTED, marginTop: 4, marginBottom: 8 } }, 'CURRENTLY ONLINE PLAYERS'),
				state.onlinePlayers.length === 0 ? h(
					Card,
					{ style: { alignItems: 'center', paddingVertical: 20 } },
					T({ variant: 'text-sm/medium', style: { color: TEXT_MUTED } }, currentState === 'running' ? 'No players are currently online' : 'Server is offline')
				) : h(
					RN.View,
					{ style: { marginBottom: 10 } },
					state.onlinePlayers.map(function (p) {
						var pName = p.name || 'Player'
						var pLower = pName.toLowerCase()
						var isOp = state.opsList.indexOf(pLower) !== -1
						var isWl = state.whitelist.indexOf(pLower) !== -1
						var headUrl = 'https://mc-heads.net/avatar/' + encodeURIComponent(pName) + '/40'
						return h(
							RN.View,
							{
								key: pName,
								style: {
									flexDirection: 'row',
									alignItems: 'center',
									backgroundColor: BG_SURFACE,
									borderRadius: 12,
									paddingHorizontal: 12,
									paddingVertical: 10,
									marginBottom: 8,
									borderWidth: 1,
									borderColor: BORDER_SUBTLE
								}
							},
							h(RN.Image, { source: { uri: headUrl }, style: { width: 38, height: 38, borderRadius: 8, marginRight: 10 } }),
							h(
								RN.View,
								{ style: { flex: 1 } },
								T({ variant: 'heading-sm/bold', style: { color: TEXT_NORMAL } }, pName),
								h(
									RN.View,
									{ style: { flexDirection: 'row', alignItems: 'center', marginTop: 2 } },
									isOp ? h(
										RN.View,
										{ style: { backgroundColor: tint(AMBER, 0.2), paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, marginRight: 4 } },
										T({ variant: 'text-xs/bold', style: { color: AMBER } }, '👑 OP')
									) : null,
									isWl ? h(
										RN.View,
										{ style: { backgroundColor: tint(GREEN, 0.2), paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, marginRight: 4 } },
										T({ variant: 'text-xs/bold', style: { color: GREEN } }, '✓ Whitelist')
									) : null,
									!isOp && !isWl ? T({ variant: 'text-xs/medium', style: { color: GREEN } }, '● Online') : null
								)
							),
							h(
								RN.TouchableOpacity,
								{
									onPress: function () {
										setSelectedPlayer({ name: pName, uuid: p.uuid, isOp: isOp, isWhitelisted: isWl })
									},
									style: { backgroundColor: BG_RAISED, width: 34, height: 34, borderRadius: 8, alignItems: 'center', justifyContent: 'center' }
								},
								T({ variant: 'text-sm/bold', style: { color: TEXT_MUTED } }, '⚙️')
							)
						)
					})
				),
				// Registered Server Players (usercache.json)
				T({ variant: 'eyebrow', style: { color: TEXT_MUTED, marginTop: 6, marginBottom: 8 } }, 'REGISTERED PLAYERS (' + state.knownPlayers.length + ')'),
				state.knownPlayers.length === 0 ? h(
					Card,
					{ style: { alignItems: 'center', paddingVertical: 20 } },
					T({ variant: 'text-sm/medium', style: { color: TEXT_MUTED } }, 'No player history cached yet in usercache.json')
				) : h(
					RN.View,
					null,
					state.knownPlayers.map(function (kp) {
						var kpName = kp.name || 'Player'
						var kpLower = kpName.toLowerCase()
						var isOp = state.opsList.indexOf(kpLower) !== -1
						var isWl = state.whitelist.indexOf(kpLower) !== -1
						var headUrl = 'https://mc-heads.net/avatar/' + encodeURIComponent(kpName) + '/40'
						return h(
							RN.View,
							{
								key: kpName + '_' + kp.uuid,
								style: {
									flexDirection: 'row',
									alignItems: 'center',
									backgroundColor: BG_SURFACE,
									borderRadius: 12,
									paddingHorizontal: 12,
									paddingVertical: 10,
									marginBottom: 8,
									borderWidth: 1,
									borderColor: BORDER_SUBTLE
								}
							},
							h(RN.Image, { source: { uri: headUrl }, style: { width: 38, height: 38, borderRadius: 8, marginRight: 10 } }),
							h(
								RN.View,
								{ style: { flex: 1 } },
								T({ variant: 'heading-sm/bold', style: { color: TEXT_NORMAL } }, kpName),
								h(
									RN.View,
									{ style: { flexDirection: 'row', alignItems: 'center', marginTop: 2 } },
									isOp ? h(
										RN.View,
										{ style: { backgroundColor: tint(AMBER, 0.2), paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, marginRight: 4 } },
										T({ variant: 'text-xs/bold', style: { color: AMBER } }, '👑 OP')
									) : null,
									isWl ? h(
										RN.View,
										{ style: { backgroundColor: tint(GREEN, 0.2), paddingHorizontal: 6, paddingVertical: 2, borderRadius: 6, marginRight: 4 } },
										T({ variant: 'text-xs/bold', style: { color: GREEN } }, '✓ Whitelist')
									) : null,
									!isOp && !isWl ? T({ variant: 'text-xs/medium', style: { color: TEXT_MUTED } }, 'Registered User') : null
								)
							),
							h(
								RN.TouchableOpacity,
								{
									onPress: function () {
										setSelectedPlayer({ name: kpName, uuid: kp.uuid, isOp: isOp, isWhitelisted: isWl })
									},
									style: { backgroundColor: BG_RAISED, width: 34, height: 34, borderRadius: 8, alignItems: 'center', justifyContent: 'center' }
								},
								T({ variant: 'text-sm/bold', style: { color: TEXT_MUTED } }, '⚙️')
							)
						)
					})
				)
			)
		}

		// TAB 3: CONSOLE & COMMANDS (Modern IDE-Style Terminal)
		function renderConsoleTab() {
			var presets = ['/list', '/tps', '/whitelist list', '/say Hello!', '/save-all', '/weather clear', '/time set day']

			var displayText = state.logs || 'No logs fetched yet. Tap Refresh Logs above.'
			if (state.logLines && state.logLines.length > 0) {
				var displaySlice = state.logLines.slice(-60)
				if (logOrder === 'top') {
					displayText = displaySlice.slice().reverse().join('\n')
				} else {
					displayText = displaySlice.join('\n')
				}
			}

			var logHeight = Math.max(200, sheetMinHeight - 195)

			return h(
				RN.View,
				{ style: { flex: 1, paddingHorizontal: 14, paddingBottom: 16 } },
				// Command Input Bar
				h(
					RN.View,
					{
						style: {
							flexDirection: 'row',
							alignItems: 'center',
							marginBottom: 10
						}
					},
					h(
						RN.View,
						{ style: { flex: 1, marginRight: 8 } },
						h(D.TextInput, {
							placeholder: 'Console command (e.g. /say Hello)...',
							value: commandText,
							onChange: function (val) { setCommandText(val) }
						})
					),
					h(
						RN.TouchableOpacity,
						{
							onPress: function () {
								if (commandText) {
									sendCommand(currentServerId, commandText)
									setCommandText('')
								}
							},
							style: { backgroundColor: BLURPLE, paddingHorizontal: 16, height: 40, borderRadius: 10, alignItems: 'center', justifyContent: 'center' }
						},
						T({ variant: 'text-sm/bold', style: { color: '#ffffff' } }, 'Send')
					)
				),
				// Modern Sleek Pill Bar
				h(
					RN.View,
					{ style: { marginBottom: 10 } },
					h(
						RN.ScrollView,
						{
							horizontal: true,
							showsHorizontalScrollIndicator: false,
							contentContainerStyle: { alignItems: 'center' }
						},
						presets.map(function (p) {
							return h(
								RN.TouchableOpacity,
								{
									key: p,
									onPress: function () { setCommandText(p) },
									style: {
										flexDirection: 'row',
										alignItems: 'center',
										justifyContent: 'center',
										height: 28,
										paddingHorizontal: 10,
										borderRadius: 14,
										backgroundColor: BG_RAISED,
										borderWidth: 1,
										borderColor: BORDER_SUBTLE,
										marginRight: 6
									}
								},
								T({
									variant: 'text-xs/medium',
									style: {
										color: TEXT_NORMAL,
										includeFontPadding: false,
										textAlignVertical: 'center',
										fontSize: 12,
										lineHeight: 14
									}
								}, p)
							)
						})
					)
				),
				// Terminal Header Controls Bar
				h(
					RN.View,
					{
						style: {
							flexDirection: 'row',
							justifyContent: 'space-between',
							alignItems: 'center',
							backgroundColor: '#0c0d0e',
							borderTopLeftRadius: 12,
							borderTopRightRadius: 12,
							height: 36,
							paddingHorizontal: 12,
							borderWidth: 1,
							borderBottomWidth: 0,
							borderColor: BORDER_SUBTLE
						}
					},
					// Colored Terminal Dots
					h(
						RN.View,
						{ style: { flexDirection: 'row', alignItems: 'center' } },
						h(RN.View, { style: { width: 8, height: 8, borderRadius: 4, backgroundColor: RED, marginRight: 5 } }),
						h(RN.View, { style: { width: 8, height: 8, borderRadius: 4, backgroundColor: AMBER, marginRight: 5 } }),
						h(RN.View, { style: { width: 8, height: 8, borderRadius: 4, backgroundColor: GREEN, marginRight: 8 } }),
						T({ variant: 'text-xs/bold', style: { color: TEXT_MUTED } }, 'latest.log')
					),
					h(
						RN.View,
						{ style: { flexDirection: 'row', alignItems: 'center' } },
						h(
							RN.TouchableOpacity,
							{
								onPress: function () {
									setLogOrder(logOrder === 'bottom' ? 'top' : 'bottom')
								},
								style: { backgroundColor: BG_RAISED, paddingHorizontal: 8, height: 26, borderRadius: 6, alignItems: 'center', justifyContent: 'center', marginRight: 6 }
							},
							T({ variant: 'text-xs/bold', style: { color: TEXT_NORMAL } }, logOrder === 'bottom' ? '⇅ Newest Top' : '⇅ Chronological')
						),
						logOrder === 'bottom' ? h(
							RN.TouchableOpacity,
							{
								onPress: function () {
									if (logScrollRef.current && typeof logScrollRef.current.scrollToEnd === 'function') {
										logScrollRef.current.scrollToEnd({ animated: true })
									}
								},
								style: { backgroundColor: BG_RAISED, paddingHorizontal: 8, height: 26, borderRadius: 6, alignItems: 'center', justifyContent: 'center', marginRight: 6 }
							},
							T({ variant: 'text-xs/bold', style: { color: TEXT_NORMAL } }, '↓ End')
						) : null,
						h(
							RN.TouchableOpacity,
							{
								onPress: function () { fetchLogs(currentServerId) },
								style: { backgroundColor: BG_RAISED, paddingHorizontal: 8, height: 26, borderRadius: 6, alignItems: 'center', justifyContent: 'center' }
							},
							T({ variant: 'text-xs/bold', style: { color: BLURPLE } }, state.loadingLogs ? '...' : '⟳ Refresh')
						)
					)
				),
				// Terminal Output Screen
				scrollView(
					RN,
					{
						ref: logScrollRef,
						style: {
							height: logHeight,
							backgroundColor: '#090a0b',
							borderBottomLeftRadius: 12,
							borderBottomRightRadius: 12,
							borderWidth: 1,
							borderTopWidth: 0,
							borderColor: BORDER_SUBTLE
						},
						contentContainerStyle: {
							padding: 10,
							paddingBottom: 20,
							flexGrow: 1
						},
						keyboardShouldPersistTaps: 'handled',
						nestedScrollEnabled: true,
						showsVerticalScrollIndicator: true
					},
					T({ variant: 'code', style: { color: '#dbdee1', fontSize: 11, fontFamily: 'monospace', lineHeight: 16 } }, displayText)
				)
			)
		}

		// TAB 4: FILE EXPLORER
		function renderFilesTab() {
			return h(
				RN.View,
				{ style: { paddingHorizontal: 14 } },
				// Breadcrumb Navigation Card
				h(
					Card,
					{ style: { paddingVertical: 10, paddingHorizontal: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } },
					T({ variant: 'text-sm/bold', style: { color: TEXT_NORMAL } }, '📁 ' + state.currentDir),
					state.currentDir !== '/' ? h(
						RN.TouchableOpacity,
						{
							onPress: function () {
								var parts = state.currentDir.replace(/\/+$/, '').split('/')
								parts.pop()
								var parentDir = parts.join('/') || '/'
								fetchFiles(currentServerId, parentDir)
							},
							style: { backgroundColor: BG_RAISED, height: 28, paddingHorizontal: 10, borderRadius: 6, alignItems: 'center', justifyContent: 'center' }
						},
						T({ variant: 'text-xs/bold', style: { color: BLURPLE } }, '↑ Parent Folder')
					) : null
				),
				// File list
				state.loadingFiles ? h(
					Card,
					{ style: { alignItems: 'center', paddingVertical: 30 } },
					T({ variant: 'text-sm/medium', style: { color: TEXT_MUTED } }, 'Loading directory contents…')
				) : state.files.length === 0 ? h(
					Card,
					{ style: { alignItems: 'center', paddingVertical: 30 } },
					T({ variant: 'text-sm/medium', style: { color: TEXT_MUTED } }, 'No files or folders in this directory')
				) : h(
					RN.View,
					null,
					state.files.map(function (f) {
						var isDir = !f.is_file
						var fullPath = (state.currentDir === '/' ? '/' : state.currentDir + '/') + f.name
						var iconEmoji = isDir ? '📁' : f.name.endsWith('.log') || f.name.endsWith('.txt') ? '📄' : f.name.endsWith('.json') || f.name.endsWith('.properties') || f.name.endsWith('.yml') ? '⚙️' : '📦'
						return h(
							RN.TouchableOpacity,
							{
								key: f.name,
								onPress: function () {
									if (isDir) {
										fetchFiles(currentServerId, fullPath)
									} else {
										toast('Loading file: ' + f.name + '...')
										readFile(currentServerId, fullPath).then(function (content) {
											openFileViewer(f.name, fullPath, typeof content === 'string' ? content : JSON.stringify(content, null, 2))
										}).catch(function (err) {
											toast('Read error: ' + errorText(err))
										})
									}
								},
								style: {
									flexDirection: 'row',
									alignItems: 'center',
									backgroundColor: BG_SURFACE,
									borderRadius: 12,
									paddingHorizontal: 12,
									paddingVertical: 10,
									marginBottom: 8,
									borderWidth: 1,
									borderColor: BORDER_SUBTLE
								}
							},
							T({ variant: 'heading-md/bold', style: { marginRight: 10, fontSize: 18 } }, iconEmoji),
							h(
								RN.View,
								{ style: { flex: 1 } },
								T({ variant: 'text-sm/bold', style: { color: TEXT_NORMAL } }, f.name),
								T({ variant: 'text-xs/medium', style: { color: TEXT_MUTED, marginTop: 2 } }, isDir ? 'Directory' : formatBytes(f.size))
							),
							T({ variant: 'text-sm/bold', style: { color: TEXT_MUTED } }, '›')
						)
					})
				)
			)
		}

		// TAB 5: SETTINGS & CONFIG
		var urlInputRef = React.useRef(getPanelUrl())
		var keyInputRef = React.useRef(getApiKey())
		var aliasInputRef = React.useRef(serverDisplayName)
		function renderSettingsTab() {
			return h(
				RN.View,
				{ style: { paddingHorizontal: 14 } },
				// Custom Server Nickname Card
				h(
					Card,
					null,
					T({ variant: 'eyebrow', style: { color: TEXT_MUTED, marginBottom: 4 } }, 'SERVER DISPLAY NICKNAME'),
					T({ variant: 'text-xs/medium', style: { color: TEXT_MUTED, marginBottom: 8 } }, 'Set a custom nickname inside the plugin only:'),
					h(
						RN.View,
						{ style: { backgroundColor: BG_BASE, borderRadius: 10, height: 42, paddingHorizontal: 10, borderWidth: 1, borderColor: BORDER_SUBTLE, marginBottom: 10, justifyContent: 'center' } },
						h(D.TextInput, {
							defaultValue: serverDisplayName,
							placeholder: selectedServer.name,
							onChange: function (val) { aliasInputRef.current = val }
						})
					),
					h(
						RN.View,
						{ style: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center' } },
						serverDisplayName !== selectedServer.name ? h(
							RN.TouchableOpacity,
							{
								onPress: function () { setServerAlias(currentServerId, '') },
								style: { backgroundColor: BG_RAISED, height: 34, paddingHorizontal: 14, borderRadius: 8, alignItems: 'center', justifyContent: 'center', marginRight: 8 }
							},
							T({ variant: 'text-xs/bold', style: { color: TEXT_MUTED } }, 'Reset')
						) : null,
						h(
							RN.TouchableOpacity,
							{
								onPress: function () { setServerAlias(currentServerId, aliasInputRef.current) },
								style: { backgroundColor: BLURPLE, height: 34, paddingHorizontal: 16, borderRadius: 8, alignItems: 'center', justifyContent: 'center' }
							},
							T({ variant: 'text-xs/bold', style: { color: '#ffffff' } }, 'Save Nickname')
						)
					)
				),
				// Pterodactyl Panel Connection Card
				h(
					Card,
					null,
					T({ variant: 'eyebrow', style: { color: TEXT_MUTED, marginBottom: 4 } }, 'PTERODACTYL CONNECTION'),
					T({ variant: 'text-xs/medium', style: { color: TEXT_MUTED, marginBottom: 6 } }, 'Panel Base URL:'),
					h(
						RN.View,
						{ style: { backgroundColor: BG_BASE, borderRadius: 10, height: 42, paddingHorizontal: 10, borderWidth: 1, borderColor: BORDER_SUBTLE, marginBottom: 10, justifyContent: 'center' } },
						h(D.TextInput, {
							defaultValue: getPanelUrl(),
							placeholder: 'https://panel.altare.global',
							onChange: function (val) { urlInputRef.current = val }
						})
					),
					T({ variant: 'text-xs/medium', style: { color: TEXT_MUTED, marginBottom: 6 } }, 'Client API Key (ptlc_...):'),
					h(
						RN.View,
						{ style: { backgroundColor: BG_BASE, borderRadius: 10, height: 42, paddingHorizontal: 10, borderWidth: 1, borderColor: BORDER_SUBTLE, marginBottom: 10, justifyContent: 'center' } },
						h(D.TextInput, {
							defaultValue: getApiKey(),
							placeholder: 'ptlc_...',
							secureTextEntry: true,
							onChange: function (val) { keyInputRef.current = val }
						})
					),
					h(
						RN.TouchableOpacity,
						{
							onPress: function () {
								saveSetting({
									panelUrl: urlInputRef.current,
									apiKey: keyInputRef.current
								})
								toast('Pterodactyl credentials saved!')
								fetchServers().catch(function () {})
							},
							style: { backgroundColor: BLURPLE, height: 38, borderRadius: 10, alignItems: 'center', justifyContent: 'center' }
						},
						T({ variant: 'text-sm/bold', style: { color: '#ffffff' } }, 'Save Connection')
					)
				),
				// Server Switcher Cards
				state.servers.length > 1 ? h(
					Card,
					null,
					T({ variant: 'eyebrow', style: { color: TEXT_MUTED, marginBottom: 8 } }, 'SWITCH ACTIVE SERVER'),
					state.servers.map(function (s) {
						var active = s.id === currentServerId
						var sDisp = getServerDisplayName(s)
						return h(
							RN.TouchableOpacity,
							{
								key: s.id,
								onPress: function () {
									state.selectedServerId = s.id
									saveSetting({ defaultServerId: s.id })
									changed()
									fetchResources(s.id)
									fetchServerDetails(s.id)
									toast('Selected: ' + sDisp)
								},
								style: {
									flexDirection: 'row',
									alignItems: 'center',
									backgroundColor: active ? tint(BLURPLE, 0.15) : BG_RAISED,
									borderRadius: 10,
									paddingHorizontal: 12,
									paddingVertical: 10,
									marginBottom: 8,
									borderWidth: 1,
									borderColor: active ? BLURPLE : BORDER_SUBTLE
								}
							},
							h(
								RN.View,
								{ style: { flex: 1 } },
								T({ variant: 'text-sm/bold', style: { color: active ? '#ffffff' : TEXT_NORMAL } }, sDisp),
								T({ variant: 'text-xs/medium', style: { color: TEXT_MUTED } }, 'ID: ' + s.id + (s.node ? ' • ' + s.node : ''))
							),
							active ? h(
								RN.View,
								{ style: { backgroundColor: BLURPLE, width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' } },
								T({ variant: 'text-xs/bold', style: { color: '#ffffff' } }, '✓')
							) : null
						)
					})
				) : null
			)
		}

		return h(
			D.ActionSheet,
			null,
			renderTabs(),
			activeTab === 'console'
				? h(RN.View, { style: { height: sheetMinHeight } }, renderConsoleTab())
				: scrollView(
					RN,
					{
						style: {
							minHeight: sheetMinHeight,
							maxHeight: sheetMaxHeight
						},
						contentContainerStyle: {
							paddingBottom: 32
						},
						keyboardShouldPersistTaps: 'handled',
						nestedScrollEnabled: true,
						showsVerticalScrollIndicator: true
					},
					activeTab === 'status' ? renderStatusTab() :
					activeTab === 'players' ? renderPlayersTab() :
					activeTab === 'files' ? renderFilesTab() :
					renderSettingsTab()
				)
		)
	}

	function openPanel() {
		try {
			valenced.discord.actions.ActionSheetActionCreators.openLazy(
				Promise.resolve({ default: function () { return h(Panel) } }),
				SHEET_KEY,
				{}
			)
		} catch (e) {
			toast('Could not open controller: ' + errorText(e))
		}
	}

	// ======================================================================================
	// Plus Action Menu Hook
	// ======================================================================================
	function decoratePlusItems(result, items) {
		for (var i = 0; i < items.length; i++) {
			if (items[i] && items[i].__pterodactyl) return result
		}
		var item = {
			key: 'asaprajx-pterodactyl-action',
			label: 'Pterodactyl Controller',
			subLabel: 'Manage game server & console',
			__pterodactyl: true,
			action: function () {
				try { valenced.discord.actions.ActionSheetActionCreators.hideAllActionSheets() } catch (e) {}
				setTimeout(openPanel, 200)
			}
		}
		;['action', 'onPress', 'onSelect', 'onClick', 'callback', 'handler'].forEach(function (n) {
			item[n] = item.action
		})
		var asset
		;['ServerIcon', 'GameControllerIcon', 'GlobeEarthIcon'].forEach(function (name) {
			if (asset === undefined) {
				var id = valenced.assets.getAssetIdByName(name)
				if (id != null) asset = id
			}
		})
		if (asset !== undefined) item.iconSource = asset

		return valenced.react.React.cloneElement(result, { items: items.concat([item]) })
	}

	function decoratePlusMenu(result) {
		try {
			var props = result && result.props
			if (props && Array.isArray(props.items) && props.items.length >= 2 && props.items.length <= 25) {
				return decoratePlusItems(result, props.items)
			}
			return result
		} catch (e) {
			return result
		}
	}

	function installPlusHook(cleanup) {
		var f = finders()
		var runtime = f.lookupModule(f.filters.withProps('jsx', 'jsxs'))[0] || valenced.react.ReactJSXRuntime
		;['jsx', 'jsxs'].forEach(function (name) {
			if (runtime && typeof runtime[name] === 'function') {
				cleanup(valenced.patcher.after(runtime, name, decoratePlusMenu))
			}
		})
	}

	// ======================================================================================
	// Settings Component (In Discord Plugin Settings)
	// ======================================================================================
	function SettingsComponent() {
		var D = Design()
		var urlInput = valenced.react.React.useRef(getPanelUrl())
		var keyInput = valenced.react.React.useRef(getApiKey())

		return h(
			D.TableRowGroup,
			{ title: 'Pterodactyl Configuration' },
			h(
				valenced.react.ReactNative.View,
				{ style: { padding: 12 } },
				T({ variant: 'text-xs/medium', style: { color: TEXT_MUTED, marginBottom: 4 } }, 'Panel Base URL (e.g. https://panel.example.com)'),
				h(D.TextInput, {
					defaultValue: getPanelUrl(),
					placeholder: 'https://panel.altare.global',
					onChange: function (v) { urlInput.current = v }
				})
			),
			h(
				valenced.react.ReactNative.View,
				{ style: { padding: 12 } },
				T({ variant: 'text-xs/medium', style: { color: TEXT_MUTED, marginBottom: 4 } }, 'Client API Key'),
				h(D.TextInput, {
					defaultValue: getApiKey(),
					placeholder: 'ptlc_...',
					secureTextEntry: true,
					onChange: function (v) { keyInput.current = v }
				})
			),
			h(
				D.TableRow,
				{
					label: 'Save Settings',
					subLabel: 'Normalizes URL and clears cached web sessions',
					onPress: function () {
						saveSetting({
							panelUrl: urlInput.current,
							apiKey: keyInput.current
						})
						toast('Pterodactyl credentials saved!')
					}
				}
			)
		)
	}

	// ======================================================================================
	// Plugin Registration
	// ======================================================================================
	Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
	exports.default = plugin({
		jsonStorage: { load: true, default: defaults },
		SettingsComponent: SettingsComponent,
		start: function (api) {
			var cleanup = api.cleanup
			storage = api.jsonStorage

			clearCookies()
			migrateStoredSettings()

			try {
				installPlusHook(cleanup)
			} catch (e) {
				console.error('[Pterodactyl] Hook install error:', e)
			}

			cleanup(function () {
				timers.forEach(function (t) { clearInterval(t) })
				timers = []
				listeners = []
				try {
					valenced.discord.actions.ActionSheetActionCreators.hideActionSheet(SHEET_KEY)
					valenced.discord.actions.ActionSheetActionCreators.hideActionSheet(VIEWER_SHEET_KEY)
					valenced.discord.actions.ActionSheetActionCreators.hideActionSheet(PLAYER_SHEET_KEY)
				} catch (e) {}
			})
		}
	})
	return exports
})({})
