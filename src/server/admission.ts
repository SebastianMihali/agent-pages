import { DomainError } from './errors'

/** One installation/owner budget spans keys, transports and browser sessions. */
export function createAdmission(maximum: number) {
  let active = 0
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (active >= maximum) throw new DomainError('BUSY', 'Too many requests are being processed')
    active++
    try { return await work() }
    finally { active-- }
  }
}
