import { MAX_TEXT } from './messages.ts'

export type Sanitized = { text: string; flags: string[] }

// Invisible or direction-changing characters used to hide instructions from the
// human while the model still reads them (bidi overrides, zero-width, Unicode
// tag characters for "ASCII smuggling", variation selectors).
export const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ￰-￻]|\uDB40[\uDC00-\uDDEF]/g
export const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g

// Tags the harness or model treat as structure. Peers don't get to open or close them.
const STRUCTURAL_TAG =
  /<\s*\/?\s*(system[\w-]*|channel|function_calls|function_results|invoke|parameter|antml[:\w-]*|tool_use|tool_result|human|assistant|user|instructions|command-[\w-]+|local-command[\w-]*|quietsync[\w-]*|peer[\w-]*|untrusted[\w-]*|thinking|answer)\b[^>]*>/gi
const SPECIAL_TOKEN = /<\|[^|>]{0,40}\|>/g
const FRAME_MARKER = /⟦\/?peer[^⟧]*⟧/g

const SUSPICIOUS: Array<[string, RegExp]> = [
  ['override-instructions', /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|system|all)\b[^.\n]{0,20}\b(instruction|prompt|rule|message)s?/i],
  ['role-claim', /\b(you are now|act as|new instructions|system prompt|developer mode|jailbreak)\b/i],
  ['authority-claim', /\b(the (user|human|owner|boss)\b[^.\n]{0,20}\b(approved|authori[sz]ed|signed off|said (it'?s )?(fine|ok))|pre-?approved|admin override)\b/i],
  ['run-command', /\b(run|execute|exec)\b[^.\n]{0,30}\b(command|script|shell|bash|curl|wget)\b/i],
  ['pipe-to-shell', /\b(curl|wget)\b[^\n|]{0,200}\|\s*(ba|z)?sh\b/i],
  ['exfil-secrets', /\b(send|share|paste|post|upload|print|cat|reveal)\b[^\n]{0,60}(\.env\b|\bsecret|\btoken|\bpassword|\bapi[ _-]?key|\bprivate key|\bcredential|\.ssh\b|\bid_rsa)/i],
  ['fake-prompt', /do you want to proceed\?|❯\s*\d\.\s*yes\b|\[y\/n\]|press (enter|y) to (approve|allow|continue)/i],
  ['hidden-comment', /<!--[\s\S]*?-->/],
  ['encoded-payload', /[A-Za-z0-9+/=_-]{240,}/],
  ['policy-change', /\b(auto[- ]?send|auto[- ]?approve|disable|turn off)\b[^.\n]{0,30}\b(approval|quietsync|permission|safety|guard)/i],
]

export function sanitizeInbound(raw: string): Sanitized {
  const flags: string[] = []
  let text = raw.normalize('NFC')

  const invisible = text.match(INVISIBLE)
  if (invisible) {
    flags.push('hidden-characters')
    text = text.replace(INVISIBLE, '')
  }
  text = text.replace(/\r\n?/g, '\n').replace(CONTROL, '')

  // Swap the brackets for look-alikes so the text stays readable but inert.
  const inert = (m: string) => m.replace(/</g, '‹').replace(/>/g, '›')
  const neutered = text
    .replace(STRUCTURAL_TAG, inert)
    .replace(SPECIAL_TOKEN, inert)
    .replace(FRAME_MARKER, m => m.replace('⟦', '[').replace('⟧', ']'))
  if (neutered !== text) {
    flags.push('markup-injection')
    text = neutered
  }

  text = text.replace(/\n{4,}/g, '\n\n\n').trim()
  if (text.length > MAX_TEXT) {
    flags.push('truncated')
    text = text.slice(0, MAX_TEXT)
  }

  for (const [name, re] of SUSPICIOUS) if (re.test(text)) flags.push(name)
  return { text, flags }
}

// For short single-line fields (names, topics, labels) shown in UI and prompts.
export function sanitizeLabel(raw: string, max = 120): string {
  return sanitizeInbound(raw).text.replace(/\s+/g, ' ').replace(/[<>]/g, '').slice(0, max)
}

export function isSuspicious(flags: string[]): boolean {
  return flags.some(f => f !== 'truncated')
}
