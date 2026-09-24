import { randomInt } from 'node:crypto';
import bcrypt from 'bcryptjs';

const UPPERCASE = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWERCASE = 'abcdefghijkmnopqrstuvwxyz';
const NUMBERS = '23456789';
const SYMBOLS = '!@#$%&*';

export function generateProvisionalPassword(length = 14): string {
  const chars = [
    UPPERCASE[randomInt(0, UPPERCASE.length)],
    LOWERCASE[randomInt(0, LOWERCASE.length)],
    NUMBERS[randomInt(0, NUMBERS.length)],
    SYMBOLS[randomInt(0, SYMBOLS.length)],
  ];
  const all = UPPERCASE + LOWERCASE + NUMBERS + SYMBOLS;
  for (let i = chars.length; i < length; i++) {
    chars.push(all[randomInt(0, all.length)]);
  }
  for (let i = chars.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

export async function hashPassword(plainText: string): Promise<string> {
  return bcrypt.hash(plainText, 12);
}

export function isProvisionalPasswordExpired(expiresAt: Date | null | undefined, now = new Date()): boolean {
  if (!expiresAt) return false;
  return expiresAt.getTime() < now.getTime();
}
