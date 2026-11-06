import React from 'react'
import { Design } from '@valenced/discord/design'
import { actions } from '@valenced/discord/actions'
import { ReactNativeClipboard } from '@valenced/externals/react-native-clipboard'
import type { PluginSettings, MinecraftServer } from './types'

export function SettingsComponent({ api }: { api: { jsonStorage: { use: () => PluginSettings; set: (patch: Partial<PluginSettings>) => void; cache: PluginSettings } } }) {
	const settings = api.jsonStorage.use()

	const update = (patch: Partial<PluginSettings>) => {
		api.jsonStorage.set(patch)
	}

	const exportBackup = () => {
		try {
			const data = JSON.stringify({
				version: 1,
				exportedAt: Date.now(),
				servers: settings?.servers || [],
			}, null, 2)
			ReactNativeClipboard.Clipboard.setString(data)
			actions.ToastActionCreators.open('MC_SERVERS_BACKUP', { text: 'Servers copied to clipboard!' })
		} catch {
			actions.ToastActionCreators.open('MC_SERVERS_BACKUP_ERR', { text: 'Failed to export servers' })
		}
	}

	const importBackup = async () => {
		try {
			const text = await ReactNativeClipboard.Clipboard.getString()
			let importedServers: any[] = []
			try {
				const parsed = JSON.parse(text)
				if (Array.isArray(parsed)) importedServers = parsed
				else if (Array.isArray(parsed?.servers)) importedServers = parsed.servers
			} catch {
				// plain lines
				const lines = text.split(/[\r\n,;]+/).map(l => l.trim()).filter(Boolean)
				importedServers = lines.map(address => ({ address }))
			}

			if (!importedServers.length) {
				actions.ToastActionCreators.open('MC_IMPORT_EMPTY', { text: 'No servers found in clipboard' })
				return
			}

			const current = [...(settings?.servers || [])]
			let added = 0

			for (const item of importedServers) {
				if (!item?.address) continue
				const exists = current.some(s => s.address === item.address && (s.port || 0) === (item.port || 0))
				if (!exists) {
					current.push({
						id: 'm' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36),
						name: String(item.name || item.address).slice(0, 40),
						address: item.address,
						port: item.port || 0,
						edition: item.edition === 'bedrock' ? 'bedrock' : 'java',
						note: String(item.note || '').slice(0, 120),
						favorite: !!item.favorite,
						watch: !!item.watch,
						addedAt: Date.now(),
					})
					added++
				}
			}

			update({ servers: current })
			actions.ToastActionCreators.open('MC_IMPORT_SUCCESS', { text: `Imported ${added} new server(s)` })
		} catch {
			actions.ToastActionCreators.open('MC_IMPORT_FAIL', { text: 'Could not read clipboard' })
		}
	}

	return (
		<Design.TableRowGroup title="General Settings">
			<Design.TableSwitchRow
				label="Show Player Avatars & Icons"
				subLabel="Display custom server icons when available"
				value={settings?.icons ?? true}
				onValueChange={(icons: boolean) => update({ icons })}
			/>
			<Design.TableSwitchRow
				label="Show Player Heads"
				subLabel="Display Minecraft player skins / head avatars"
				value={settings?.heads ?? true}
				onValueChange={(heads: boolean) => update({ heads })}
			/>
			<Design.TableSwitchRow
				label="Compact Mode"
				subLabel="Use denser server rows in the list"
				value={settings?.compact ?? false}
				onValueChange={(compact: boolean) => update({ compact })}
			/>
			<Design.TableSwitchRow
				label="Live Player Counts"
				subLabel="Query live minetools count alongside cached metadata"
				value={settings?.liveCounts ?? true}
				onValueChange={(liveCounts: boolean) => update({ liveCounts })}
			/>
			<Design.TableSwitchRow
				label="Server Status Alerts"
				subLabel="Toast notification when watched servers go online or offline"
				value={settings?.alerts ?? false}
				onValueChange={(alerts: boolean) => update({ alerts })}
			/>

			<Design.TableRow
				label="Export Servers to Clipboard"
				subLabel="Copy your saved servers as JSON backup"
				onPress={exportBackup}
			/>
			<Design.TableRow
				label="Import Servers from Clipboard"
				subLabel="Add servers from a JSON backup or address list in clipboard"
				onPress={importBackup}
			/>
		</Design.TableRowGroup>
	)
}
