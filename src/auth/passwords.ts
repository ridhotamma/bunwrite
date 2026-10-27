/**
 * Password hashing. New hashes are argon2id with Appwrite's own parameters
 * (m=7168 KiB, t=5, p=1), so migrated and new users look the same. Hashes
 * imported from Appwrite in other formats keep working.
 */
import { createHash, scryptSync, timingSafeEqual } from 'node:crypto'

import { err } from '~/lib/errors'

export const HASH_OPTIONS = { type: 'argon2', memoryCost: 7168, timeCost: 5, threads: 1 } as const

export function validatePassword(password: unknown, param = 'password'): string {
  if (typeof password !== 'string' || password.length < 8 || password.length > 256) {
    throw err('general_argument_invalid', `Invalid \`${param}\` param: Password must be between 8 and 256 characters long.`)
  }
  return password
}

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: 'argon2id', memoryCost: HASH_OPTIONS.memoryCost, timeCost: HASH_OPTIONS.timeCost })
}

export function appwriteHashOptions(): Record<string, unknown> {
  return { type: 'argon2', memory_cost: HASH_OPTIONS.memoryCost, time_cost: HASH_OPTIONS.timeCost, threads: HASH_OPTIONS.threads }
}

const equal = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b)

/** Check a password against a stored hash in any format Appwrite exports. */
export async function verifyPassword(password: string, hash: string | null, algorithm: string, options: Record<string, any> = {}): Promise<boolean> {
  if (!hash) return false
  try {
    switch (algorithm) {
      case 'argon2':
      case 'bcrypt':
        return await Bun.password.verify(password, hash)
      case 'md5':
        return equal(createHash('md5').update(password).digest(), Buffer.from(hash, 'hex'))
      case 'sha': {
        const version = String(options.version ?? 'sha256').replace('sha3-', 'sha3-')
        return equal(createHash(version).update(password).digest(), Buffer.from(hash, 'hex'))
      }
      case 'scrypt': {
        const salt = String(options.salt ?? '')
        const key = scryptSync(password, salt, Number(options.length ?? 64), {
          N: Number(options.costCpu ?? 8),
          r: Number(options.costMemory ?? 14),
          p: Number(options.costParallel ?? 1),
          maxmem: 256 * 1024 * 1024,
        })
        return equal(key, Buffer.from(hash, 'hex'))
      }
      default:
        // phpass and Firebase's modified scrypt are not supported; such users reset their password.
        return false
    }
  } catch {
    return false
  }
}
