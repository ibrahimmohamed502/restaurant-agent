import bcrypt from 'bcryptjs';

const ROUNDS = 10;

export function hashPassword(plain) {
  return bcrypt.hash(plain, ROUNDS);
}

export function verifyPassword(plain, hash) {
  try {
    return bcrypt.compare(plain, hash);
  } catch {
    return false;
  }
}
