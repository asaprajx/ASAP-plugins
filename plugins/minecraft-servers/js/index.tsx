import React, { useEffect, useState } from 'react'
import { View, Pressable, type GestureResponderEvent } from 'react-native'
import { patcher } from '@valenced/patcher'
import { actions } from '@valenced/discord/actions'
import { finders } from '@valenced/modules/finders'
import { AssetsRegistry, getAssetIdByName } from '@valenced/assets'
import { Design } from '@valenced/discord/design'
import { queryServer, filterRealPlayers } from './status'
import { measurePing } from './ping'
import { SettingsComponent } from './settings'
import { MinecraftServersPanel } from './panel'
import { COLORS } from './components'
import { DEFAULT_SETTINGS, type PluginSettings, type MinecraftServer, type ServerStatusData } from './types'

const SHEET_KEY = 'asaprajx.minecraft-servers.sheet'
const BUTTON_KEY = 'asaprajx-minecraft-servers-chat-button'
const BUTTON_SIZE = 40

const PLUS_LABELS: Record<string, number> = { Camera: 1, Photos: 1, Poll: 1, Files: 1, Apps: 1 }
const PLUS_ICONS = [/camera/i, /image|photo|picture|gallery/i, /poll/i, /paperclip|attach|file|document/i, /\bapps?\b|sparkle|robot|bot/i]
const assetNames = new Map<number, string>()

function getIconName(item: any): string {
	if (!item || typeof item !== 'object') return ''
	const src = item.iconSource
	if (typeof src === 'number') {
		if (assetNames.has(src)) return assetNames.get(src)!
		let name = ''
		try {
			const a = AssetsRegistry.getAssetByID(src)
			name = a?.name || ''
		} catch {}
		assetNames.set(src, name)
		return name
	}
	const Comp = item.IconComponent
	return Comp?.displayName || Comp?.name || ''
}

function plusScore(items: any[]): number {
	const found: Record<number, boolean> = {}
	let strong = false
	for (const item of items) {
		const name = getIconName(item)
		if (!name) continue
		PLUS_ICONS.forEach((re, i) => {
			if (re.test(name)) {
				found[i] = true
				if (i === 0 || i === 2) strong = true
			}
		})
	}
	return strong ? Object.keys(found).length : 0
}

function countMatchingLabels(list: any[]): number {
	let hits = 0
	for (const item of list) {
		const label = item?.label
		if (typeof label === 'string' && PLUS_LABELS[label] === 1) hits++
	}
	return hits
}

function findInFiberTree(node: any, test: (n: any) => boolean, depth = 0): any {
	if (!node || depth > 25) return undefined
	if (Array.isArray(node)) {
		for (const child of node) {
			const hit = findInFiberTree(child, test, depth + 1)
			if (hit) return hit
		}
		return undefined
	}
	if (typeof node !== 'object') return undefined
	if (test(node)) return node
	return node.props ? findInFiberTree(node.props.children, test, depth + 1) : undefined
}

export default plugin<{ jsonStorage: PluginSettings }>({
	jsonStorage: {
		load: true,
		default: DEFAULT_SETTINGS,
	},

	SettingsComponent,

	start({ cleanup, jsonStorage, logger }) {
		logger.log('Starting Minecraft Servers plugin v2.0.1...')

		const results: Record<string, { state: string; data?: ServerStatusData; at: number }> = {}
		const lastOnlineState: Record<string, boolean> = {}
		let timers: ReturnType<typeof setInterval>[] = []

		const getSettings = (): PluginSettings => {
			return jsonStorage.cache || DEFAULT_SETTINGS
		}

		const openSheet = () => {
			const ActionSheet = actions.ActionSheetActionCreators
			if (!ActionSheet) return

			ActionSheet.open(SHEET_KEY, () => (
				<MinecraftServersPanel
					settings={getSettings()}
					results={results}
					onUpdateSettings={(patch) => jsonStorage.set(patch)}
					onRefresh={(srv, force) => checkServer(srv, force)}
					onClose={() => {
						try { ActionSheet.hideActionSheet(SHEET_KEY) } catch {}
					}}
				/>
			))
		}

		const notifyAlert = (server: MinecraftServer, data: ServerStatusData) => {
			const s = getSettings()
			if (!s.alerts || !server.watch || data.error) return
			const wasOnline = lastOnlineState[server.id]
			lastOnlineState[server.id] = data.online
			if (wasOnline === undefined || wasOnline === data.online) return

			actions.ToastActionCreators.open('MC_ALERT', {
				text: `${server.name} ${data.online ? `is now online (${data.players.online} players)` : 'went offline'}!`,
			})
		}

		const checkServer = async (server: MinecraftServer, force = false): Promise<ServerStatusData> => {
			const s = getSettings()
			const existing = results[server.id]
			const cacheMs = (s.cacheSeconds || 20) * 1000

			if (!force && existing && existing.state === 'done' && Date.now() - existing.at < cacheMs && existing.data) {
				return existing.data
			}

			results[server.id] = { state: 'loading', data: existing?.data, at: existing?.at || 0 }

			try {
				let data = await queryServer(server, s.provider, s.timeout, s.liveCounts)
				if (!data.error && data.players?.list) {
					const rp = filterRealPlayers(data.players.list, server.edition)
					data.players = { ...data.players, list: rp.list, hidden: rp.hidden }
				}

				if (!data.error && data.online && server.edition !== 'bedrock' && s.pingSource !== 'site') {
					data.pingFrom = 'measuring'
					measurePing(server, data, s.pingSamples, s.pingFactor).then((p) => {
						if (p && !('unsupported' in p)) {
							data.ping = p.ms
							data.pingFrom = 'phone'
							data.rawPing = p.raw
						}
					})
				}

				results[server.id] = { state: 'done', data, at: Date.now() }

				if (!data.error) {
					const hist = { ...(s.history || {}) }
					const list = hist[server.id] || []
					list.push({ t: Date.now(), o: data.online ? 1 : 0, p: data.players.online, ms: data.ping })
					hist[server.id] = list.slice(-(s.historyLength || 40))
					jsonStorage.set({ history: hist })
				}

				notifyAlert(server, data)
				return data
			} catch (e: any) {
				const data = {
					online: false,
					host: server.address,
					motd: '',
					players: { online: 0, max: 0, list: [] },
					ping: null,
					error: String(e?.message || e),
				}
				results[server.id] = { state: 'done', data, at: Date.now() }
				return data
			}
		}

		const checkAll = (force = false) => {
			const s = getSettings()
			for (const server of s.servers || []) {
				checkServer(server, force)
			}
		}

		// Initial server check
		setTimeout(() => checkAll(false), 2000)

		// Periodic background checks
		const alertInterval = Math.max(30, getSettings().alertSeconds || 120) * 1000
		const alertTimer = setInterval(() => {
			const s = getSettings()
			if (!s.alerts) return
			const watched = (s.servers || []).filter(srv => srv.watch)
			for (const w of watched) checkServer(w, true)
		}, alertInterval)
		timers.push(alertTimer)

		// 1. Hook into + Menu Action Sheet
		try {
			const runtime: any = (globalThis as any).valenced?.react?.ReactJSXRuntime || finders.lookupModule(finders.filters.withProps('jsx', 'jsxs'))[0]
			if (runtime) {
				const decorateMenu = (result: any) => {
					try {
						const props = result?.props
						if (!props || !Array.isArray(props.items) || props.items.length < 2 || props.items.length > 25) {
							return result
						}

						const items = props.items
						const matchesLabels = countMatchingLabels(items) >= 2
						const score = plusScore(items) >= 3

						if (!matchesLabels && !score) return result
						if (items.some((i: any) => i?.__mcServers)) return result

						const template = items.find((i: any) => i && typeof i.label === 'string')
						if (!template) return result

						let assetId: number | undefined
						for (const n of ['GlobeEarthIcon', 'ic_globe_24px', 'ServerIcon', 'GameControllerIcon']) {
							if (assetId === undefined) {
								const id = getAssetIdByName(n)
								if (id != null) assetId = id
							}
						}

						let lastPress = 0
						const press = () => {
							if (Date.now() - lastPress < 1500) return
							lastPress = Date.now()
							try { actions.ActionSheetActionCreators.hideAllActionSheets() } catch {}
							setTimeout(openSheet, 200)
						}

						const item: any = {
							...template,
							label: 'Minecraft Servers',
							__mcServers: true,
							action: press,
							onPress: press,
							onSelect: press,
							onClick: press,
							callback: press,
							handler: press,
						}
						delete item.id
						delete item.key
						delete item.testID
						delete item.nativeID
						delete item.index
						delete item.state

						if (assetId !== undefined) {
							item.iconSource = assetId
						}

						return React.cloneElement(result, {
							items: [...items, item],
						})
					} catch {
						return result
					}
				}

				if (typeof runtime.jsx === 'function') cleanup(patcher.after(runtime, 'jsx', decorateMenu))
				if (typeof runtime.jsxs === 'function') cleanup(patcher.after(runtime, 'jsxs', decorateMenu))
			}
		} catch (e) {
			logger.error('Error attaching + menu patch:', e)
		}

		// 2. Floating Button Component for Chat Input
		function FloatingButton() {
			const s = getSettings()
			const side = s.placement
			if (side !== 'left' && side !== 'right') return null

			const servers = s.servers || []
			let onlineCount = 0
			for (const srv of servers) {
				const r = results[srv.id]
				if (r?.data?.online) onlineCount++
			}

			const placedStyle = side === 'right' ? { right: 0, marginRight: 8 } : { left: 0, marginLeft: 8 }

			return (
				<View
					pointerEvents="box-none"
					style={[
						{ flexDirection: 'row', position: 'absolute', top: -BUTTON_SIZE, zIndex: 3 },
						placedStyle,
					]}
				>
					<Pressable
						accessibilityLabel="Minecraft servers"
						onPress={openSheet}
						style={{
							borderRadius: 999,
							height: BUTTON_SIZE,
							minWidth: BUTTON_SIZE,
							paddingHorizontal: servers.length ? 12 : 0,
							marginTop: -4,
							flexDirection: 'row',
							gap: 6,
							alignItems: 'center',
							justifyContent: 'center',
							backgroundColor: COLORS.SURFACE,
						}}
					>
						<Design.Text variant="text-sm/bold">🎮</Design.Text>
						{servers.length > 0 && (
							<Design.Text variant="text-sm/bold" style={{ color: onlineCount > 0 ? COLORS.GREEN : COLORS.RED }}>
								{onlineCount}/{servers.length}
							</Design.Text>
						)}
					</Pressable>
				</View>
			)
		}

		// 3. Hook ChatInputGuardWrapper to inject floating button if enabled
		try {
			cleanup(
				finders.getModules(
					finders.filters.withName('ChatInputGuardWrapper'),
					(module: any) => {
						if (!module || typeof module.default !== 'function') return
						try {
							cleanup(
								patcher.after(module, 'default', (_args: any, ret: any) => {
									const s = getSettings()
									if (s.placement !== 'left' && s.placement !== 'right') return ret
									if (!ret?.props) return ret

									const row = findInFiberTree(ret.props.children, (x: any) => {
										return (
											x &&
											x.type &&
											(x.type.displayName === 'View' || x.type.name === 'View') &&
											Array.isArray(x.props?.children)
										)
									})

									if (!row?.props?.children) return ret
									const kids = row.props.children
									if (kids.some((k: any) => k?.key === BUTTON_KEY)) return ret

									kids.unshift(<FloatingButton key={BUTTON_KEY} />)
									return ret
								}),
							)
						} catch (err) {
							logger.error('Failed to patch ChatInputGuardWrapper:', err)
						}
					},
					{ returnNamespace: true },
				),
			)
		} catch (e) {
			logger.error('Error finding ChatInputGuardWrapper:', e)
		}

		// Register teardown cleanup
		cleanup(() => {
			timers.forEach(t => clearInterval(t))
			timers = []
			try { actions.ActionSheetActionCreators.hideActionSheet(SHEET_KEY) } catch {}
		})
	},
})
