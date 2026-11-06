import React from 'react'
import { patcher } from '@valenced/patcher'
import { actions } from '@valenced/discord/actions'
import { finders } from '@valenced/modules/finders'
import { queryServer, filterRealPlayers } from './status'
import { measurePing } from './ping'
import { SettingsComponent } from './settings'
import { MinecraftServersPanel } from './panel'
import { DEFAULT_SETTINGS, type PluginSettings, type MinecraftServer, type ServerStatusData } from './types'

const SHEET_KEY = 'asaprajx.minecraft-servers.sheet'

export default plugin<{ jsonStorage: PluginSettings }>({
	jsonStorage: {
		load: true,
		default: DEFAULT_SETTINGS,
	},

	SettingsComponent,

	start({ cleanup, jsonStorage, logger }) {
		logger.log('Starting Minecraft Servers plugin...')

		const results: Record<string, { state: string; data?: ServerStatusData; at: number }> = {}
		const lastOnlineState: Record<string, boolean> = {}
		let timers: ReturnType<typeof setInterval>[] = []

		const getSettings = (): PluginSettings => {
			return jsonStorage.cache || DEFAULT_SETTINGS
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

				// Measure local ping if enabled and server is online Java
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

				// Record history
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

		// Initial check for all saved servers
		setTimeout(() => checkAll(false), 2000)

		// Periodic background alert checks
		const alertInterval = Math.max(30, getSettings().alertSeconds || 120) * 1000
		const alertTimer = setInterval(() => {
			const s = getSettings()
			if (!s.alerts) return
			const watched = (s.servers || []).filter(srv => srv.watch)
			for (const w of watched) checkServer(w, true)
		}, alertInterval)
		timers.push(alertTimer)

		// Hook into + Action Menu
		try {
			const runtime: any = finders.lookupModule(finders.filters.withProps('jsx', 'jsxs'))[0] || (globalThis as any).valenced?.react?.ReactJSXRuntime
			if (runtime) {
				const decorateMenu = (result: any) => {
					try {
						const props = result?.props
						if (props && Array.isArray(props.items) && props.items.length >= 2) {
							const hasItem = props.items.some((i: any) => i?.__mcServers)
							if (hasItem) return result

							const template = props.items.find((i: any) => i && typeof i.label === 'string')
							if (!template) return result

							const item = {
								...template,
								label: 'Minecraft Servers',
								__mcServers: true,
								action: () => {
									try { actions.ActionSheetActionCreators.hideAllActionSheets() } catch {}
									setTimeout(openSheet, 200)
								},
								onPress: () => {
									try { actions.ActionSheetActionCreators.hideAllActionSheets() } catch {}
									setTimeout(openSheet, 200)
								},
							}

							return React.cloneElement(result, {
								items: [...props.items, item],
							})
						}
					} catch {}
					return result
				}

				if (typeof runtime.jsx === 'function') cleanup(patcher.after(runtime, 'jsx', decorateMenu))
				if (typeof runtime.jsxs === 'function') cleanup(patcher.after(runtime, 'jsxs', decorateMenu))
			}
		} catch (e) {
			logger.error('Failed to attach menu hook:', e)
		}

		// Register cleanup
		cleanup(() => {
			timers.forEach(t => clearInterval(t))
			timers = []
			try { actions.ActionSheetActionCreators.hideActionSheet(SHEET_KEY) } catch {}
		})
	},
})
