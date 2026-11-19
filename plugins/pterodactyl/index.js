(function (exports) {
	/*
	 * Pterodactyl Server Controller for Valenced Discord Mobile.
	 * Monitor live CPU/RAM/Disk, send console commands, browse server files, and trigger power actions.
	 * Keep `(function` as the first thing in this file: Valenced loads it as `return <file>`.
	 */
	var PLUGIN_ID = 'asaprajx.pterodactyl'
	var SHEET_KEY = 'asaprajx.pterodactyl.panel'
	var VIEWER_SHEET_KEY = 'asaprajx.pterodactyl.fileviewer'
	var TOAST_ID = 'ASAP_PTERODACTYL'

	var GREEN = '#23a55a'
	var RED = '#f23f43'
	var AMBER = '#f0b232'
	var GRAY = '#80848e'
	var BLURPLE = '#5865f2'

	var defaults = {
		panelUrl: 'https://panel.altare.global',
		apiKey: '',
		defaultServerId: 'ed321e1e',
		autoRefresh: 15
	}

	var storage
	var listeners = []
	var timers = []
	var toastSeq = 0
	var state = {
		servers: [],
		selectedServerId: 'ed321e1e',
		serverStats: null,
		loadingStats: false,
		lastError: '',
		currentDir: '/',
		files: [],
		loadingFiles: false,
		logs: '',
		logLines: [],
		loadingLogs: false,
		history: []
	}

	function finders() { return valenced.modules.finders }
	function Design() { return valenced.discord.design.Design }

	// ---- Native Cookie Clearing (Prevents 419 CSRF Token Mismatch) --------------------------
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

	// ---- URL Sanitization & Server ID Extraction -------------------------------------------
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
			// Automatic 419 CSRF recovery: Clear native cookie store and retry once
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
			return state.servers
		}).catch(function (err) {
			state.lastError = errorText(err)
			changed()
			throw err
		})
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
			{ title: props.fileName, subLabel: props.filePath },
			scrollView(
				RN,
				{
					style: {
						height: viewerHeight,
						backgroundColor: '#111214',
						borderRadius: 8,
						marginHorizontal: 10,
						borderWidth: 1,
						borderColor: '#2b2d31'
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
			h(
				RN.View,
				{ style: { flexDirection: 'row', paddingHorizontal: 10, paddingTop: 10, paddingBottom: 20 } },
				h(
					RN.TouchableOpacity,
					{
						onPress: function () { copyText(props.content || '', props.fileName) },
						style: { flex: 1, backgroundColor: '#2b2d31', paddingVertical: 12, borderRadius: 8, alignItems: 'center', marginRight: 6 }
					},
					T({ variant: 'text-sm/bold', style: { color: '#f2f3f5' } }, 'Copy Content')
				),
				h(
					RN.TouchableOpacity,
					{
						onPress: function () {
							try { valenced.discord.actions.ActionSheetActionCreators.hideActionSheet(VIEWER_SHEET_KEY) } catch (e) {}
						},
						style: { flex: 1, backgroundColor: BLURPLE, paddingVertical: 12, borderRadius: 8, alignItems: 'center', marginLeft: 6 }
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
		var stats = state.serverStats || {}
		var res = stats.resources || {}
		var currentState = stats.current_state || 'unknown'

		var stateColor = GRAY
		if (currentState === 'running') stateColor = GREEN
		else if (currentState === 'starting' || currentState === 'stopping') stateColor = AMBER
		else if (currentState === 'offline') stateColor = RED

		// Navigation Tabs Header
		function renderTabs() {
			var tabs = [
				{ id: 'status', label: 'Status' },
				{ id: 'console', label: 'Console' },
				{ id: 'files', label: 'Files' },
				{ id: 'settings', label: 'Config' }
			]
			return h(
				RN.View,
				{ style: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 12, marginBottom: 12 } },
				tabs.map(function (tab) {
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
							},
							style: {
								flex: 1,
								marginHorizontal: 3,
								paddingVertical: 10,
								borderRadius: 18,
								alignItems: 'center',
								backgroundColor: isActive ? BLURPLE : '#2b2d31'
							}
						},
						T({ variant: 'text-sm/bold', style: { color: isActive ? '#ffffff' : '#b5bac1' } }, tab.label)
					)
				})
			)
		}

		// TAB 1: STATUS & POWER
		function renderStatusTab() {
			var cpuPercent = (res.cpu_absolute != null ? res.cpu_absolute.toFixed(1) : '0') + '%'
			var memStr = formatBytes(res.memory_bytes)
			var memLimit = (selectedServer.limits && selectedServer.limits.memory ? selectedServer.limits.memory + ' MB' : 'Unlimited')
			var diskStr = formatBytes(res.disk_bytes)
			var diskLimit = (selectedServer.limits && selectedServer.limits.disk ? selectedServer.limits.disk + ' MB' : 'Unlimited')

			return h(
				RN.View,
				{ style: { paddingHorizontal: 10 } },
				// Server Header Card
				h(
					RN.View,
					{ style: { backgroundColor: '#1e1f22', borderRadius: 12, padding: 14, marginBottom: 14 } },
					h(
						RN.View,
						{ style: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' } },
						h(
							RN.View,
							{ style: { flex: 1, marginRight: 8 } },
							T({ variant: 'heading-md/bold', style: { color: '#f2f3f5' } }, selectedServer.name),
							T({ variant: 'text-xs/medium', style: { color: '#949ba4' } }, 'ID: ' + selectedServer.id + (selectedServer.node ? ' | ' + selectedServer.node : ''))
						),
						h(
							RN.View,
							{ style: { backgroundColor: stateColor, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12 } },
							T({ variant: 'text-xs/bold', style: { color: '#ffffff' } }, currentState.toUpperCase())
						)
					),
					h(RN.View, { style: { height: 1, backgroundColor: '#2b2d31', marginVertical: 12 } }),
					// Metrics Row
					h(
						RN.View,
						{ style: { flexDirection: 'row', justifyContent: 'space-between' } },
						h(RN.View, null, T({ variant: 'text-xs/medium', style: { color: '#949ba4' } }, 'CPU Load'), T({ variant: 'heading-sm/bold', style: { color: '#ffffff', marginTop: 2 } }, cpuPercent)),
						h(RN.View, null, T({ variant: 'text-xs/medium', style: { color: '#949ba4' } }, 'Memory (RAM)'), T({ variant: 'heading-sm/bold', style: { color: '#ffffff', marginTop: 2 } }, memStr + ' / ' + memLimit)),
						h(RN.View, null, T({ variant: 'text-xs/medium', style: { color: '#949ba4' } }, 'Disk Storage'), T({ variant: 'heading-sm/bold', style: { color: '#ffffff', marginTop: 2 } }, diskStr + ' / ' + diskLimit))
					)
				),
				// Power Action Buttons Row
				T({ variant: 'eyebrow', style: { color: '#949ba4', marginBottom: 8 } }, 'POWER CONTROLS'),
				h(
					RN.View,
					{ style: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 16 } },
					h(
						RN.TouchableOpacity,
						{
							onPress: function () { sendPower(currentServerId, 'start') },
							style: { flex: 1, backgroundColor: GREEN, paddingVertical: 12, borderRadius: 8, alignItems: 'center', marginHorizontal: 3 }
						},
						T({ variant: 'text-sm/bold', style: { color: '#ffffff' } }, 'Start')
					),
					h(
						RN.TouchableOpacity,
						{
							onPress: function () { sendPower(currentServerId, 'restart') },
							style: { flex: 1, backgroundColor: AMBER, paddingVertical: 12, borderRadius: 8, alignItems: 'center', marginHorizontal: 3 }
						},
						T({ variant: 'text-sm/bold', style: { color: '#111214' } }, 'Restart')
					),
					h(
						RN.TouchableOpacity,
						{
							onPress: function () { sendPower(currentServerId, 'stop') },
							style: { flex: 1, backgroundColor: RED, paddingVertical: 12, borderRadius: 8, alignItems: 'center', marginHorizontal: 3 }
						},
						T({ variant: 'text-sm/bold', style: { color: '#ffffff' } }, 'Stop')
					),
					h(
						RN.TouchableOpacity,
						{
							onPress: function () { sendPower(currentServerId, 'kill') },
							style: { flex: 1, backgroundColor: '#800000', paddingVertical: 12, borderRadius: 8, alignItems: 'center', marginHorizontal: 3 }
						},
						T({ variant: 'text-sm/bold', style: { color: '#ffffff' } }, 'Kill')
					)
				),
				// Refresh Button
				h(
					D.Button,
					{
						variant: 'secondary',
						text: state.loadingStats ? 'Refreshing...' : 'Refresh Status',
						onPress: function () { fetchResources(currentServerId) }
					}
				)
			)
		}

		// TAB 2: CONSOLE & COMMANDS (Direct non-nested scroll for silky smooth terminal interaction)
		function renderConsoleTab() {
			var presets = ['/list', '/tps', '/whitelist list', '/say Hello!', '/save-all']

			var displayText = state.logs || 'No logs fetched yet. Tap Refresh Logs above.'
			if (state.logLines && state.logLines.length > 0) {
				var displaySlice = state.logLines.slice(-60)
				if (logOrder === 'top') {
					displayText = displaySlice.slice().reverse().join('\n')
				} else {
					displayText = displaySlice.join('\n')
				}
			}

			var logHeight = Math.max(220, sheetMinHeight - 170)

			return h(
				RN.View,
				{ style: { flex: 1, paddingHorizontal: 10 } },
				T({ variant: 'eyebrow', style: { color: '#949ba4', marginBottom: 6 } }, 'EXECUTE CONSOLE COMMAND'),
				h(
					RN.View,
					{ style: { flexDirection: 'row', marginBottom: 10, alignItems: 'center' } },
					h(
						RN.View,
						{ style: { flex: 1, marginRight: 8 } },
						h(D.TextInput, {
							placeholder: 'e.g. /say Hi or /whitelist add...',
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
							style: { backgroundColor: BLURPLE, paddingHorizontal: 16, paddingVertical: 12, borderRadius: 8 }
						},
						T({ variant: 'text-sm/bold', style: { color: '#ffffff' } }, 'Send')
					)
				),
				// Presets Chips
				h(
					RN.View,
					{ style: { flexDirection: 'row', flexWrap: 'wrap', marginBottom: 10 } },
					presets.map(function (p) {
						return h(
							RN.TouchableOpacity,
							{
								key: p,
								onPress: function () { setCommandText(p) },
								style: { backgroundColor: '#2b2d31', paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, marginRight: 6, marginBottom: 6 }
							},
							T({ variant: 'text-xs/medium', style: { color: '#dbdee1' } }, p)
						)
					})
				),
				// Server Log Header with controls
				h(
					RN.View,
					{ style: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 } },
					T({ variant: 'eyebrow', style: { color: '#949ba4' } }, 'SERVER LOGS (latest.log)'),
					h(
						RN.View,
						{ style: { flexDirection: 'row', alignItems: 'center' } },
						h(
							RN.TouchableOpacity,
							{
								onPress: function () {
									setLogOrder(logOrder === 'bottom' ? 'top' : 'bottom')
								},
								style: { backgroundColor: '#2b2d31', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, marginRight: 6 }
							},
							T({ variant: 'text-xs/bold', style: { color: '#dbdee1' } }, logOrder === 'bottom' ? '⇅ Newest at Top' : '⇅ Chronological')
						),
						logOrder === 'bottom' ? h(
							RN.TouchableOpacity,
							{
								onPress: function () {
									if (logScrollRef.current && typeof logScrollRef.current.scrollToEnd === 'function') {
										logScrollRef.current.scrollToEnd({ animated: true })
									}
								},
								style: { backgroundColor: '#2b2d31', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 8, marginRight: 6 }
							},
							T({ variant: 'text-xs/bold', style: { color: '#dbdee1' } }, '↓ End')
						) : null,
						h(
							RN.TouchableOpacity,
							{ onPress: function () { fetchLogs(currentServerId) } },
							T({ variant: 'text-xs/bold', style: { color: BLURPLE } }, state.loadingLogs ? 'Loading...' : '⟳ Refresh')
						)
					)
				),
				// Direct ScrollView for Logs (No parent scroll conflicts!)
				scrollView(
					RN,
					{
						ref: logScrollRef,
						style: {
							height: logHeight,
							backgroundColor: '#111214',
							borderRadius: 8,
							borderWidth: 1,
							borderColor: '#2b2d31'
						},
						contentContainerStyle: {
							padding: 10,
							paddingBottom: 24,
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

		// TAB 3: FILE EXPLORER
		function renderFilesTab() {
			return h(
				RN.View,
				{ style: { paddingHorizontal: 10 } },
				// Breadcrumbs & Navigation
				h(
					RN.View,
					{ style: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 } },
					T({ variant: 'text-sm/bold', style: { color: '#f2f3f5' } }, 'Path: ' + state.currentDir),
					state.currentDir !== '/' ? h(
						RN.TouchableOpacity,
						{
							onPress: function () {
								var parts = state.currentDir.replace(/\/+$/, '').split('/')
								parts.pop()
								var parentDir = parts.join('/') || '/'
								fetchFiles(currentServerId, parentDir)
							},
							style: { backgroundColor: '#2b2d31', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 12 }
						},
						T({ variant: 'text-xs/bold', style: { color: BLURPLE } }, '↑ Up')
					) : null
				),
				// File list directly inside sheet scroll view
				state.loadingFiles ? T({ variant: 'text-sm/medium', style: { color: '#949ba4', textAlign: 'center', marginVertical: 30 } }, 'Loading directory contents...') :
				h(
					D.TableRowGroup,
					null,
					state.files.length === 0 ? h(
						D.TableRow,
						{ label: '(Empty directory)', subLabel: 'No files or folders found' }
					) : state.files.map(function (f) {
						var isDir = !f.is_file
						var fullPath = (state.currentDir === '/' ? '/' : state.currentDir + '/') + f.name
						return h(
							D.TableRow,
							{
								key: f.name,
								label: (isDir ? '📁 ' : '📄 ') + f.name,
								subLabel: isDir ? 'Directory' : formatBytes(f.size),
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
								}
							}
						)
					})
				)
			)
		}

		// TAB 4: SETTINGS & CONFIG
		var urlInputRef = React.useRef(getPanelUrl())
		var keyInputRef = React.useRef(getApiKey())
		function renderSettingsTab() {
			return h(
				RN.View,
				{ style: { paddingHorizontal: 10 } },
				h(
					D.TableRowGroup,
					{ title: 'Pterodactyl Panel Connection' },
					h(
						RN.View,
						{ style: { padding: 10 } },
						T({ variant: 'text-xs/medium', style: { color: '#949ba4', marginBottom: 4 } }, 'Panel Base URL (e.g. https://panel.example.com)'),
						h(D.TextInput, {
							defaultValue: getPanelUrl(),
							placeholder: 'https://panel.altare.global',
							onChange: function (val) { urlInputRef.current = val }
						})
					),
					h(
						RN.View,
						{ style: { padding: 10 } },
						T({ variant: 'text-xs/medium', style: { color: '#949ba4', marginBottom: 4 } }, 'Client API Key (ptlc_...)'),
						h(D.TextInput, {
							defaultValue: getApiKey(),
							placeholder: 'ptlc_...',
							secureTextEntry: true,
							onChange: function (val) { keyInputRef.current = val }
						})
					),
					h(
						D.TableRow,
						{
							label: 'Save Credentials',
							subLabel: 'Normalizes URL and clears cached web sessions',
							onPress: function () {
								saveSetting({
									panelUrl: urlInputRef.current,
									apiKey: keyInputRef.current
								})
								toast('Pterodactyl credentials saved!')
								fetchServers().catch(function () {})
							}
						}
					)
				),
				// Server Selector if multiple servers exist
				state.servers.length > 1 ? h(
					D.TableRowGroup,
					{ title: 'Switch Active Server' },
					state.servers.map(function (s) {
						var active = s.id === currentServerId
						return h(
							D.TableRow,
							{
								key: s.id,
								label: (active ? '✓ ' : '') + s.name,
								subLabel: 'ID: ' + s.id + ' (' + s.node + ')',
								onPress: function () {
									state.selectedServerId = s.id
									saveSetting({ defaultServerId: s.id })
									changed()
									fetchResources(s.id)
									toast('Selected: ' + s.name)
								}
							}
						)
					})
				) : null
			)
		}

		return h(
			D.ActionSheet,
			{
				title: 'Pterodactyl Controller',
				subLabel: selectedServer ? selectedServer.name + ' (' + currentState.toUpperCase() + ')' : 'Server Dashboard'
			},
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
							paddingBottom: 28
						},
						keyboardShouldPersistTaps: 'handled',
						nestedScrollEnabled: true,
						showsVerticalScrollIndicator: true
					},
					activeTab === 'status' ? renderStatusTab() :
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
				T({ variant: 'text-xs/medium', style: { color: '#949ba4', marginBottom: 4 } }, 'Panel Base URL (e.g. https://panel.example.com)'),
				h(D.TextInput, {
					defaultValue: getPanelUrl(),
					placeholder: 'https://panel.altare.global',
					onChange: function (v) { urlInput.current = v }
				})
			),
			h(
				valenced.react.ReactNative.View,
				{ style: { padding: 12 } },
				T({ variant: 'text-xs/medium', style: { color: '#949ba4', marginBottom: 4 } }, 'Client API Key'),
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
				} catch (e) {}
			})
		}
	})
	return exports
})({})
