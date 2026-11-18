import type { Device, Peer } from './runtime'

/** 设备的头像和名字：频道里认识的用对方 FoxSync 的 ID、头像风格和昵称，其他按 Syncthing 设备 ID 画 */
export type Face = { id: string; name: string; avatar?: string; peer: boolean }

export function face(device: Pick<Device, 'id' | 'name'>, peers: Peer[]): Face {
  const p = peers.find((x) => x.syncthingId === device.id)
  return p
    ? { id: p.id, name: p.name || device.name, avatar: p.avatar, peer: true }
    : { id: device.id, name: device.name, peer: false }
}
