const NONCE_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function createNonce(length = 32, random: () => number = Math.random): string {
  let nonce = '';
  for (let index = 0; index < length; index += 1) {
    nonce += NONCE_ALPHABET.charAt(Math.floor(random() * NONCE_ALPHABET.length));
  }
  return nonce;
}
