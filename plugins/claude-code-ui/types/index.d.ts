export type Rel = 'self' | 'team' | 'external'
export type Role = 'peer' | 'asker' | 'responder' | 'listener' | 'notifier' | 'off'
export type Peer = { id: string; name: string; rel: Rel; fingerprint: string; label: string }
export type Session = { id: string; label: string; agent: string; device: string; kept?: boolean }
export type Caps = { initiate: boolean; accept: boolean; send: boolean; receive: boolean }
export type Group = { id: string; size: number }
export type Link = {
  id: string
  peer: Peer
  peerSession: Session
  topic: string
  direction: 'in' | 'out'
  group?: Group
  caps: Caps
  peerCaps: { send: boolean; receive: boolean }
  role: Role
  mode?: 'ask' | 'review' | 'auto' | 'trusted'
  send: 'ask' | 'auto'
  allowSecrets: boolean
  isolation: 'relaxed' | 'standard' | 'strict'
  autoSendLimit: number
  autoStreak: number
  sent: number
  received: number
}
export type Request = {
  id: string
  peer: Peer
  session: Session
  topic: string
  topicFlags: string[]
  message?: string
  flags: string[]
  group?: Group
  peerCaps: { send: boolean; receive: boolean }
  at: number
}
export type Outgoing = { id: string; peer: Peer; topic: string; group?: Group; at: number }
export type Note = {
  key: string
  id: string
  dir: 'in' | 'out'
  peer: Peer
  kind: 'ask' | 'note' | 'reply' | 'request'
  subject: string
  text: string
  flags: string[]
  ticket?: string
  at: number
  state: string
  stateAt: number
  session: { id: string; label: string; kept?: boolean }
  answer?: { text: string; flags: string[]; at: number; key: string; fits: boolean }
}

export type Notes = {
  inbox: Note[]
  answers: Note[]
  waiting: Array<{ key: string; id: string; peer: Peer; subject: string; state: string; at: number }>
}

export type View = {
  exposure?: { by: string; isolation: 'relaxed' | 'standard' | 'strict'; at: number } | null
  session: Session
  identity: { name: string; fingerprint: string } | null
  relay: { url: string | null; connected: boolean }
  links: Link[]
  incoming: Request[]
  outgoing: Outgoing[]
  tainted: { by: string; linkId: string; at: number } | null
  isolation: 'relaxed' | 'standard' | 'strict' | null
  paused: boolean
  mode: Role | null
  maxLinks: number
  policyChanged: boolean
  profile: { name: string; org: string | null; orgOnly: boolean; external: boolean; requireVerified: boolean; autoSend: boolean; autoAccept: boolean; files: boolean; messages: boolean; records: boolean }
  delivery: 'mod' | 'channel' | 'hooks'
  pending: number
  // Your company keeps a sealed copy of messages (managed policy journal).
  kept?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'quietsync-ui': {
      view: View | null
      token: string | null
      seq: number
      confirm: string | null
      problem: string | null
      notes: Notes | null
    }
  }
}
