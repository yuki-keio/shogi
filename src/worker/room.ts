// SPDX-License-Identifier: GPL-3.0-only

// URL safe, human friendly (no 0/O, 1/I).
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function generateRoomCode(len = 10): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length];
  }
  return out;
}

export function normalizeRoomCode(input: string): string {
  return input.trim().toUpperCase();
}

export function isValidRoomCode(input: string): boolean {
  if (!/^[A-Z2-9]+$/.test(input)) return false;
  // Keep it tight to avoid filter injection in realtime subscriptions.
  if (input.length < 6 || input.length > 20) return false;
  return true;
}

