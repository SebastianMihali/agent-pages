import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

const format = /^scrypt\$131072\$8\$1\$([a-f0-9]{32})\$([a-f0-9]{64})$/

function derive(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 32, { N: 131072, r: 8, p: 1, maxmem: 192 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error)
      else resolve(key)
    })
  })
}

export async function hashPassword(password: string): Promise<string> {
  if (!password || Buffer.byteLength(password) > 1024) throw new Error('Password must contain 1 to 1024 UTF-8 bytes')
  const salt = randomBytes(16)
  const hash = await derive(password, salt)
  return `scrypt$131072$8$1$${salt.toString('hex')}$${hash.toString('hex')}`
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const match = format.exec(encoded)
  if (!match) throw new Error('Unsupported configured password hash format')
  if (!password || Buffer.byteLength(password) > 1024) return false
  return timingSafeEqual(await derive(password, Buffer.from(match[1], 'hex')), Buffer.from(match[2], 'hex'))
}
