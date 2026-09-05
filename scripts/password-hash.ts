import { createInterface } from 'node:readline/promises'
import { Writable } from 'node:stream'
import { hashPassword } from '../src/server/auth/password.ts'

// Terminal input is deliberately never echoed; the only stdout output is the hash.
if (!process.stdin.isTTY || process.argv.length !== 2) {
  console.error('Run the password helper interactively without arguments.')
  process.exitCode = 1
} else {
  const silent = new Writable({ write(_chunk, _encoding, done) { done() } })
  const terminal = createInterface({ input: process.stdin, output: silent, terminal: true })
  const abort = new AbortController()
  terminal.on('SIGINT', () => abort.abort())
  try {
    process.stderr.write('Password: ')
    const password = await terminal.question('', { signal: abort.signal })
    process.stderr.write('\nConfirm password: ')
    const confirmation = await terminal.question('', { signal: abort.signal })
    process.stderr.write('\n')
    if (password !== confirmation) {
      console.error('Passwords do not match.')
      process.exitCode = 1
    } else if (!password || Buffer.byteLength(password) > 1024) {
      console.error('Password must contain 1 to 1024 UTF-8 bytes.')
      process.exitCode = 1
    } else {
      console.log(await hashPassword(password))
    }
  } catch {
    console.error('\nPassword hash generation did not complete.')
    process.exitCode = 1
  } finally {
    terminal.close()
    silent.end()
  }
}
