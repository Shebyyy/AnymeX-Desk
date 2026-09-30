import crypto from 'crypto';

const ecdh = crypto.createECDH('prime256v1');
ecdh.generateKeys();

const publicKey = ecdh.getPublicKey('base64url');
const privateKey = ecdh.getPrivateKey('base64url');

console.log('--- Generated VAPID Keys ---');
console.log('PUBLIC_VAPID_KEY=' + publicKey);
console.log('VAPID_PRIVATE_KEY=' + privateKey);
console.log('VAPID_SUBJECT=mailto:admin@anymex.app');
